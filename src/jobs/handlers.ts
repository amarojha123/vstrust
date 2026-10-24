import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../config/database';
import { env } from '../config/env';
import { ComplianceScan, ContentDocument, ContentRevision, Finding, Job, KnowledgeChunk, KnowledgeDocument, Membership } from '../models';
import { AppError } from '../utils/errors';
import type { Actor, Role } from '../types';
import { recordAudit } from '../services/audit.service';
import { buildKnowledgeSnapshot } from '../services/brand.service';
import { readPrivate } from '../integrations/storage/local.storage';
import { chunkText, extractText } from '../integrations/storage/extract';
import { sendEmail } from '../integrations/email/client';
import { aiClient, AIServiceError, type AIServiceClient } from '../integrations/ai/client';
import { knowledgeSnapshotSchema } from '../integrations/ai/contracts';
import { validateResults } from '../integrations/ai/evidence';
import type { ClientSession } from 'mongoose';

const referenceSchema = z.string().regex(/^[a-f\d]{24}$/i);
const documentPayloadSchema = z.object({ documentId: referenceSchema }).strict();
const scanPayloadSchema = z.object({ scanId: referenceSchema }).strict();
const emailPayloadSchema = z.object({ to: z.string().email(), subject: z.string().min(1).max(300), text: z.string().min(1).max(100000) }).strict();

/** Writing the lease in the same transaction fences workers whose lease was reclaimed. */
async function fenceLease(job: any, session: ClientSession) {
  const result = await Job.updateOne({ _id: job._id, status: 'running', lockedBy: job.lockedBy, leaseUntil: { $gt: new Date() } }, { $set: { leaseUntil: new Date(Date.now() + env.JOB_LEASE_MS) } }, { session });
  if (result.matchedCount !== 1) throw new AppError(409, 'JOB_LEASE_LOST', 'Background job lease was lost');
}

async function backgroundActor(organizationId: string, userId: string, correlationId: string): Promise<Actor> {
  const membership: any = await Membership.findOne({ organizationId, userId, status: 'active' }).lean();
  return { organizationId, userId, role: (membership?.role ?? 'creator') as Role, correlationId };
}

export async function processDocumentJob(job: any) {
  const { documentId } = documentPayloadSchema.parse(job.payload);
  const organizationId = String(job.organizationId);
  const document: any = await KnowledgeDocument.findOne({ _id: documentId, organizationId }).select('+storageKey').lean();
  if (!document) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document processing target not found');
  if (['ready', 'published', 'archived'].includes(document.status)) return;
  const actor = await backgroundActor(organizationId, String(document.createdBy), `job-${String(job._id)}`);
  await transaction(async session => {
    await fenceLease(job, session);
    await KnowledgeDocument.updateOne({ _id: documentId, organizationId, status: { $in: ['uploaded', 'processing', 'failed'] } }, { $set: { status: 'processing', errorCode: null }, $inc: { attempts: 1 } }, { session });
  });
  const buffer = await readPrivate(document.storageKey, organizationId);
  if (createHash('sha256').update(buffer).digest('hex') !== document.sha256) throw new AppError(422, 'DOCUMENT_INTEGRITY_FAILED', 'Stored document failed its integrity check');
  const text = await extractText(buffer, document.mimeType);
  const chunks = chunkText(text);
  await transaction(async session => {
    await fenceLease(job, session);
    const current = await KnowledgeDocument.findOne({ _id: documentId, organizationId, status: 'processing' }).session(session);
    if (!current) throw new AppError(409, 'DOCUMENT_STATE_CHANGED', 'Document processing target changed');
    await KnowledgeChunk.deleteMany({ organizationId, documentId }, { session });
    if (chunks.length) await KnowledgeChunk.insertMany(chunks.map(chunk => ({ ...chunk, organizationId, documentId })), { session });
    await KnowledgeDocument.updateOne({ _id: documentId, organizationId, status: 'processing' }, { $set: { status: 'ready', errorCode: null }, $inc: { version: 1 } }, { session });
    await recordAudit(actor, 'document.processed', 'KnowledgeDocument', documentId, { chunks: chunks.length }, session);
  });
}

/** One scan worker pass. Pending provider scans retry durably using their saved external ID. */
export async function processScanJob(job: any, client: AIServiceClient = aiClient) {
  const { scanId } = scanPayloadSchema.parse(job.payload);
  const organizationId = String(job.organizationId);
  let scan: any = await ComplianceScan.findOne({ _id: scanId, organizationId }).select('+knowledgeSnapshot').lean();
  if (!scan) throw new AppError(404, 'SCAN_NOT_FOUND', 'Scan processing target not found');
  if (scan.status === 'completed') return;
  if (Date.now() - new Date(scan.createdAt).getTime() > 30 * 60 * 1000) throw new AIServiceError('AI_SCAN_EXPIRED', false);
  const revision: any = await ContentRevision.findOne({ _id: scan.revisionId, organizationId, contentId: scan.contentId }).lean();
  if (!revision) throw new AppError(404, 'REVISION_NOT_FOUND', 'Scan revision not found');
  const actor = await backgroundActor(organizationId, String(scan.requestedBy), scan.correlationId);
  await transaction(async session => {
    await fenceLease(job, session);
    const current: any = await ComplianceScan.findOne({ _id: scanId, organizationId, status: { $ne: 'completed' } }).select('+knowledgeSnapshot').session(session);
    if (!current) return;
    // Compatibility for already queued scans: new scans snapshot at initiation.
    const snapshot = current.knowledgeSnapshot ?? await buildKnowledgeSnapshot(organizationId, session);
    await ComplianceScan.updateOne({ _id: scanId, organizationId, status: { $ne: 'completed' } }, { $set: { status: 'running', knowledgeSnapshot: snapshot, errorCode: null }, $inc: { attempts: 1 } }, { session });
  });
  scan = await ComplianceScan.findOne({ _id: scanId, organizationId }).select('+knowledgeSnapshot').lean();
  if (!scan || scan.status === 'completed') return;
  const snapshot = knowledgeSnapshotSchema.parse(scan.knowledgeSnapshot);
  const idempotencyKey = `trustmark-${organizationId}-${scanId}`;
  let externalStatus: Awaited<ReturnType<AIServiceClient['getStatus']>>;
  if (scan.externalId) {
    externalStatus = await client.getStatus(scan.externalId, organizationId, scan.correlationId, idempotencyKey);
    if (externalStatus.id !== scan.externalId) throw new AIServiceError('AI_UNTRUSTED_RESULT', false);
  } else {
    externalStatus = await client.initiateScan({ organizationId, content: { id: String(scan.contentId), revisionId: String(scan.revisionId), title: revision.title, body: revision.body }, knowledge: snapshot }, scan.correlationId, idempotencyKey);
    await transaction(async session => {
      await fenceLease(job, session);
      await ComplianceScan.updateOne({ _id: scanId, organizationId, status: 'running', externalId: { $in: [null, externalStatus.id] } }, { $set: { externalId: externalStatus.id } }, { session });
    });
  }
  if (externalStatus.status === 'failed') throw new AIServiceError('AI_SCAN_FAILED', false);
  if (externalStatus.status !== 'completed') throw new AIServiceError('AI_SCAN_PENDING', true);
  const results = validateResults(await client.getResults(externalStatus.id, organizationId, scan.correlationId, idempotencyKey), snapshot, revision.body);
  await transaction(async session => {
    await fenceLease(job, session);
    const current: any = await ComplianceScan.findOne({ _id: scanId, organizationId }).session(session);
    if (current?.status === 'completed') return;
    if (!current || String(current.revisionId) !== String(revision._id)) throw new AppError(409, 'SCAN_STATE_CHANGED', 'Scan target changed');
    await Finding.deleteMany({ organizationId, scanId }, { session });
    if (results.findings.length) await Finding.insertMany(results.findings.map(({ id, ...finding }) => ({ ...finding, externalId: id, organizationId, scanId, contentId: scan.contentId, revisionId: scan.revisionId, status: 'open' })), { session });
    await ComplianceScan.updateOne({ _id: scanId, organizationId, status: 'running' }, { $set: { status: 'completed', completedAt: new Date(), errorCode: null } }, { session });
    // Scans never make approval decisions. A stale scan cannot analyze a newer revision.
    await ContentDocument.updateOne({ _id: scan.contentId, organizationId, currentRevisionId: scan.revisionId, latestScanId: scanId, status: 'draft' }, { $set: { status: 'analyzed' }, $inc: { version: 1 } }, { session });
    await recordAudit(actor, 'compliance.scan.completed', 'ComplianceScan', scanId, { findings: results.findings.length, revisionId: String(scan.revisionId) }, session);
  });
}

export async function handleJob(job: any) {
  if (job.kind === 'email') return sendEmail(emailPayloadSchema.parse(job.payload));
  if (job.kind === 'document') return processDocumentJob(job);
  if (job.kind === 'scan') return processScanJob(job);
  throw new AppError(400, 'UNKNOWN_JOB_KIND', 'Unknown background job type');
}

