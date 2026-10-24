import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { Types, type ClientSession } from 'mongoose';
import { env } from '../config/env';
import { transaction } from '../config/database';
import { ActionToken, Membership, Session, User } from '../models';
import { enqueue } from '../jobs/queue';
import { AppError } from '../utils/errors';
import { recordAudit } from './audit.service';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const opaqueToken = () => randomBytes(32).toString('hex');
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
let dummyHash: Promise<string> | undefined;

function publicUser(user: any) {
  return { id: String(user._id), email: user.email, name: user.name, emailVerified: Boolean(user.emailVerifiedAt), createdAt: user.createdAt };
}

async function issueActionToken(user: any, purpose: 'verify_email' | 'reset_password', correlationId: string, session: ClientSession) {
  const token = opaqueToken();
  const lifetime = purpose === 'reset_password' ? 30 * 60_000 : 24 * 60 * 60_000;
  await ActionToken.create([{ userId: user._id, purpose, tokenHash: digest(token), expiresAt: new Date(Date.now() + lifetime) }], { session });
  const route = purpose === 'reset_password' ? 'reset-password' : 'verify-email';
  const link = new URL(route, `${env.APP_URL.replace(/\/$/, '')}/`);
  link.searchParams.set('token', token);
  await enqueue('email', { to: user.email, subject: purpose === 'reset_password' ? 'Reset your TRUST MARK password' : 'Verify your TRUST MARK email', text: `Open this link to ${purpose === 'reset_password' ? 'reset your password' : 'verify your email'}: ${link.toString()}\nThis link expires and can be used only once.` }, undefined, session);
  await recordAudit({ userId: String(user._id), correlationId }, `auth.${purpose}.requested`, 'User', user._id, {}, session);
}

async function issueSession(userId: string, session?: ClientSession) {
  const sessionId = new Types.ObjectId();
  const csrfToken = opaqueToken();
  const accessToken = jwt.sign({ sid: sessionId.toHexString() }, env.JWT_SECRET, { algorithm: 'HS256', subject: userId, issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: env.SESSION_TTL_SECONDS });
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);
  await Session.create([{ _id: sessionId, userId, tokenHash: digest(accessToken), csrfHash: digest(csrfToken), expiresAt }], { session });
  return { accessToken, csrfToken, expiresAt };
}

export async function register(input: { name: string; email: string; password: string }, correlationId: string) {
  const passwordHash = await hashPassword(input.password);
  return transaction(async session => {
    if (await User.exists({ email: input.email }).session(session)) throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
    const [user] = await User.create([{ email: input.email, name: input.name, passwordHash, status: 'active' }], { session });
    await issueActionToken(user, 'verify_email', correlationId, session);
    await recordAudit({ userId: String(user!._id), correlationId }, 'auth.registered', 'User', user!._id, {}, session);
    return publicUser(user);
  });
}

export async function login(input: { email: string; password: string }, correlationId: string) {
  const user = await User.findOne({ email: input.email }).select('+passwordHash');
  const encoded = user?.passwordHash ?? await (dummyHash ??= hashPassword('unavailable-account-random-placeholder'));
  const valid = await argon2.verify(encoded, input.password);
  if (!user || user.status !== 'active' || !valid) {
    await recordAudit({ correlationId }, 'auth.login.failed', 'Session');
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  return transaction(async session => {
    // Serialize issuance with password reset and account lifecycle changes.
    const active = await User.findOneAndUpdate({ _id: user._id, status: 'active', passwordHash: encoded }, { $set: { updatedAt: new Date() } }, { session, new: true });
    if (!active) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const credentials = await issueSession(String(user._id), session);
    await recordAudit({ userId: String(user._id), correlationId }, 'auth.login.succeeded', 'User', user._id, {}, session);
    return { user: publicUser(active), ...credentials };
  });
}

export async function logout(userId: string, sessionId: string, correlationId: string) {
  await transaction(async session => {
    await Session.updateOne({ _id: sessionId, userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } }, { session });
    await recordAudit({ userId, correlationId }, 'auth.logout', 'Session', sessionId, {}, session);
  });
}

export async function refreshSession(userId: string, sessionId: string, correlationId: string) {
  return transaction(async session => {
    const previous = await Session.findOneAndUpdate({ _id: sessionId, userId, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }, { $set: { revokedAt: new Date() } }, { session, new: true });
    if (!previous) throw new AppError(401, 'SESSION_EXPIRED', 'Session has expired.');
    const credentials = await issueSession(userId, session);
    await recordAudit({ userId, correlationId }, 'auth.session.rotated', 'Session', sessionId, {}, session);
    return credentials;
  });
}

export async function me(userId: string) {
  const user = await User.findOne({ _id: userId, status: 'active' });
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required.');
  const memberships = await Membership.find({ userId, status: 'active' }).select('organizationId role');
  return { ...publicUser(user), memberships };
}

export async function requestEmailAction(email: string, purpose: 'verify_email' | 'reset_password', correlationId: string) {
  await transaction(async session => {
    const user = await User.findOne({ email, status: 'active' }).session(session);
    if (!user || (purpose === 'verify_email' && user.emailVerifiedAt)) return;
    await ActionToken.updateMany({ userId: user._id, purpose, usedAt: { $exists: false } }, { $set: { usedAt: new Date() } }, { session });
    await issueActionToken(user, purpose, correlationId, session);
  });
}

async function consumeToken(token: string, purpose: 'verify_email' | 'reset_password', session: ClientSession) {
  const item = await ActionToken.findOneAndUpdate({ tokenHash: digest(token), purpose, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date() } }, { new: true, session });
  if (!item) throw new AppError(400, 'INVALID_TOKEN', 'The link is invalid or expired.');
  return item;
}

export async function verifyEmail(token: string, correlationId: string) {
  await transaction(async session => {
    const action = await consumeToken(token, 'verify_email', session);
    const user = await User.findOneAndUpdate({ _id: action.userId, status: 'active' }, { $set: { emailVerifiedAt: new Date() } }, { session });
    if (!user) throw new AppError(400, 'INVALID_TOKEN', 'The link is invalid or expired.');
    await ActionToken.updateMany({ userId: user._id, purpose: 'verify_email', usedAt: { $exists: false } }, { $set: { usedAt: new Date() } }, { session });
    await recordAudit({ userId: String(user._id), correlationId }, 'auth.email.verified', 'User', user._id, {}, session);
  });
}

export async function resetPassword(token: string, password: string, correlationId: string) {
  const passwordHash = await hashPassword(password);
  await transaction(async session => {
    const action = await consumeToken(token, 'reset_password', session);
    const user = await User.findOneAndUpdate({ _id: action.userId, status: 'active' }, { $set: { passwordHash } }, { session });
    if (!user) throw new AppError(400, 'INVALID_TOKEN', 'The link is invalid or expired.');
    await Session.updateMany({ userId: action.userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } }, { session });
    await ActionToken.updateMany({ userId: action.userId, purpose: 'reset_password', usedAt: { $exists: false } }, { $set: { usedAt: new Date() } }, { session });
    await recordAudit({ userId: String(action.userId), correlationId }, 'auth.password.reset', 'User', action.userId, {}, session);
  });
}

export async function listSessions(userId: string, currentId: string) {
  const sessions = await Session.find({ userId, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).select('_id createdAt expiresAt').sort({ createdAt: -1 }).limit(100).lean();
  return sessions.map(item => ({ id: String(item._id), current: String(item._id) === currentId, createdAt: item.createdAt, expiresAt: item.expiresAt }));
}

export async function revokeSession(userId: string, sessionId: string, correlationId: string) {
  await transaction(async session => {
    const revoked = await Session.findOneAndUpdate({ _id: sessionId, userId }, { $set: { revokedAt: new Date() } }, { session });
    if (!revoked) throw new AppError(404, 'NOT_FOUND', 'Session not found.');
    await recordAudit({ userId, correlationId }, 'auth.session.revoked', 'Session', sessionId, {}, session);
  });
}
