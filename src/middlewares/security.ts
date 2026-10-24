import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { Membership, Organization, Session, User } from '../models';
import type { Permission, Role } from '../types';
import { AppError } from '../utils/errors';
import { objectId } from '../utils/http';
import { isWellFormedText } from '../utils/text';

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
const safeEquals = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const read: Permission[] = ['organization:read', 'brand:read', 'document:read', 'content:read'];
export const permissions: Record<Role, readonly Permission[]> = {
  admin: [...read, 'member:write', 'brand:write', 'document:write', 'content:write', 'scan:write', 'review:write', 'analytics:read', 'audit:read', 'evaluation:write', 'export:read'],
  creator: [...read, 'content:write', 'scan:write'],
  reviewer: [...read, 'brand:write', 'document:write', 'content:write', 'scan:write', 'review:write', 'analytics:read', 'export:read'],
  auditor: [...read, 'analytics:read', 'audit:read', 'export:read'],
};
export const correlation: RequestHandler = (req, res, next) => {
  const candidate = req.get('X-Correlation-ID');
  req.correlationId = candidate && /^[\w-]{1,100}$/.test(candidate) ? candidate : randomUUID();
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
};

export const authenticate: RequestHandler = async (req, _res, next) => {
  const authorization = req.get('authorization');
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  const token = bearer || req.cookies?.tm_session;
  if (typeof token !== 'string' || token.length > 4096) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE });
    if (typeof decoded === 'string' || typeof decoded.sid !== 'string' || typeof decoded.sub !== 'string') throw new Error('Invalid claims');
    objectId.parse(decoded.sid); objectId.parse(decoded.sub);
    claims = decoded;
  } catch { throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired session'); }
  const session = await Session.findOne({ _id: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { $gt: new Date() } }).select('+tokenHash +csrfHash');
  if (!session || !safeEquals(session.tokenHash as string, hashToken(token))) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired session');
  const user = await User.findOne({ _id: claims.sub, status: 'active' }).select('_id');
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired session');
  if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const header = req.get('X-CSRF-Token');
    const cookie = req.cookies?.tm_csrf;
    if (typeof header !== 'string' || typeof cookie !== 'string' || header.length > 256 || !safeEquals(header, cookie) || !safeEquals(hashToken(header), session.csrfHash as string)) throw new AppError(403, 'CSRF_INVALID', 'Valid CSRF token required');
    const origin = req.get('Origin');
    if (origin && !env.CORS_ORIGINS.split(',').map(s => s.trim()).includes(origin)) throw new AppError(403, 'ORIGIN_FORBIDDEN', 'Origin is not allowed');
  }
  req.auth = { userId: claims.sub!, sessionId: claims.sid };
  next();
};
export const tenant: RequestHandler = async (req, _res, next) => {
  if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  const organizationId = objectId.parse(req.params.organizationId);
  const membership = await Membership.findOne({ organizationId, userId: req.auth.userId, status: 'active' });
  const organization = membership && await Organization.findOne({ _id: organizationId, status: 'active' }).select('_id');
  if (!membership || !organization) throw new AppError(404, 'NOT_FOUND', 'Organization not found');
  const user = await User.findById(req.auth.userId).select('emailVerifiedAt');
  if (!user?.emailVerifiedAt) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before accessing organization resources');
  req.tenant = { organizationId, role: membership.role as Role };
  next();
};
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.tenant || !permissions[req.tenant.role].includes(permission)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    next();
  };
}

// Reject operator and dotted keys before validation. User strings remain plain text;
// clients must render content with textContent, never as unsanitized HTML.
function hasUnsafeKey(value: unknown, depth = 0): boolean {
  if (depth > 30) return true;
  if (typeof value === 'string') return !isWellFormedText(value);
  if (Array.isArray(value)) return value.some(v => hasUnsafeKey(v, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, v]) => key.startsWith('$') || key.includes('.') || ['__proto__', 'prototype', 'constructor'].includes(key) || hasUnsafeKey(v, depth + 1));
  return false;
}
export const rejectOperators: RequestHandler = (req, _res, next) => {
  if (hasUnsafeKey(req.body) || hasUnsafeKey(req.query)) throw new AppError(400, 'INVALID_INPUT', 'Invalid input keys or text encoding');
  next();
};
export const enforceOrigin: RequestHandler = (req, _res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && !env.CORS_ORIGINS.split(',').map(v => v.trim()).includes(origin)) throw new AppError(403, 'ORIGIN_FORBIDDEN', 'Origin is not allowed');
    if (req.get('Sec-Fetch-Site') === 'cross-site') throw new AppError(403, 'ORIGIN_FORBIDDEN', 'Cross-site mutation is not allowed');
  }
  next();
};
