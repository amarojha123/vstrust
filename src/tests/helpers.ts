import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { allModels, Membership, Organization, Session, User } from '../models';
import { hashToken } from '../middlewares/security';
let replica: MongoMemoryReplSet | undefined;
export async function setupTestDatabase() {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.24' } });
  await mongoose.connect(replica.getUri());
  // A single test process reconnects to a fresh replica set for each test file.
  // createIndexes avoids reusing Mongoose's cached init promise from a prior DB.
  await Promise.all(allModels.map(model => model.createIndexes()));
}
export async function clearDatabase() {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
}
export async function closeTestDatabase() { await mongoose.disconnect(); await replica?.stop(); }
export async function verifiedUser(email = `${randomBytes(6).toString('hex')}@example.com`, orgName = 'Test organization') {
  const passwordHash = await argon2.hash('Long-Test-Password-123!', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const user = await User.create({ name: 'Test User', email, passwordHash, emailVerifiedAt: new Date() });
  const organization = await Organization.create({ name: orgName, slug: `org-${randomBytes(6).toString('hex')}` });
  await Membership.create({ organizationId: organization._id, userId: user._id, role: 'admin' });
  const sessionId = new mongoose.Types.ObjectId();
  const csrf = randomBytes(32).toString('hex');
  const token = jwt.sign({ sid: String(sessionId) }, env.JWT_SECRET, { subject: String(user._id), issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: env.SESSION_TTL_SECONDS, algorithm: 'HS256' });
  await Session.create({ _id: sessionId, userId: user._id, tokenHash: hashToken(token), csrfHash: hashToken(csrf), expiresAt: new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000) });
  return { user, organization, token, csrf, headers: { Authorization: `Bearer ${token}` } };
}
