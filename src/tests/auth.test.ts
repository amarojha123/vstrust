import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import app from '../app';
import { ActionToken, AuditEvent, Invitation, Job, Membership, Session, User } from '../models';
import { clearDatabase, closeTestDatabase, setupTestDatabase, verifiedUser } from './helpers';

const password = 'Valid-TrustMark-Password!42';
const auth = '/api/v1/auth';

beforeAll(setupTestDatabase);
beforeEach(clearDatabase);
afterAll(closeTestDatabase);

async function emailedToken(email: string, subject: string) {
  const job = await Job.findOne({ kind: 'email', 'payload.to': email, 'payload.subject': subject }).select('+payload').sort({ createdAt: -1, _id: -1 });
  const token = job?.payload?.text.match(/token=([a-f0-9]{64})/)?.[1];
  expect(token).toBeTruthy();
  return token as string;
}

async function signup(email = 'new@example.com') {
  const registration = await request(app).post(`${auth}/register`).send({ email, name: 'New User', password });
  expect(registration.status).toBe(201);
  return email;
}

describe('authentication and session security', () => {
  it('hashes passwords, queues verification, consumes verification once, and logs in with secure session cookies', async () => {
    const email = await signup();
    const user = await User.findOne({ email }).select('+passwordHash');
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(user!.passwordHash, password)).toBe(true);
    const token = await emailedToken(email, 'Verify your TRUST MARK email');
    const stored = await ActionToken.findOne({ userId: user!._id }).select('+tokenHash');
    expect(stored!.tokenHash).not.toBe(token);
    expect((await request(app).post(`${auth}/verify-email`).send({ token })).status).toBe(200);
    expect((await request(app).post(`${auth}/verify-email`).send({ token })).status).toBe(400);
    const login = await request(app).post(`${auth}/login`).send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.data.user.emailVerified).toBe(true);
    expect(login.body.data.user.passwordHash).toBeUndefined();
    const cookieHeaders = String(login.headers['set-cookie']);
    expect(cookieHeaders).toContain('HttpOnly');
    expect(cookieHeaders).toContain('SameSite=Lax');
    const session = await Session.findOne({ userId: user!._id }).select('+tokenHash +csrfHash');
    expect(session!.tokenHash).not.toBe(login.body.data.accessToken);
    expect(session!.csrfHash).not.toBe(login.body.data.csrfToken);
    expect(await AuditEvent.countDocuments({ action: 'auth.registered' })).toBe(1);
  });

  it('uses generic errors for incorrect credentials and rejects invalid authentication', async () => {
    const missing = await request(app).post(`${auth}/login`).send({ email: 'missing@example.com', password });
    await signup();
    const incorrect = await request(app).post(`${auth}/login`).send({ email: 'new@example.com', password: 'wrong' });
    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(missing.body.error.code).toBe(incorrect.body.error.code);
    expect((await request(app).get(`${auth}/me`)).status).toBe(401);
    expect((await request(app).get(`${auth}/me`).set('Authorization', 'Bearer malformed')).status).toBe(401);
  });

  it('requires CSRF proof for cookie mutations and revokes a bearer token on logout', async () => {
    const fixture = await verifiedUser();
    const cookies = `tm_session=${fixture.token}; tm_csrf=${fixture.csrf}`;
    const denied = await request(app).post(`${auth}/logout`).set('Cookie', cookies);
    expect(denied.status).toBe(403);
    expect((await request(app).get(`${auth}/me`).set(fixture.headers)).status).toBe(200);
    expect((await request(app).post(`${auth}/logout`).set(fixture.headers)).status).toBe(204);
    expect((await request(app).get(`${auth}/me`).set(fixture.headers)).status).toBe(401);
  });

  it('accepts matching CSRF cookie/header proof and rotates sessions with replay rejection', async () => {
    const fixture = await verifiedUser();
    const rotation = await request(app).post(`${auth}/refresh`).set('Cookie', `tm_session=${fixture.token}; tm_csrf=${fixture.csrf}`).set('X-CSRF-Token', fixture.csrf);
    expect(rotation.status).toBe(200);
    expect(rotation.body.data.accessToken).not.toBe(fixture.token);
    expect((await request(app).get(`${auth}/me`).set(fixture.headers)).status).toBe(401);
    expect((await request(app).get(`${auth}/me`).set('Authorization', `Bearer ${rotation.body.data.accessToken}`)).status).toBe(200);
  });

  it('resets a password once, revokes existing sessions, and hides account existence', async () => {
    const fixture = await verifiedUser('reset@example.com');
    const known = await request(app).post(`${auth}/forgot-password`).send({ email: fixture.user.email });
    const unknown = await request(app).post(`${auth}/forgot-password`).send({ email: 'not-registered@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    const token = await emailedToken(fixture.user.email, 'Reset your TRUST MARK password');
    expect((await request(app).post(`${auth}/reset-password`).send({ token, password })).status).toBe(200);
    expect((await request(app).post(`${auth}/reset-password`).send({ token, password })).status).toBe(400);
    expect((await request(app).get(`${auth}/me`).set(fixture.headers)).status).toBe(401);
    expect((await request(app).post(`${auth}/login`).send({ email: fixture.user.email, password })).status).toBe(200);
  });

  it('does not allow unverified accounts to create organizations and rejects malformed credentials', async () => {
    await signup();
    const login = await request(app).post(`${auth}/login`).send({ email: 'new@example.com', password });
    const blocked = await request(app).post('/api/v1/organizations').set('Authorization', `Bearer ${login.body.data.accessToken}`).send({ name: 'New organization', slug: 'new-org' });
    expect(blocked.status).toBe(403);
    expect((await request(app).post(`${auth}/register`).send({ email: 'bad', name: 'User', password: 'short' })).status).toBe(400);
    expect((await request(app).post(`${auth}/login`).send({ email: { $ne: null }, password })).status).toBe(400);
    expect((await request(app).post(`${auth}/register`).send({ email: 'new@example.com', name: 'Duplicate', password })).status).toBe(409);
  });

  it('lists only the current user sessions and refuses revocation of another user session', async () => {
    const own = await verifiedUser('own@example.com');
    const other = await verifiedUser('other@example.com');
    const listing = await request(app).get(`${auth}/sessions`).set(own.headers);
    expect(listing.status).toBe(200);
    expect(listing.body.data).toHaveLength(1);
    expect(listing.body.data[0].current).toBe(true);
    const otherSession = await Session.findOne({ userId: other.user._id });
    expect((await request(app).delete(`${auth}/sessions/${otherSession!._id}`).set(own.headers)).status).toBe(404);
    expect((await request(app).get(`${auth}/me`).set(other.headers)).status).toBe(200);
  });

  it('rejects expired sessions and expired password-reset links', async () => {
    const fixture = await verifiedUser('expiry@example.com');
    await Session.updateMany({ userId: fixture.user._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get(`${auth}/me`).set(fixture.headers)).status).toBe(401);
    expect((await request(app).post(`${auth}/forgot-password`).send({ email: fixture.user.email })).status).toBe(202);
    const token = await emailedToken(fixture.user.email, 'Reset your TRUST MARK password');
    await ActionToken.updateMany({ userId: fixture.user._id, purpose: 'reset_password' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post(`${auth}/reset-password`).send({ token, password })).status).toBe(400);
  });
});

describe('organization membership and tenant isolation', () => {
  it('creates a verified organization and isolates organization details and memberships', async () => {
    const own = await verifiedUser('own@example.com');
    const other = await verifiedUser('other@example.com');
    const created = await request(app).post('/api/v1/organizations').set(own.headers).send({ name: 'Second org', slug: 'second-org' });
    expect(created.status).toBe(201);
    expect(await Membership.countDocuments({ organizationId: created.body.data._id, userId: own.user._id, role: 'admin' })).toBe(1);
    expect((await request(app).get(`/api/v1/organizations/${other.organization._id}`).set(own.headers)).status).toBe(404);
    const list = await request(app).get('/api/v1/organizations').set(own.headers);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.pagination.total).toBe(2);
    expect(list.body.data.map((item: any) => item._id)).not.toContain(String(other.organization._id));
  });

  it('binds one-use invitations to the verified recipient email and keeps tokens out of API responses', async () => {
    const admin = await verifiedUser('admin@example.com');
    const recipient = await verifiedUser('recipient@example.com');
    const wrong = await verifiedUser('wrong@example.com');
    const invited = await request(app).post(`/api/v1/organizations/${admin.organization._id}/invitations`).set(admin.headers).send({ email: recipient.user.email, role: 'reviewer' });
    expect(invited.status).toBe(201);
    expect(invited.body.data.token).toBeUndefined();
    expect(invited.body.data.tokenHash).toBeUndefined();
    const token = await emailedToken(recipient.user.email, 'You have been invited to TRUST MARK');
    const acceptPath = '/api/v1/organizations/invitations/accept';
    expect((await request(app).post(acceptPath).set(wrong.headers).send({ token })).status).toBe(400);
    expect((await request(app).post(acceptPath).set(recipient.headers).send({ token })).status).toBe(200);
    expect((await request(app).post(acceptPath).set(recipient.headers).send({ token })).status).toBe(400);
    const membership = await Membership.findOne({ organizationId: admin.organization._id, userId: recipient.user._id });
    expect(membership!.role).toBe('reviewer');
    expect(await Invitation.countDocuments({ organizationId: admin.organization._id, acceptedAt: { $exists: true } })).toBe(1);
  });

  it('enforces administrator role changes and the last-administrator invariant', async () => {
    const admin = await verifiedUser('admin@example.com');
    const creator = await verifiedUser('creator@example.com');
    const member = await Membership.create({ organizationId: admin.organization._id, userId: creator.user._id, role: 'creator', status: 'active' });
    const adminMember = await Membership.findOne({ organizationId: admin.organization._id, userId: admin.user._id });
    const path = `/api/v1/organizations/${admin.organization._id}/members`;
    expect((await request(app).patch(`${path}/${member._id}/role`).set(creator.headers).send({ role: 'admin' })).status).toBe(403);
    expect((await request(app).patch(`${path}/${adminMember!._id}/role`).set(admin.headers).send({ role: 'creator' })).status).toBe(409);
    expect((await request(app).delete(`${path}/${adminMember!._id}`).set(admin.headers)).status).toBe(409);
    expect((await request(app).patch(`${path}/${member._id}/role`).set(admin.headers).send({ role: 'auditor' })).status).toBe(200);
    expect((await request(app).delete(`${path}/${member._id}`).set(admin.headers)).status).toBe(204);
    expect((await request(app).get(`/api/v1/organizations/${admin.organization._id}`).set(creator.headers)).status).toBe(404);
  });

  it('serializes concurrent administrator demotions so one active administrator remains', async () => {
    const first = await verifiedUser('first@example.com');
    const second = await verifiedUser('second@example.com');
    const firstMember = await Membership.findOne({ organizationId: first.organization._id, userId: first.user._id });
    const secondMember = await Membership.create({ organizationId: first.organization._id, userId: second.user._id, role: 'admin', status: 'active' });
    const path = `/api/v1/organizations/${first.organization._id}/members`;
    const responses = await Promise.all([
      request(app).patch(`${path}/${firstMember!._id}/role`).set(first.headers).send({ role: 'creator' }),
      request(app).patch(`${path}/${secondMember._id}/role`).set(second.headers).send({ role: 'creator' }),
    ]);
    const statuses = responses.map(result => result.status).sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect(await Membership.countDocuments({ organizationId: first.organization._id, role: 'admin', status: 'active' })).toBe(1);
  });
});
