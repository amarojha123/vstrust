import { createHash } from 'node:crypto';
import { transaction } from '../config/database.js';
import { ComplianceScan, ContentDocument, Finding, FindingDecision } from '../models/index.js';
import { enqueue } from '../jobs/queue.js';
import { recordAudit } from './audit.service.js';
import { buildKnowledgeSnapshot } from './brand.service.js';
import { applyContentUpdate, getContent } from './content.service.js';
import { AppError } from '../utils/errors.js';
import type { Actor } from '../types/index.js';

type DecisionInput = {
  version: number; findingVersion: number; decision: 'accepted' | 'edited' | 'rejected'; replacement?: string; reason: string;
};
const scanRequestHash = (contentId: string, version: number) => createHash('sha256').update(JSON.stringify({ contentId, version })).digest('hex');

export async function initiateScan(actor: Actor, contentId: string, version: number, idempotencyKey: string) {
  const requestHash = scanRequestHash(contentId, version);
  const replay = async () => {
    const previous = await ComplianceScan.findOne({ organizationId: actor.organizationId, idempotencyKey });
    if (previous && previous.requestHash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request');
    return previous;
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    return await transaction(async session => {
      const content = await getContent(actor, contentId, session);
      if (content.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before scanning');
      if (!['draft', 'analyzed', 'changes_requested'].includes(content.status)) throw new AppError(409, 'CONTENT_LOCKED', 'Content cannot be scanned in this state');
      const knowledgeSnapshot = await buildKnowledgeSnapshot(actor.organizationId, session);
      const [scan] = await ComplianceScan.create([{
        organizationId: actor.organizationId, contentId: content._id, revisionId: content.currentRevisionId,
        requestedBy: actor.userId, idempotencyKey, requestHash, status: 'queued', attempts: 0,
        correlationId: actor.correlationId, knowledgeSnapshot,
      }], { session });
      const claimed = await ContentDocument.findOneAndUpdate({
        _id: content._id, organizationId: actor.organizationId, version, currentRevisionId: content.currentRevisionId, status: content.status,
      }, { $set: { latestScanId: scan!._id } }, { session, new: true, runValidators: true });
      if (!claimed) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before scanning');
      await enqueue('scan', { scanId: String(scan!._id) }, actor.organizationId, session);
      await recordAudit(actor, 'compliance.scan_requested', 'ComplianceScan', String(scan!._id), { contentId, revisionId: String(content.currentRevisionId) }, session);
      return scan;
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      const duplicate = await replay();
      if (duplicate) return duplicate;
    }
    throw error;
  }
}

export async function getScan(actor: Actor, scanId: string) {
  const scan = await ComplianceScan.findOne({ _id: scanId, organizationId: actor.organizationId }).lean();
  if (!scan) throw new AppError(404, 'SCAN_NOT_FOUND', 'Scan not found');
  return scan;
}

export async function listScans(actor: Actor, contentId: string, query: { page: number; limit: number }) {
  await getContent(actor, contentId);
  const filter = { organizationId: actor.organizationId, contentId };
  const [items, total] = await Promise.all([
    ComplianceScan.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    ComplianceScan.countDocuments(filter),
  ]);
  return { items, total, page: query.page, limit: query.limit };
}

export async function listFindings(actor: Actor, scanId: string, query: { page: number; limit: number; category?: string; severity?: string; status?: string }) {
  await getScan(actor, scanId);
  const filter = {
    organizationId: actor.organizationId, scanId,
    ...(query.category ? { category: query.category } : {}),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.status ? { status: query.status } : {}),
  };
  const [items, total] = await Promise.all([
    Finding.find(filter).sort({ createdAt: 1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Finding.countDocuments(filter),
  ]);
  return { items, total, page: query.page, limit: query.limit };
}

export async function getFinding(actor: Actor, findingId: string) {
  const finding = await Finding.findOne({ _id: findingId, organizationId: actor.organizationId }).lean();
  if (!finding) throw new AppError(404, 'FINDING_NOT_FOUND', 'Finding not found');
  return finding;
}

export async function getEvidence(actor: Actor, findingId: string) {
  const finding = await getFinding(actor, findingId);
  return { findingId: String(finding._id), scanId: String(finding.scanId), revisionId: String(finding.revisionId), evidence: finding.evidence };
}

export async function listFindingDecisions(actor: Actor, findingId: string) {
  await getFinding(actor, findingId);
  return FindingDecision.find({ organizationId: actor.organizationId, findingId }).sort({ createdAt: 1 }).lean();
}

export async function decideFinding(actor: Actor, findingId: string, input: DecisionInput) {
  return transaction(async session => {
    const finding = await Finding.findOne({ _id: findingId, organizationId: actor.organizationId }).session(session);
    if (!finding) throw new AppError(404, 'FINDING_NOT_FOUND', 'Finding not found');
    const content = await getContent(actor, String(finding.contentId), session);
    if (finding.status !== 'open') {
      const existing = await FindingDecision.findOne({ organizationId: actor.organizationId, findingId }).session(session);
      if (existing && String(existing.actorId) === actor.userId && existing.decision === input.decision
        && (existing.reason ?? '') === input.reason
        && (input.decision !== 'edited' || existing.replacement === input.replacement)) {
        return { finding, decision: existing, content };
      }
      throw new AppError(409, 'FINDING_ALREADY_DECIDED', 'This finding already has a decision');
    }
    if (finding.version !== input.findingVersion || content.version !== input.version) {
      throw new AppError(409, 'VERSION_CONFLICT', 'Content or finding changed; reload before deciding');
    }
    if (!['draft', 'analyzed', 'changes_requested'].includes(content.status)) throw new AppError(409, 'CONTENT_LOCKED', 'Content cannot be changed in this state');
    if (String(content.currentRevisionId) !== String(finding.revisionId) || String(content.latestScanId) !== String(finding.scanId)) {
      throw new AppError(409, 'STALE_FINDING', 'This finding belongs to an older analysis; rescan the current revision');
    }
    const scan = await ComplianceScan.findOne({
      _id: finding.scanId, organizationId: actor.organizationId, contentId: content._id,
      revisionId: content.currentRevisionId, status: 'completed',
    }).session(session);
    if (!scan) throw new AppError(409, 'SCAN_NOT_COMPLETED', 'Complete the analysis before making finding decisions');
    let replacement: string | undefined;
    let updatedContent = content;
    if (input.decision !== 'rejected') {
      replacement = input.decision === 'edited' ? input.replacement : finding.suggestion;
      if (typeof replacement !== 'string' || replacement.length > 10_000) throw new AppError(422, 'NO_VALID_SUGGESTION', 'This finding does not provide a valid replacement');
      if (!Number.isInteger(finding.start) || !Number.isInteger(finding.end) || finding.start < 0 || finding.end < finding.start || finding.end > content.body.length) {
        throw new AppError(422, 'INVALID_FINDING_RANGE', 'This suggestion cannot be applied to the source revision');
      }
      const body = content.body.slice(0, finding.start) + replacement + content.body.slice(finding.end);
      if (body.length === 0 || body.length > 200_000) throw new AppError(422, 'INVALID_CONTENT_SIZE', 'The resulting content must contain 1 to 200000 characters');
      updatedContent = await applyContentUpdate(actor, content, { version: input.version, body }, session);
    } else {
      // Take a write lock on the content too, so review submission cannot race a finding decision.
      const locked = await ContentDocument.findOneAndUpdate({ _id: content._id, organizationId: actor.organizationId, version: input.version, currentRevisionId: finding.revisionId },
        { $inc: { version: 1 } }, { session, new: true, runValidators: true });
      if (!locked) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before deciding');
      updatedContent = locked;
    }
    const updatedFinding = await Finding.findOneAndUpdate({ _id: finding._id, organizationId: actor.organizationId, version: input.findingVersion, status: 'open' },
      { $set: { status: input.decision }, $inc: { version: 1 } }, { session, new: true, runValidators: true });
    if (!updatedFinding) throw new AppError(409, 'VERSION_CONFLICT', 'This finding already changed');
    const [decision] = await FindingDecision.create([{
      organizationId: actor.organizationId, findingId: finding._id, scanId: finding.scanId,
      revisionId: finding.revisionId, actorId: actor.userId, decision: input.decision,
      ...(replacement !== undefined ? { replacement } : {}), reason: input.reason,
    }], { session });
    await recordAudit(actor, 'finding.decided', 'Finding', findingId, { decision: input.decision, decisionId: String(decision!._id) }, session);
    return { finding: updatedFinding, decision, content: updatedContent };
  });
}
