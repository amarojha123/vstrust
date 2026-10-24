import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../app.js';
import { ApprovalDecision, AuditEvent, ComplianceScan, ContentDocument, ContentRevision, Membership, Review } from '../models/index.js';
import { clearDatabase, closeTestDatabase, setupTestDatabase, verifiedUser } from './helpers.js';

beforeAll(setupTestDatabase);
beforeEach(clearDatabase);
afterAll(closeTestDatabase);

const base = (fixture: any) => `/api/v1/organizations/${fixture.organization._id}`;
async function draft(fixture: any, body = 'Original content') {
  const response = await request(app).post(`${base(fixture)}/content`).set(fixture.headers).send({ title: 'Campaign', body });
  expect(response.status).toBe(201);
  return response.body.data;
}
async function analyzed(fixture: any, content: any) {
  const scan = await ComplianceScan.create({
    organizationId: fixture.organization._id, contentId: content._id, revisionId: content.currentRevisionId,
    requestedBy: fixture.user._id, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64),
    correlationId: randomUUID(), status: 'completed', attempts: 1, completedAt: new Date(),
  });
  return ContentDocument.findOneAndUpdate({ _id: content._id, organizationId: fixture.organization._id },
    { $set: { status: content.status === 'changes_requested' ? 'changes_requested' : 'analyzed', latestScanId: scan._id }, $inc: { version: 1 } }, { new: true });
}
async function reviewerFor(fixture: any) {
  const reviewer = await verifiedUser('reviewer@example.com', 'Reviewer home');
  await Membership.create({ organizationId: fixture.organization._id, userId: reviewer.user._id, role: 'reviewer', status: 'active' });
  return reviewer;
}

describe('content snapshots and tenant authorization', () => {
  it('creates a draft and immutable first revision with an audit event', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    expect(content).toMatchObject({ status: 'draft', version: 0, revisionNumber: 1 });
    const revision = await ContentRevision.findById(content.currentRevisionId);
    expect(revision?.body).toBe('Original content');
    expect(revision?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await AuditEvent.countDocuments({ organizationId: fixture.organization._id, action: 'content.created' })).toBe(1);
  });

  it('autosaves an immutable revision and compares historical revisions', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    const saved = await request(app).put(`${base(fixture)}/content/${content._id}/autosave`).set(fixture.headers).send({ version: 0, body: 'Revised content' });
    expect(saved.status).toBe(200);
    expect(saved.body.data.version).toBe(1);
    expect(saved.body.data.revisionNumber).toBe(2);
    expect((await ContentRevision.findById(content.currentRevisionId))?.body).toBe('Original content');
    const comparison = await request(app).get(`${base(fixture)}/content/${content._id}/revisions/compare`).set(fixture.headers)
      .query({ from: content.currentRevisionId, to: saved.body.data.currentRevisionId });
    expect(comparison.status).toBe(200);
    expect(comparison.body.data.from.body).toBe('Original content');
    expect(comparison.body.data.to.body).toBe('Revised content');
    const history = await request(app).get(`${base(fixture)}/content/${content._id}/revisions`).set(fixture.headers).query({ page: 1, limit: 1 });
    expect(history.body.data).toHaveLength(1);
    expect(history.body.pagination.total).toBe(2);
  });

  it('allows only one concurrent save at the same version', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    const responses = await Promise.all(['First writer', 'Second writer'].map(body => request(app)
      .patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers).send({ version: 0, body })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await ContentRevision.countDocuments({ organizationId: fixture.organization._id, contentId: content._id })).toBe(2);
    expect((await ContentDocument.findById(content._id))?.version).toBe(1);
  });

  it('prevents cross-organization reads, writes, and revision comparisons', async () => {
    const first = await verifiedUser('first@example.com', 'First');
    const second = await verifiedUser('second@example.com', 'Second');
    const content = await draft(first);
    expect((await request(app).get(`${base(second)}/content/${content._id}`).set(second.headers)).status).toBe(404);
    expect((await request(app).patch(`${base(second)}/content/${content._id}`).set(second.headers).send({ version: 0, body: 'Stolen' })).status).toBe(404);
    expect((await request(app).get(`${base(second)}/content/${content._id}/revisions`).set(second.headers)).status).toBe(404);
    const comparison = await request(app).get(`${base(second)}/content/${content._id}/revisions/compare`).set(second.headers)
      .query({ from: content.currentRevisionId, to: content.currentRevisionId });
    expect(comparison.status).toBe(404);
    expect((await request(app).get(`${base(first)}/content/${content._id}`).set(second.headers)).status).toBe(404);
  });

  it('rejects invalid IDs, unknown fields, missing versions, and NoSQL operators', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    expect((await request(app).get(`${base(fixture)}/content/not-an-id`).set(fixture.headers)).status).toBe(400);
    expect((await request(app).post(`${base(fixture)}/content`).set(fixture.headers).send({ title: 'X', body: 'Y', status: 'approved' })).status).toBe(400);
    expect((await request(app).patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers).send({ body: 'New' })).status).toBe(400);
    expect((await request(app).patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers).send({ version: 0, body: { $ne: '' } })).status).toBe(400);
  });

  it('denies creator review decisions and auditor content mutations', async () => {
    const fixture = await verifiedUser();
    const content = await draft(fixture);
    await Membership.updateOne({ organizationId: fixture.organization._id, userId: fixture.user._id }, { $set: { role: 'creator' } });
    const decision = await request(app).post(`${base(fixture)}/content/${content._id}/review`).set(fixture.headers)
      .send({ version: 0, decision: 'approved', comment: 'Attempt' });
    expect(decision.status).toBe(403);
    await Membership.updateOne({ organizationId: fixture.organization._id, userId: fixture.user._id }, { $set: { role: 'auditor' } });
    expect((await request(app).patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers).send({ version: 0, body: 'Attempt' })).status).toBe(403);
    expect((await request(app).get(`${base(fixture)}/content/${content._id}`).set(fixture.headers)).status).toBe(200);
  });
});

describe('server-enforced approval workflow', () => {
  it('requires current completed analysis and never approves during submission', async () => {
    const fixture = await verifiedUser();
    let content = await draft(fixture);
    expect((await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: 0 })).status).toBe(409);
    content = await analyzed(fixture, content);
    const submitted = await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: content.version });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.content.status).toBe('in_review');
    expect(await ApprovalDecision.countDocuments({ contentId: content._id })).toBe(0);
    expect((await request(app).patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers).send({ version: submitted.body.data.content.version, body: 'Editing in review' })).status).toBe(409);
  });

  it('blocks self approval, supports changes and resubmission, and freezes an approved revision', async () => {
    const fixture = await verifiedUser();
    const reviewer = await reviewerFor(fixture);
    let content: any = await analyzed(fixture, await draft(fixture));
    let response = await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: content.version });
    content = response.body.data.content;
    const self = await request(app).post(`${base(fixture)}/content/${content._id}/review`).set(fixture.headers)
      .send({ version: content.version, decision: 'approved', comment: 'Own approval' });
    expect(self.status).toBe(403);
    response = await request(app).post(`${base(fixture)}/content/${content._id}/review`).set(reviewer.headers)
      .send({ version: content.version, decision: 'changes_requested', comment: 'Please correct the copy' });
    expect(response.status).toBe(200);
    content = response.body.data.content;
    expect(content.status).toBe('changes_requested');
    response = await request(app).patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers).send({ version: content.version, body: 'Corrected copy' });
    expect(response.status).toBe(200);
    content = response.body.data;
    expect((await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: content.version })).status).toBe(409);
    content = await analyzed(fixture, content);
    response = await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: content.version });
    expect(response.body.data.content.status).toBe('resubmitted');
    content = response.body.data.content;
    response = await request(app).post(`${base(fixture)}/content/${content._id}/review`).set(reviewer.headers)
      .send({ version: content.version, decision: 'approved', comment: 'Corrections verified' });
    expect(response.status).toBe(200);
    content = response.body.data.content;
    expect(content.status).toBe('approved');
    expect(content.approvedRevisionId).toBe(content.currentRevisionId);
    expect((await request(app).patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers).send({ version: content.version, body: 'Mutate approval' })).status).toBe(409);
    expect((await ContentRevision.findById(content.approvedRevisionId))?.body).toBe('Corrected copy');
    expect(await ApprovalDecision.countDocuments({ organizationId: fixture.organization._id, contentId: content._id })).toBe(2);
    expect(await Review.countDocuments({ organizationId: fixture.organization._id, contentId: content._id })).toBe(2);
  });

  it('does not allow a submitter to approve someone else\'s draft', async () => {
    const fixture = await verifiedUser();
    const second = await verifiedUser('second-admin@example.com', 'Second admin');
    await Membership.create({ organizationId: fixture.organization._id, userId: second.user._id, role: 'admin', status: 'active' });
    const content: any = await analyzed(fixture, await draft(fixture));
    const submit = await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(second.headers).send({ version: content.version });
    expect(submit.status).toBe(200);
    const approval = await request(app).post(`${base(fixture)}/content/${content._id}/review`).set(second.headers)
      .send({ version: submit.body.data.content.version, decision: 'approved', comment: 'Attempt submitter approval' });
    expect(approval.status).toBe(403);
  });

  it('records rejection and prevents terminal content from reopening', async () => {
    const fixture = await verifiedUser();
    const reviewer = await reviewerFor(fixture);
    let content: any = await analyzed(fixture, await draft(fixture));
    const submit = await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: content.version });
    content = submit.body.data.content;
    const decision = await request(app).post(`${base(fixture)}/content/${content._id}/review`).set(reviewer.headers)
      .send({ version: content.version, decision: 'rejected', comment: 'Unsupported claim' });
    expect(decision.status).toBe(200);
    content = decision.body.data.content;
    expect(content.status).toBe('rejected');
    expect((await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: content.version })).status).toBe(409);
    expect((await request(app).patch(`${base(fixture)}/content/${content._id}`).set(fixture.headers).send({ version: content.version, body: 'Reopen' })).status).toBe(409);
  });

  it('requires approval independent of the current revision editor as well as the draft creator and submitter', async () => {
    const fixture = await verifiedUser();
    const editor = await verifiedUser('editor-admin@example.com', 'Editor home');
    await Membership.create({ organizationId: fixture.organization._id, userId: editor.user._id, role: 'admin', status: 'active' });
    let content: any = await draft(fixture);
    const edit = await request(app).patch(`${base(fixture)}/content/${content._id}`).set(editor.headers)
      .send({ version: content.version, body: 'Revision authored by a different admin' });
    expect(edit.status).toBe(200);
    content = await analyzed(fixture, edit.body.data);
    const submit = await request(app).post(`${base(fixture)}/content/${content._id}/submit`).set(fixture.headers).send({ version: content.version });
    expect(submit.status).toBe(200);
    const approve = await request(app).post(`${base(fixture)}/content/${content._id}/review`).set(editor.headers)
      .send({ version: submit.body.data.content.version, decision: 'approved', comment: 'Attempt approval of my edit' });
    expect(approve.status).toBe(403);
    expect(await ApprovalDecision.countDocuments({ contentId: content._id })).toBe(0);
  });
});
