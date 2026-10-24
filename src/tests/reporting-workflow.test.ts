import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { AuditEvent, ComplianceScan, ContentDocument, EvaluationRun, Finding, Membership } from '../models/index.js';
import { clearDatabase, closeTestDatabase, setupTestDatabase, verifiedUser } from './helpers.js';

beforeAll(setupTestDatabase);
beforeEach(clearDatabase);
afterAll(closeTestDatabase);

const base = (fixture: any) => `/api/v1/organizations/${fixture.organization._id}`;
async function draft(fixture: any, body = 'Exportable copy') {
  const response = await request(app).post(`${base(fixture)}/content`).set(fixture.headers).send({ title: 'Report export', body });
  expect(response.status).toBe(201);
  return response.body.data;
}

async function scanFor(fixture: any, content: any, status = 'completed') {
  return ComplianceScan.create({
    organizationId: fixture.organization._id, contentId: content._id, revisionId: content.currentRevisionId,
    requestedBy: fixture.user._id, idempotencyKey: randomUUID(), requestHash: 'c'.repeat(64),
    correlationId: randomUUID(), status, attempts: status === 'queued' ? 0 : 1,
    ...(status === 'completed' ? { completedAt: new Date() } : {}),
  });
}

async function findingFor(fixture: any, content: any, scan: any, severity: string) {
  return Finding.create({
    organizationId: fixture.organization._id, contentId: content._id, revisionId: content.currentRevisionId,
    scanId: scan._id, externalId: randomUUID(), category: 'claims', severity,
    message: 'A recorded finding', suggestion: 'Verified', start: 0, end: 3,
    status: 'open', version: 0, evidence: [],
  });
}

describe('revision exports', () => {
  it('exports the current immutable revision and records a tenant-scoped audit event', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    const response = await request(app).get(`${base(fixture)}/content/${content._id}/export`).set(fixture.headers);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ contentId: content._id, status: 'draft', approved: false });
    expect(response.body.data.revision).toMatchObject({ _id: content.currentRevisionId, title: 'Report export', body: 'Exportable copy' });
    expect(response.body.data.decisions).toEqual([]);
    expect(await AuditEvent.countDocuments({ organizationId: fixture.organization._id, action: 'content.exported' })).toBe(1);
  });

  it('exports a requested historical revision rather than mutable current text', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture, 'Original export text');
    const update = await request(app).patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers)
      .send({ version: 0, body: 'Newer export text' });
    expect(update.status).toBe(200);
    const response = await request(app).get(`${base(fixture)}/content/${content._id}/export`).set(fixture.headers)
      .query({ revisionId: content.currentRevisionId });
    expect(response.status).toBe(200);
    expect(response.body.data.revision._id).toBe(content.currentRevisionId);
    expect(response.body.data.revision.body).toBe('Original export text');
    expect(response.body.data.approved).toBe(false);
  });

  it('includes the recorded human approval for an approved revision', async () => {
    const fixture = await verifiedUser();
    const reviewer = await verifiedUser('export-reviewer@example.com', 'Reviewer home');
    await Membership.create({ organizationId: fixture.organization._id, userId: reviewer.user._id, role: 'reviewer', status: 'active' });
    const content = await draft(fixture);
    const scan = await scanFor(fixture, content);
    await ContentDocument.updateOne({ _id: content._id, organizationId: fixture.organization._id }, {
      $set: { status: 'analyzed', latestScanId: scan._id }, $inc: { version: 1 },
    });
    const submission = await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: 1 });
    expect(submission.status).toBe(200);
    const approval = await request(app).post(`${base(fixture)}/content/${content._id}/review`).set(reviewer.headers)
      .send({ version: submission.body.data.content.version, decision: 'approved', comment: 'Human review completed' });
    expect(approval.status).toBe(200);
    const response = await request(app).get(`${base(fixture)}/content/${content._id}/export`).set(reviewer.headers);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('approved');
    expect(response.body.data.approved).toBe(true);
    expect(response.body.data.revision._id).toBe(content.currentRevisionId);
    expect(response.body.data.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'approved', comment: 'Human review completed', actorId: String(reviewer.user._id) }),
    ]));
  });

  it('rejects foreign revisions, foreign tenants, and creator exports without creating export audit events', async () => {
    const fixture = await verifiedUser('export-owner@example.com', 'Owner');
    const foreign = await verifiedUser('export-foreign@example.com', 'Foreign');
    const content = await draft(fixture);
    const unrelatedContent = await draft(fixture, 'A different content document');
    const foreignContent = await draft(foreign, 'Private foreign content');
    const foreignRevision = await request(app).get(`${base(fixture)}/content/${content._id}/export`).set(fixture.headers)
      .query({ revisionId: foreignContent.currentRevisionId });
    expect(foreignRevision.status).toBe(404);
    const unrelatedRevision = await request(app).get(`${base(fixture)}/content/${content._id}/export`).set(fixture.headers)
      .query({ revisionId: unrelatedContent.currentRevisionId });
    expect(unrelatedRevision.status).toBe(404);
    expect((await request(app).get(`${base(fixture)}/content/${foreignContent._id}/export`).set(fixture.headers)).status).toBe(404);
    expect((await request(app).get(`${base(foreign)}/content/${foreignContent._id}/export`).set(fixture.headers)).status).toBe(404);
    await Membership.updateOne({ organizationId: fixture.organization._id, userId: fixture.user._id }, { $set: { role: 'creator' } });
    expect((await request(app).get(`${base(fixture)}/content/${content._id}/export`).set(fixture.headers)).status).toBe(403);
    expect(await AuditEvent.countDocuments({ action: 'content.exported' })).toBe(0);
  });
});

describe('persisted evaluation runs', () => {
  it('aggregates only the selected completed scans and measured findings with no fabricated accuracy', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    const first = await scanFor(fixture, content);
    const second = await scanFor(fixture, content);
    const unselected = await scanFor(fixture, content);
    await findingFor(fixture, content, first, 'high');
    await findingFor(fixture, content, first, 'low');
    await findingFor(fixture, content, second, 'high');
    await findingFor(fixture, content, unselected, 'critical');
    const response = await request(app).post(`${base(fixture)}/evaluations`).set(fixture.headers)
      .send({ name: 'Recorded campaign evaluation', scanIds: [String(first._id), String(second._id)] });
    expect(response.status).toBe(201);
    expect(response.body.data.metrics).toMatchObject({ scanCount: 2, findingCount: 3 });
    expect(response.body.data.metrics.findingsBySeverity).toEqual(expect.arrayContaining([
      { severity: 'high', count: 2 }, { severity: 'low', count: 1 },
    ]));
    for (const inventedMetric of ['accuracy', 'precision', 'recall', 'f1', 'complianceScore']) {
      expect(response.body.data.metrics).not.toHaveProperty(inventedMetric);
    }
    const persisted = await EvaluationRun.findOne({ _id: response.body.data._id, organizationId: fixture.organization._id });
    expect(persisted?.metrics.findingCount).toBe(3);
    expect(await AuditEvent.countDocuments({ organizationId: fixture.organization._id, action: 'evaluation.completed' })).toBe(1);
  });

  it('rejects incomplete, foreign, missing, and duplicate scan selections atomically', async () => {
    const fixture = await verifiedUser('evaluation-owner@example.com', 'Owner');
    const foreign = await verifiedUser('evaluation-foreign@example.com', 'Foreign');
    const content = await draft(fixture);
    const foreignContent = await draft(foreign);
    const completed = await scanFor(fixture, content);
    const queued = await scanFor(fixture, content, 'queued');
    const foreignScan = await scanFor(foreign, foreignContent);
    const selections = [[String(queued._id)], [String(foreignScan._id)], ['0123456789abcdef01234567'], [String(completed._id), String(completed._id)]];
    for (const scanIds of selections) {
      const response = await request(app).post(`${base(fixture)}/evaluations`).set(fixture.headers).send({ name: 'Invalid evaluation', scanIds });
      expect(response.status).toBe(400);
    }
    expect(await EvaluationRun.countDocuments({ organizationId: fixture.organization._id })).toBe(0);
    expect(await AuditEvent.countDocuments({ organizationId: fixture.organization._id, action: 'evaluation.completed' })).toBe(0);
  });

  it('paginates evaluations within the current organization and hides foreign organization access', async () => {
    const fixture = await verifiedUser('list-owner@example.com', 'Owner');
    const foreign = await verifiedUser('list-foreign@example.com', 'Foreign');
    const content = await draft(fixture);
    const foreignContent = await draft(foreign);
    const scan = await scanFor(fixture, content);
    const foreignScan = await scanFor(foreign, foreignContent);
    for (const name of ['First measured run', 'Second measured run']) {
      const created = await request(app).post(`${base(fixture)}/evaluations`).set(fixture.headers).send({ name, scanIds: [String(scan._id)] });
      expect(created.status).toBe(201);
    }
    const foreignRun = await request(app).post(`${base(foreign)}/evaluations`).set(foreign.headers)
      .send({ name: 'Foreign measured run', scanIds: [String(foreignScan._id)] });
    expect(foreignRun.status).toBe(201);
    const response = await request(app).get(`${base(fixture)}/evaluations`).set(fixture.headers).query({ page: 1, limit: 1 });
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(response.body.data[0].organizationId).toBe(String(fixture.organization._id));
    expect(response.body.data[0]._id).not.toBe(foreignRun.body.data._id);
    expect((await request(app).get(`${base(foreign)}/evaluations`).set(fixture.headers)).status).toBe(404);
  });
});
