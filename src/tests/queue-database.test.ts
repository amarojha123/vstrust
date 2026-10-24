import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { MongoRateLimitStore } from '../middlewares/rate-limit';
import { AuditEvent, ComplianceScan, Job, Membership, Organization, User } from '../models';
import { claimJob, completeJob, deferJob, enqueue, extendLease, failJob } from '../jobs/queue';
import { clearDatabase, closeTestDatabase, setupTestDatabase, verifiedUser } from './helpers';
beforeAll(setupTestDatabase); beforeEach(clearDatabase); afterAll(closeTestDatabase);

describe('durable queue and database invariants', () => {
  it('enforces one rate limit shared by independent API instances', async () => {
    const instances = [express(), express()];
    for (const instance of instances) {
      instance.use(rateLimit({ windowMs: 60000, limit: 2, store: new MongoRateLimitStore('test-replicas'), legacyHeaders: false }));
      instance.get('/test', (_req, res) => res.json({ ok: true }));
    }
    expect((await request(instances[0]!).get('/test')).status).toBe(200);
    expect((await request(instances[1]!).get('/test')).status).toBe(200);
    expect((await request(instances[0]!).get('/test')).status).toBe(429);
  });
  it('grants one lease when workers race and fences acknowledgments by owner', async () => {
    const user = await verifiedUser();
    const job = await enqueue('email', { to: 'recipient@example.com', subject: 'Test', text: 'Hello' }, String(user.organization._id));
    const claims = await Promise.all([claimJob('worker-a'), claimJob('worker-b')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean)!;
    const wrongOwner = winner.lockedBy === 'worker-a' ? 'worker-b' : 'worker-a';
    expect((await completeJob(job._id, wrongOwner)).modifiedCount).toBe(0);
    expect(await extendLease(job._id, winner.lockedBy)).toBe(true);
    expect((await completeJob(job._id, winner.lockedBy)).modifiedCount).toBe(1);
    const persisted = await Job.findById(job._id).select('+payload');
    expect(persisted!.status).toBe('completed'); expect(persisted!.payload).toBeUndefined();
  });
  it('bounds retry attempts, schedules exponential backoff and erases terminal payloads', async () => {
    const job = await enqueue('email', { to: 'x@example.com', subject: 'Test', text: 'Secret reset link' });
    const first = await claimJob('worker'); expect(first!.attempts).toBe(1);
    expect(await failJob(job._id, 'worker', 'SMTP_UNAVAILABLE')).toBe(false);
    const pending = await Job.findById(job._id); expect(pending!.status).toBe('pending');
    expect(pending!.runAt.getTime()).toBeGreaterThan(Date.now());
    await Job.updateOne({ _id: job._id }, { $set: { attempts: 4, runAt: new Date(0) } });
    expect((await claimJob('worker'))!.attempts).toBe(5);
    expect(await failJob(job._id, 'worker', 'SMTP_UNAVAILABLE')).toBe(true);
    expect(await claimJob('another')).toBeNull();
    const failed = await Job.findById(job._id).select('+payload'); expect(failed!.payload).toBeUndefined();
  });
  it('defers pending AI work without spending the failure retry budget', async () => {
    const job = await enqueue('email', { to: 'x@example.com', subject: 'Test', text: 'Payload retained' });
    await claimJob('worker');
    await deferJob(job._id, 'worker', 2000);
    const deferred = await Job.findById(job._id).select('+payload');
    expect(deferred!.status).toBe('pending'); expect(deferred!.attempts).toBe(0);
    expect(deferred!.payload.text).toBe('Payload retained');
    expect(await claimJob('worker')).toBeNull();
    await Job.updateOne({ _id: job._id }, { $set: { runAt: new Date(0) } });
    expect((await claimJob('worker'))!.attempts).toBe(1);
  });
  async function queuedScan() {
    const account = await verifiedUser();
    const scan = await ComplianceScan.create({ organizationId: account.organization._id, contentId: new Types.ObjectId(), revisionId: new Types.ObjectId(), requestedBy: account.user._id, idempotencyKey: 'atomic-failure-key', requestHash: 'a'.repeat(64), correlationId: 'queue-failure-test', status: 'running' });
    const job = await enqueue('scan', { scanId: String(scan._id) }, String(account.organization._id));
    await claimJob('worker');
    return { scan, job };
  }
  it('atomically records terminal job, resource and audit failure together', async () => {
    const { scan, job } = await queuedScan();
    expect(await failJob(job._id, 'worker', 'AI_INVALID_RESPONSE', true)).toBe(true);
    expect((await Job.findById(job._id))!.status).toBe('failed');
    expect((await ComplianceScan.findById(scan._id))!.status).toBe('failed');
    expect(await AuditEvent.countDocuments({ resourceId: String(scan._id), action: 'compliance.scan.failed' })).toBe(1);
  });
  it('reaps a crashed final attempt and records its resource failure', async () => {
    const { scan, job } = await queuedScan();
    await Job.updateOne({ _id: job._id }, { $set: { attempts: 5, leaseUntil: new Date(0) } });
    expect(await claimJob('replacement')).toBeNull();
    expect((await Job.findById(job._id))!.lastError).toBe('LEASE_EXHAUSTED');
    expect((await ComplianceScan.findById(scan._id))!.errorCode).toBe('LEASE_EXHAUSTED');
    expect(await AuditEvent.countDocuments({ resourceId: String(scan._id), action: 'compliance.scan.failed' })).toBe(1);
  });
  it('reclaims expired leases and refuses expired heartbeat', async () => {
    const job = await enqueue('email', { to: 'x@example.com', subject: 'Test', text: 'Hello' });
    await claimJob('crashed');
    await Job.updateOne({ _id: job._id }, { $set: { leaseUntil: new Date(0) } });
    expect(await extendLease(job._id, 'crashed')).toBe(false);
    const recovered = await claimJob('replacement'); expect(recovered!.lockedBy).toBe('replacement'); expect(recovered!.attempts).toBe(2);
    expect((await completeJob(job._id, 'crashed')).modifiedCount).toBe(0);
  });
  it('enforces normalized email, slug and membership uniqueness in MongoDB', async () => {
    const user = await verifiedUser('unique@example.com');
    await expect(User.create({ name: 'Duplicate', email: 'UNIQUE@example.com', passwordHash: 'hash' })).rejects.toMatchObject({ code: 11000 });
    await expect(Organization.create({ name: 'Duplicate', slug: user.organization.slug })).rejects.toMatchObject({ code: 11000 });
    await expect(Membership.create({ organizationId: user.organization._id, userId: user.user._id, role: 'auditor' })).rejects.toMatchObject({ code: 11000 });
    await expect(Membership.create({ organizationId: user.organization._id, userId: new Types.ObjectId(), role: 'superadmin' })).rejects.toThrow();
  });
  it('rolls back linked database writes when a transaction fails', async () => {
    const { transaction } = await import('../config/database');
    await expect(transaction(async session => {
      await Organization.create([{ name: 'Rolled back', slug: 'rolled-back' }], { session });
      await AuditEvent.create([{ action: 'organization.created', resourceType: 'Organization', correlationId: 'rollback-test' }], { session });
      throw new Error('simulated failure');
    })).rejects.toThrow('simulated failure');
    expect(await Organization.countDocuments()).toBe(0); expect(await AuditEvent.countDocuments()).toBe(0);
  });
});
