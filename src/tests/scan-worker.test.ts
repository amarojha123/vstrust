import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { ApprovalDecision, ComplianceScan, ContentDocument, Finding, Guideline, Job } from '../models';
import { env } from '../config/env';
import { processScanJob } from '../jobs/handlers';
import { deferJob, failJob } from '../jobs/queue';
import { AIServiceClient } from '../integrations/ai/client';
import { clearDatabase, closeTestDatabase, setupTestDatabase, verifiedUser } from './helpers';

beforeAll(setupTestDatabase);
beforeEach(clearDatabase);
afterAll(closeTestDatabase);
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
async function leaseJob(organizationId: unknown) {
  return Job.findOneAndUpdate({ organizationId, kind: 'scan', status: 'pending' }, { $set: { status: 'running', lockedBy: 'scan-worker-test', leaseUntil: new Date(Date.now() + env.JOB_LEASE_MS) }, $inc: { attempts: 1 } }, { new: true }).select('+payload');
}
async function fixture() {
  const account = await verifiedUser();
  const base = `/api/v1/organizations/${String(account.organization._id)}`;
  const rule = await request(app).post(`${base}/guidelines`).set(account.headers).send({ title: 'Voice', description: 'Use a calm tone', category: 'tone', severity: 'medium' });
  expect(rule.status).toBe(201);
  expect((await request(app).post(`${base}/guidelines/${rule.body.data._id}/publish`).set(account.headers).send({ version: 0 })).status).toBe(200);
  const content = await request(app).post(`${base}/content`).set(account.headers).send({ title: 'Campaign', body: 'Too loud' });
  expect(content.status).toBe(201);
  const scan = await request(app).post(`${base}/content/${content.body.data._id}/scans`).set(account.headers).set('Idempotency-Key', 'scan-worker-key-0001').send({ version: content.body.data.version });
  expect(scan.status).toBe(202);
  const job: any = await leaseJob(account.organization._id);
  expect(job).toBeTruthy();
  return { account, base, content: content.body.data, scan: scan.body.data, job, rule: rule.body.data };
}
function provider(transport: typeof fetch) { return new AIServiceClient({ baseUrl: 'http://mock-ai.internal', token: 'mock-token', timeoutMs: 1000, maxRetries: 0, fetch: transport }); }
function findings(ruleId: string) {
  return { findings: [{ id: 'finding-1', category: 'tone', severity: 'medium', message: 'Use a calmer opening', suggestion: 'Calm', start: 0, end: 3, ruleId, ruleType: 'guideline', evidence: [{ sourceId: ruleId, quote: 'calm tone' }] }] };
}

describe('durable compliance scan processing with deterministic AI', () => {
  it('uses the initiation snapshot, persists findings once, and never approves content', async () => {
    const f = await fixture();
    // Live knowledge changes after scan initiation must not rewrite the scan evidence.
    await Guideline.updateOne({ _id: f.rule._id }, { $set: { description: 'A completely new policy', status: 'archived' } });
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'remote-scan-1', status: 'completed' })).mockResolvedValueOnce(json(findings(f.rule._id)));
    const client = provider(transport);
    await processScanJob(f.job, client);
    const submitted = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
    expect(submitted.knowledge.guidelines[0].description).toBe('Use a calm tone');
    expect(submitted.organizationId).toBe(String(f.account.organization._id));
    expect(await Finding.countDocuments({ organizationId: f.account.organization._id, scanId: f.scan._id })).toBe(1);
    const content: any = await ContentDocument.findById(f.content._id).lean();
    expect(content.status).toBe('analyzed');
    expect(content.version).toBe(1);
    expect(await ApprovalDecision.countDocuments()).toBe(0);
    await processScanJob(f.job, client);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await Finding.countDocuments()).toBe(1);
  });

  it('keeps stale scan results attached to their immutable revision without analyzing newer content', async () => {
    const f = await fixture();
    const updated = await request(app).patch(`${f.base}/content/${f.content._id}`).set(f.account.headers).send({ version: 0, body: 'A new unscanned draft' });
    expect(updated.status).toBe(200);
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'remote-old', status: 'completed' })).mockResolvedValueOnce(json(findings(f.rule._id)));
    await processScanJob(f.job, provider(transport));
    const content: any = await ContentDocument.findById(f.content._id).lean();
    expect(content.status).toBe('draft');
    expect(content.body).toBe('A new unscanned draft');
    expect(String(content.currentRevisionId)).toBe(updated.body.data.currentRevisionId);
    const finding: any = await Finding.findOne({ scanId: f.scan._id }).lean();
    expect(String(finding.revisionId)).toBe(f.scan.revisionId);
    expect(String(finding.revisionId)).not.toBe(String(content.currentRevisionId));
  });

  it('rejects cross-tenant evidence without persisting any partial findings', async () => {
    const f = await fixture();
    const other = await verifiedUser('other@scan-worker.test', 'Other company');
    const [foreignRule] = await Guideline.create([{ organizationId: other.organization._id, createdBy: other.user._id, title: 'Foreign rule', description: 'calm tone', category: 'tone', severity: 'medium', status: 'published' }]);
    const result = findings(f.rule._id);
    result.findings.push({ ...result.findings[0]!, id: 'foreign-finding', evidence: [{ sourceId: String(foreignRule!._id), quote: 'calm tone' }] });
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'remote-foreign', status: 'completed' })).mockResolvedValueOnce(json(result));
    await expect(processScanJob(f.job, provider(transport))).rejects.toMatchObject({ code: 'AI_UNTRUSTED_RESULT', retryable: false });
    expect(await Finding.countDocuments()).toBe(0);
    await failJob(String(f.job._id), f.job.lockedBy, 'AI_UNTRUSTED_RESULT', true);
    const scan: any = await ComplianceScan.findById(f.scan._id).lean();
    expect(scan.status).toBe('failed');
    expect(scan.errorCode).toBe('AI_UNTRUSTED_RESULT');
  });

  it('polls a pending remote scan durably without creating another provider scan', async () => {
    const f = await fixture();
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'remote-pending', status: 'queued' })).mockResolvedValueOnce(json({ id: 'remote-pending', status: 'completed' })).mockResolvedValueOnce(json(findings(f.rule._id)));
    const client = provider(transport);
    await expect(processScanJob(f.job, client)).rejects.toMatchObject({ code: 'AI_SCAN_PENDING' });
    const started: any = await ComplianceScan.findById(f.scan._id).lean();
    expect(started.externalId).toBe('remote-pending');
    await deferJob(String(f.job._id), f.job.lockedBy, 0);
    const nextJob: any = await leaseJob(f.account.organization._id);
    await processScanJob(nextJob, client);
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(3);
    expect((await ComplianceScan.findById(f.scan._id))?.get('status')).toBe('completed');
  });

  it('fences a worker after its job lease is taken by another worker', async () => {
    const f = await fixture();
    await Job.updateOne({ _id: f.job._id }, { $set: { lockedBy: 'new-owner' } });
    const transport = vi.fn<typeof fetch>();
    await expect(processScanJob(f.job, provider(transport))).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });
    expect(transport).not.toHaveBeenCalled();
    expect(await Finding.countDocuments()).toBe(0);
  });
});
