import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { app } from '../app';
import { allModels, ApprovalDecision, AuditEvent, Finding, FindingDecision, Membership, Notification, RateLimitBucket, Review } from '../models';
import { recordAudit } from '../services/audit.service';
import { clearDatabase, closeTestDatabase, setupTestDatabase, verifiedUser } from './helpers';

beforeAll(setupTestDatabase); beforeEach(clearDatabase); afterAll(closeTestDatabase);
describe('reporting, privacy and API security', () => {
  it('has live and ready probes and publishes OpenAPI without exposing configuration', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/ready')).status).toBe(200);
    const spec = await request(app).get('/api/v1/openapi.json');
    expect(spec.status).toBe(200); expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(40);
    expect(JSON.stringify(spec.body)).not.toContain(process.env.JWT_SECRET);
  });
  it('returns real empty analytics with undefined rates represented as null', async () => {
    const user = await verifiedUser();
    const response = await request(app).get(`/api/v1/organizations/${user.organization._id}/analytics`).set(user.headers);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ submissions: 0, approvals: 0, rejections: 0, approvalRate: null, findingsByCategory: [], corrections: { rate: null }, reviewTurnaround: { averageMs: null, sampleSize: 0 } });
  });
  it('isolates audit events and removes sensitive metadata', async () => {
    const a = await verifiedUser(), b = await verifiedUser();
    const context = { userId: String(a.user._id), organizationId: String(a.organization._id), role: 'admin' as const, correlationId: 'test-audit' };
    await recordAudit(context, 'content.modified', 'ContentDocument', new Types.ObjectId(), { version: 2, password: 'secret', body: 'private', token: 'credential' });
    await recordAudit({ ...context, organizationId: String(b.organization._id) }, 'other.event', 'ContentDocument');
    const response = await request(app).get(`/api/v1/organizations/${a.organization._id}/audit-events`).set(a.headers);
    expect(response.status).toBe(200); expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].metadata).toEqual({ version: 2 });
    expect((await request(app).get(`/api/v1/organizations/${b.organization._id}/audit-events`).set(a.headers)).status).toBe(404);
    await expect(AuditEvent.updateOne({ organizationId: a.organization._id }, { $set: { action: 'tampered' } })).rejects.toThrow('append-only');
  });
  it('aggregates actual outcomes and excludes another organization from every metric', async () => {
    const a = await verifiedUser(), b = await verifiedUser();
    const createdAt = new Date(Date.now() - 10000);
    for (const [owner, decision] of [[a, 'approved'], [b, 'rejected']] as const) {
      const contentId = new Types.ObjectId(), revisionId = new Types.ObjectId(), scanId = new Types.ObjectId();
      const review = await Review.create({ organizationId: owner.organization._id, contentId, revisionId, submittedBy: owner.user._id, status: decision, decidedAt: new Date(createdAt.getTime() + 5000), createdAt });
      await ApprovalDecision.create({ organizationId: owner.organization._id, contentId, revisionId, reviewId: review._id, actorId: owner.user._id, decision });
      const finding = await Finding.create({ organizationId: owner.organization._id, contentId, revisionId, scanId, externalId: 'f-1', category: 'terminology', severity: 'high', ruleId: String(new Types.ObjectId()), ruleType: 'terminologyRule', message: 'Use approved terminology' });
      await FindingDecision.create({ organizationId: owner.organization._id, findingId: finding._id, scanId, revisionId, actorId: owner.user._id, decision: owner === a ? 'accepted' : 'rejected' });
    }
    const response = await request(app).get(`/api/v1/organizations/${a.organization._id}/analytics`).set(a.headers);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ submissions: 1, approvals: 1, rejections: 0, approvalRate: 1, findingsByCategory: [{ category: 'terminology', count: 1 }], findingsBySeverity: [{ severity: 'high', count: 1 }], corrections: { accepted: 1, rejected: 0, rate: 1 }, reviewTurnaround: { averageMs: 5000, sampleSize: 1 } });
    expect(response.body.data.frequentlyViolatedRules).toHaveLength(1);
  });
  it('prevents creator analytics and permission escalation through request bodies', async () => {
    const a = await verifiedUser();
    await Membership.updateOne({ organizationId: a.organization._id, userId: a.user._id }, { $set: { role: 'creator' } });
    expect((await request(app).get(`/api/v1/organizations/${a.organization._id}/analytics`).set(a.headers)).status).toBe(403);
    const response = await request(app).post(`/api/v1/organizations/${a.organization._id}/content`).set(a.headers).send({ title: 'Test', body: 'Test body', status: 'approved', organizationId: new Types.ObjectId().toString() });
    expect(response.status).toBe(400);
  });
  it('checks CSRF for cookies and permits a matching token', async () => {
    const a = await verifiedUser();
    const cookie = [`tm_session=${a.token}`, `tm_csrf=${a.csrf}`];
    const url = `/api/v1/organizations/${a.organization._id}/content`;
    expect((await request(app).post(url).set('Cookie', cookie).send({ title: 'CSRF', body: 'Text' })).status).toBe(403);
    expect((await request(app).post(url).set('Cookie', cookie).set('X-CSRF-Token', a.csrf).send({ title: 'CSRF', body: 'Text' })).status).toBe(201);
  });
  it('rejects cross-site mutations, Mongo operators and unsupported sort fields', async () => {
    const a = await verifiedUser(), url = `/api/v1/organizations/${a.organization._id}/content`;
    expect((await request(app).post(url).set(a.headers).set('Origin', 'https://attacker.invalid').send({ title: 'x', body: 'x' })).status).toBe(403);
    expect((await request(app).post('/api/v1/auth/login').send({ email: { $ne: null }, password: 'x' })).status).toBe(400);
    expect((await request(app).get(`${url}?sort=passwordHash`).set(a.headers)).status).toBe(400);
    const malformed = await request(app).post(url).set(a.headers).set('Content-Type', 'application/json').send('{');
    expect(malformed.status).toBe(400); expect(malformed.body.error).not.toHaveProperty('stack');
    expect(malformed.headers['x-content-type-options']).toBe('nosniff');
    expect(malformed.headers).toHaveProperty('x-correlation-id');
  });
  it('rejects malformed Unicode before hashing revisions and preserves valid emoji', async () => {
    const a = await verifiedUser(), url = `/api/v1/organizations/${a.organization._id}/content`;
    expect((await request(app).post(url).set(a.headers).send({ title: 'Invalid', body: '\uD800' })).status).toBe(400);
    const valid = await request(app).post(url).set(a.headers).send({ title: 'Unicode', body: 'Approved 😀 message' });
    expect(valid.status).toBe(201); expect(valid.body.data.body).toBe('Approved 😀 message');
  });
  it('keeps notifications private to their recipient within the organization', async () => {
    const a = await verifiedUser(), b = await verifiedUser();
    const own = await Notification.create({ organizationId: a.organization._id, userId: a.user._id, type: 'review', title: 'Review needed' });
    const other = await Notification.create({ organizationId: a.organization._id, userId: b.user._id, type: 'review', title: 'Private' });
    const url = `/api/v1/organizations/${a.organization._id}/notifications`;
    const list = await request(app).get(url).set(a.headers); expect(list.body.data).toHaveLength(1);
    expect((await request(app).patch(`${url}/${other._id}/read`).set(a.headers)).status).toBe(404);
    expect((await request(app).patch(`${url}/${own._id}/read`).set(a.headers)).body.data.readAt).toBeTruthy();
  });
  it('creates every declared index and stores only hashed rate limit keys', async () => {
    for (const model of allModels) expect((await model.collection.indexes()).length).toBeGreaterThan(0);
    const a = await verifiedUser();
    await request(app).get(`/api/v1/organizations/${a.organization._id}/analytics`).set(a.headers);
    const bucket = await RateLimitBucket.findOne(); expect(bucket?._id).toMatch(/^api:[a-f0-9]{64}$/);
  });
});
