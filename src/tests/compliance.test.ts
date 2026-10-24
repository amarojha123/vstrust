import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../app.js';
import { AuditEvent, ComplianceScan, ContentDocument, ContentRevision, Finding, FindingDecision, Job } from '../models/index.js';
import { clearDatabase, closeTestDatabase, setupTestDatabase, verifiedUser } from './helpers.js';

beforeAll(setupTestDatabase);
beforeEach(clearDatabase);
afterAll(closeTestDatabase);
const base = (fixture: any) => `/api/v1/organizations/${fixture.organization._id}`;
async function draft(fixture: any, body = 'Bad claim in copy') {
  const response = await request(app).post(`${base(fixture)}/content`).set(fixture.headers).send({ title: 'Campaign', body });
  expect(response.status).toBe(201);
  return response.body.data;
}
async function completedFinding(fixture: any) {
  const initial = await draft(fixture);
  const scan = await ComplianceScan.create({
    organizationId: fixture.organization._id, contentId: initial._id, revisionId: initial.currentRevisionId,
    requestedBy: fixture.user._id, idempotencyKey: randomUUID(), requestHash: 'b'.repeat(64),
    correlationId: randomUUID(), status: 'completed', attempts: 1, completedAt: new Date(),
  });
  const content = await ContentDocument.findOneAndUpdate({ _id: initial._id, organizationId: fixture.organization._id },
    { $set: { status: 'analyzed', latestScanId: scan._id }, $inc: { version: 1 } }, { new: true });
  const finding = await Finding.create({
    organizationId: fixture.organization._id, contentId: initial._id, revisionId: initial.currentRevisionId,
    scanId: scan._id, externalId: randomUUID(), category: 'unsupported_claim', severity: 'high',
    message: 'This statement requires correction', suggestion: 'Verified', start: 0, end: 3,
    evidence: [], status: 'open', version: 0,
  });
  return { content: content!, initial, scan, finding };
}

describe('compliance scan requests', () => {
  it('persists a queued scan, its job, audit event, and replays the same idempotency key', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    const key = randomUUID();
    const first = await request(app).post(`${base(fixture)}/content/${content._id}/scans`).set(fixture.headers)
      .set('Idempotency-Key', key).send({ version: 0 });
    expect(first.status).toBe(202);
    expect(first.body.data.status).toBe('queued');
    expect(first.body.data).not.toHaveProperty('knowledgeSnapshot');
    const replay = await request(app).post(`${base(fixture)}/content/${content._id}/scans`).set(fixture.headers)
      .set('Idempotency-Key', key).send({ version: 0 });
    expect(replay.status).toBe(202);
    expect(replay.body.data._id).toBe(first.body.data._id);
    expect(await ComplianceScan.countDocuments({ organizationId: fixture.organization._id })).toBe(1);
    expect(await Job.countDocuments({ organizationId: fixture.organization._id, kind: 'scan' })).toBe(1);
    expect(await AuditEvent.countDocuments({ organizationId: fixture.organization._id, action: 'compliance.scan_requested' })).toBe(1);
    const current = await ContentDocument.findById(content._id);
    expect(current?.status).toBe('draft');
    expect(String(current?.latestScanId)).toBe(first.body.data._id);
  });

  it('rejects key reuse for a different request and invalid or stale scan requests', async () => {
    const fixture = await verifiedUser();
    const first = await draft(fixture);
    const second = await draft(fixture, 'Second content');
    const key = randomUUID();
    expect((await request(app).post(`${base(fixture)}/content/${first._id}/scans`).set(fixture.headers).set('Idempotency-Key', key).send({ version: 0 })).status).toBe(202);
    expect((await request(app).post(`${base(fixture)}/content/${second._id}/scans`).set(fixture.headers).set('Idempotency-Key', key).send({ version: 0 })).status).toBe(409);
    expect((await request(app).post(`${base(fixture)}/content/${second._id}/scans`).set(fixture.headers).send({ version: 0 })).status).toBe(400);
    expect((await request(app).post(`${base(fixture)}/content/${second._id}/scans`).set(fixture.headers).set('Idempotency-Key', 'short').send({ version: 0 })).status).toBe(400);
    expect((await request(app).post(`${base(fixture)}/content/${second._id}/scans`).set(fixture.headers).set('Idempotency-Key', randomUUID()).send({ version: 9 })).status).toBe(409);
  });

  it('scopes scan status and finding evidence to the organization', async () => {
    const fixture = await verifiedUser('first@example.com', 'First');
    const foreign = await verifiedUser('foreign@example.com', 'Foreign');
    const { content, scan, finding } = await completedFinding(fixture);
    expect((await request(app).get(`${base(fixture)}/scans/${scan._id}`).set(fixture.headers)).status).toBe(200);
    expect((await request(app).get(`${base(foreign)}/scans/${scan._id}`).set(foreign.headers)).status).toBe(404);
    expect((await request(app).get(`${base(foreign)}/scans/${scan._id}/findings`).set(foreign.headers)).status).toBe(404);
    expect((await request(app).get(`${base(foreign)}/findings/${finding._id}/evidence`).set(foreign.headers)).status).toBe(404);
    expect((await request(app).post(`${base(foreign)}/findings/${finding._id}/decisions`).set(foreign.headers)
      .send({ version: content.version, findingVersion: 0, decision: 'rejected', reason: 'Foreign decision' })).status).toBe(404);
    const findings = await request(app).get(`${base(fixture)}/scans/${scan._id}/findings`).set(fixture.headers).query({ severity: 'high', limit: 1 });
    expect(findings.body.data).toHaveLength(1);
    expect(findings.body.pagination.total).toBe(1);
  });

  it('does not scan terminal or in-review content', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    for (const status of ['in_review', 'resubmitted', 'approved', 'rejected']) {
      await ContentDocument.updateOne({ _id: content._id }, { $set: { status } });
      expect((await request(app).post(`${base(fixture)}/content/${content._id}/scans`).set(fixture.headers)
        .set('Idempotency-Key', randomUUID()).send({ version: 0 })).status).toBe(409);
    }
  });
});

describe('finding decisions', () => {
  it('accepts a suggestion in a new immutable revision and replays without applying it twice', async () => {
    const fixture = await verifiedUser();
    const { content, finding, initial } = await completedFinding(fixture);
    const input = { version: content.version, findingVersion: 0, decision: 'accepted', reason: 'Use verified wording' };
    const accepted = await request(app).post(`${base(fixture)}/findings/${finding._id}/decisions`).set(fixture.headers).send(input);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.content.body).toBe('Verified claim in copy');
    expect(accepted.body.data.content.status).toBe('draft');
    expect(accepted.body.data.finding.status).toBe('accepted');
    expect((await ContentRevision.findById(initial.currentRevisionId))?.body).toBe('Bad claim in copy');
    const replay = await request(app).post(`${base(fixture)}/findings/${finding._id}/decisions`).set(fixture.headers).send(input);
    expect(replay.status).toBe(200);
    expect(replay.body.data.decision._id).toBe(accepted.body.data.decision._id);
    expect(await FindingDecision.countDocuments({ findingId: finding._id })).toBe(1);
    expect(await ContentRevision.countDocuments({ contentId: content._id })).toBe(2);
    expect(await AuditEvent.countDocuments({ organizationId: fixture.organization._id, action: 'finding.decided' })).toBe(1);
  });

  it('applies an edited suggestion and rejects incomplete edit requests', async () => {
    const fixture = await verifiedUser();
    const { content, finding } = await completedFinding(fixture);
    const input = { version: content.version, findingVersion: 0, decision: 'edited', reason: 'Custom wording' };
    expect((await request(app).post(`${base(fixture)}/findings/${finding._id}/decisions`).set(fixture.headers).send(input)).status).toBe(400);
    const edited = await request(app).post(`${base(fixture)}/findings/${finding._id}/decisions`).set(fixture.headers).send({ ...input, replacement: 'Supported' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.content.body).toBe('Supported claim in copy');
    expect(edited.body.data.decision.replacement).toBe('Supported');
  });

  it('rejects a finding without changing revision text and records the reason', async () => {
    const fixture = await verifiedUser();
    const { content, finding } = await completedFinding(fixture);
    const rejected = await request(app).post(`${base(fixture)}/findings/${finding._id}/decisions`).set(fixture.headers)
      .send({ version: content.version, findingVersion: 0, decision: 'rejected', reason: 'Claim was independently verified' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.content.body).toBe('Bad claim in copy');
    expect(rejected.body.data.content.currentRevisionId).toBe(String(content.currentRevisionId));
    expect(rejected.body.data.finding.status).toBe('rejected');
    expect(rejected.body.data.decision.reason).toBe('Claim was independently verified');
    expect(await ContentRevision.countDocuments({ contentId: content._id })).toBe(1);
  });

  it('refuses suggestions for stale revisions and unfinished scans', async () => {
    const fixture = await verifiedUser();
    const first = await completedFinding(fixture);
    const updated = await request(app).patch(`${base(fixture)}/content/${first.content._id}`).set(fixture.headers)
      .send({ version: first.content.version, body: 'Entirely new copy' });
    const stale = await request(app).post(`${base(fixture)}/findings/${first.finding._id}/decisions`).set(fixture.headers)
      .send({ version: updated.body.data.version, findingVersion: 0, decision: 'accepted', reason: 'Attempt stale suggestion' });
    expect(stale.status).toBe(409);
    const second = await completedFinding(fixture);
    await ComplianceScan.updateOne({ _id: second.scan._id }, { $set: { status: 'running' } });
    const running = await request(app).post(`${base(fixture)}/findings/${second.finding._id}/decisions`).set(fixture.headers)
      .send({ version: second.content.version, findingVersion: 0, decision: 'accepted', reason: 'Attempt unfinished analysis' });
    expect(running.status).toBe(409);
    expect(await FindingDecision.countDocuments({ organizationId: fixture.organization._id })).toBe(0);
  });

  it('commits only one of two concurrent decisions', async () => {
    const fixture = await verifiedUser();
    const { content, finding } = await completedFinding(fixture);
    const responses = await Promise.all(['accepted', 'rejected'].map(decision => request(app)
      .post(`${base(fixture)}/findings/${finding._id}/decisions`).set(fixture.headers)
      .send({ version: content.version, findingVersion: 0, decision, reason: 'Concurrent decision' })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await FindingDecision.countDocuments({ findingId: finding._id })).toBe(1);
  });

  it('validates replacement ranges and versions before changing content', async () => {
    const fixture = await verifiedUser();
    const { content, finding } = await completedFinding(fixture);
    expect((await request(app).post(`${base(fixture)}/findings/${finding._id}/decisions`).set(fixture.headers)
      .send({ version: content.version, findingVersion: 9, decision: 'accepted', reason: 'Stale version' })).status).toBe(409);
    await Finding.updateOne({ _id: finding._id }, { $set: { end: 999999 } });
    expect((await request(app).post(`${base(fixture)}/findings/${finding._id}/decisions`).set(fixture.headers)
      .send({ version: content.version, findingVersion: 0, decision: 'accepted', reason: 'Invalid range' })).status).toBe(422);
    expect(await FindingDecision.countDocuments({ findingId: finding._id })).toBe(0);
    expect((await ContentDocument.findById(content._id))?.body).toBe('Bad claim in copy');
  });
});
