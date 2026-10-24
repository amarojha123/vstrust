import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { env } from '../config/env';
import { transaction } from '../config/database';
import { recordAudit } from '../services/audit.service';
import { Job, ComplianceScan, KnowledgeDocument } from '../models';
export async function enqueue(kind: 'email' | 'document' | 'scan', payload: Record<string, unknown>, organizationId?: string, session?: ClientSession) {
  const [job] = await Job.create([{ kind, payload, organizationId, status: 'pending', runAt: new Date() }], { session });
  return job!;
}
async function persistResourceFailure(job: any, errorCode: string, session: ClientSession) {
  const organizationId = job.organizationId && String(job.organizationId);
  if (!organizationId) return;
  if (job.kind === 'scan' && /^[a-f\d]{24}$/i.test(job.payload?.scanId ?? '')) {
    const scan = await ComplianceScan.findOneAndUpdate({ _id: job.payload.scanId, organizationId, status: { $in: ['queued', 'running'] } }, { $set: { status: 'failed', errorCode } }, { session });
    if (scan) await recordAudit({ organizationId, userId: String(scan.requestedBy), correlationId: scan.correlationId }, 'compliance.scan.failed', 'ComplianceScan', scan._id, { reasonCode: errorCode }, session);
  }
  if (job.kind === 'document' && /^[a-f\d]{24}$/i.test(job.payload?.documentId ?? '')) {
    const document = await KnowledgeDocument.findOneAndUpdate({ _id: job.payload.documentId, organizationId, status: { $in: ['uploaded', 'processing'] } }, { $set: { status: 'failed', errorCode }, $inc: { version: 1 } }, { session });
    if (document) await recordAudit({ organizationId, userId: String(document.createdBy) }, 'document.processing.failed', 'KnowledgeDocument', document._id, { reasonCode: errorCode }, session);
  }
}
export async function claimJob(workerId: string) {
  const now = new Date();
  // A crashed worker's final lease must not leave a resource permanently running.
  const exhausted = await Job.find({ status: 'running', leaseUntil: { $lte: now }, $expr: { $gte: ['$attempts', '$maxAttempts'] } }).select('+payload').limit(50);
  for (const item of exhausted) {
    await transaction(async session => {
      const changed = await Job.updateOne({ _id: item._id, status: 'running', leaseUntil: { $lte: now }, $expr: { $gte: ['$attempts', '$maxAttempts'] } }, { $set: { status: 'failed', lastError: 'LEASE_EXHAUSTED' }, $unset: { lockedBy: 1, leaseUntil: 1, payload: 1 } }, { session });
      if (changed.modifiedCount) await persistResourceFailure(item, 'LEASE_EXHAUSTED', session);
    });
  }
  return Job.findOneAndUpdate({
    $or: [{ status: 'pending', runAt: { $lte: now } }, { status: 'running', leaseUntil: { $lte: now } }],
    $expr: { $lt: ['$attempts', '$maxAttempts'] },
  }, { $set: { status: 'running', lockedBy: workerId, lockedAt: now, leaseUntil: new Date(now.getTime() + env.JOB_LEASE_MS) }, $inc: { attempts: 1 } }, { new: true, sort: { runAt: 1, _id: 1 } }).select('+payload');
}
export async function extendLease(jobId: unknown, workerId: string) {
  const result = await Job.updateOne({ _id: jobId, status: 'running', lockedBy: workerId, leaseUntil: { $gt: new Date() } }, { $set: { leaseUntil: new Date(Date.now() + env.JOB_LEASE_MS) } });
  return result.matchedCount === 1;
}
export async function completeJob(jobId: unknown, workerId: string) {
  return Job.updateOne({ _id: jobId, status: 'running', lockedBy: workerId, leaseUntil: { $gt: new Date() } }, { $set: { status: 'completed', completedAt: new Date() }, $unset: { payload: 1, lockedBy: 1, leaseUntil: 1 } });
}
export async function deferJob(jobId: unknown, workerId: string, delayMs = 2000) {
  return Job.updateOne({ _id: jobId, status: 'running', lockedBy: workerId, leaseUntil: { $gt: new Date() } }, {
    $set: { status: 'pending', runAt: new Date(Date.now() + Math.max(500, Math.min(delayMs, 60000))) },
    $inc: { attempts: -1 }, $unset: { lockedBy: 1, leaseUntil: 1 },
  });
}
export async function failJob(jobId: unknown, workerId: string, errorCode = 'PROCESSING_FAILED', terminal = false) {
  return transaction(async session => {
    const job = await Job.findOne({ _id: jobId, status: 'running', lockedBy: workerId, leaseUntil: { $gt: new Date() } }).select('+payload').session(session);
    if (!job) return false;
    const final = terminal || job.attempts >= job.maxAttempts;
    const delay = Math.min(300000, 1000 * 2 ** (job.attempts - 1)) + Math.floor(Math.random() * 250);
    const safeCode = /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : 'PROCESSING_FAILED';
    await Job.updateOne({ _id: jobId, status: 'running', lockedBy: workerId }, {
      $set: { status: final ? 'failed' : 'pending', runAt: new Date(Date.now() + delay), lastError: safeCode },
      $unset: { lockedBy: 1, leaseUntil: 1, ...(final ? { payload: 1 } : {}) },
    }, { session });
    if (final) await persistResourceFailure(job, safeCode, session);
    return final;
  });
}
export const newWorkerId = () => randomUUID();
