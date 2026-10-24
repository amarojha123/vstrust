import { createHash } from 'node:crypto';
import { ClientSession, Types } from 'mongoose';
import { transaction } from '../config/database.js';
import { ApprovalDecision, ComplianceScan, ContentDocument, ContentRevision, Review } from '../models/index.js';
import { recordAudit } from './audit.service.js';
import { AppError } from '../utils/errors.js';
import type { Actor } from '../types/index.js';
import { notifyRole } from '../events/notifications.js';

type ContentInput = { title: string; body: string };
type ContentUpdate = { version: number; title?: string; body?: string };
type ReviewInput = { version: number; decision: 'changes_requested' | 'approved' | 'rejected'; comment: string };
const editableStates = ['draft', 'analyzed', 'changes_requested'];
const hashContent = (title: string, body: string) => createHash('sha256').update(JSON.stringify({ title, body })).digest('hex');

export async function getContent(actor: Actor, contentId: string, session?: ClientSession) {
  const content = await ContentDocument.findOne({ _id: contentId, organizationId: actor.organizationId }).session(session ?? null);
  if (!content) throw new AppError(404, 'CONTENT_NOT_FOUND', 'Content not found');
  return content;
}

export async function listContent(actor: Actor, query: { page: number; limit: number; sort: string; status?: string }) {
  const filter = { organizationId: actor.organizationId, ...(query.status ? { status: query.status } : {}) };
  const field = query.sort.replace(/^-/, '');
  const direction = query.sort.startsWith('-') ? -1 : 1;
  const [items, total] = await Promise.all([
    ContentDocument.find(filter).sort({ [field]: direction, _id: direction }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    ContentDocument.countDocuments(filter),
  ]);
  return { items, total, page: query.page, limit: query.limit };
}

export async function createContent(actor: Actor, input: ContentInput) {
  return transaction(async session => {
    const contentId = new Types.ObjectId();
    const revisionId = new Types.ObjectId();
    const [content] = await ContentDocument.create([{
      _id: contentId, organizationId: actor.organizationId, title: input.title, body: input.body,
      createdBy: actor.userId, status: 'draft', version: 0, revisionNumber: 1, currentRevisionId: revisionId,
    }], { session });
    await ContentRevision.create([{
      _id: revisionId, organizationId: actor.organizationId, contentId, number: 1,
      title: input.title, body: input.body, createdBy: actor.userId, contentHash: hashContent(input.title, input.body),
    }], { session });
    await recordAudit(actor, 'content.created', 'ContentDocument', String(contentId), { revisionId: String(revisionId) }, session);
    return content;
  });
}

/** All callers, including finding decisions, create the next immutable snapshot under the same transaction. */
export async function applyContentUpdate(actor: Actor, content: any, input: ContentUpdate, session: ClientSession) {
  if (!editableStates.includes(content.status)) throw new AppError(409, 'CONTENT_LOCKED', 'This content state does not permit editing');
  if (content.version !== input.version) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before saving');
  const title = input.title ?? content.title;
  const body = input.body ?? content.body;
  const revisionId = new Types.ObjectId();
  const number = content.revisionNumber + 1;
  const updated = await ContentDocument.findOneAndUpdate({
    _id: content._id, organizationId: actor.organizationId, version: input.version,
    currentRevisionId: content.currentRevisionId, status: { $in: editableStates },
  }, {
    $set: { title, body, currentRevisionId: revisionId, revisionNumber: number, status: content.status === 'changes_requested' ? 'changes_requested' : 'draft' },
    $unset: { latestScanId: 1 }, $inc: { version: 1 },
  }, { new: true, runValidators: true, session });
  if (!updated) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before saving');
  await ContentRevision.create([{
    _id: revisionId, organizationId: actor.organizationId, contentId: content._id, number,
    title, body, createdBy: actor.userId, contentHash: hashContent(title, body),
  }], { session });
  await recordAudit(actor, 'content.updated', 'ContentDocument', String(content._id), { revisionId: String(revisionId), number }, session);
  return updated;
}

export async function updateContent(actor: Actor, contentId: string, input: ContentUpdate) {
  return transaction(async session => applyContentUpdate(actor, await getContent(actor, contentId, session), input, session));
}

export async function listRevisions(actor: Actor, contentId: string, query: { page: number; limit: number }) {
  await getContent(actor, contentId);
  const filter = { organizationId: actor.organizationId, contentId };
  const [items, total] = await Promise.all([
    ContentRevision.find(filter).sort({ number: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    ContentRevision.countDocuments(filter),
  ]);
  return { items, total, page: query.page, limit: query.limit };
}

export async function getRevision(actor: Actor, contentId: string, revisionId: string) {
  const revision = await ContentRevision.findOne({ _id: revisionId, contentId, organizationId: actor.organizationId }).lean();
  if (!revision) throw new AppError(404, 'REVISION_NOT_FOUND', 'Revision not found');
  return revision;
}

export async function compareRevisions(actor: Actor, contentId: string, fromId: string, toId: string) {
  const [from, to] = await Promise.all([getRevision(actor, contentId, fromId), getRevision(actor, contentId, toId)]);
  let start = 0;
  while (start < from.body.length && start < to.body.length && from.body[start] === to.body[start]) start++;
  let oldEnd = from.body.length;
  let newEnd = to.body.length;
  while (oldEnd > start && newEnd > start && from.body[oldEnd - 1] === to.body[newEnd - 1]) { oldEnd--; newEnd--; }
  return {
    from, to, titleChanged: from.title !== to.title,
    change: { start, removed: from.body.slice(start, oldEnd), added: to.body.slice(start, newEnd) },
  };
}

async function requireCurrentAnalysis(actor: Actor, content: any, session: ClientSession) {
  const scan = content.latestScanId && await ComplianceScan.findOne({
    _id: content.latestScanId, organizationId: actor.organizationId, contentId: content._id,
    revisionId: content.currentRevisionId, status: 'completed',
  }).session(session);
  if (!scan) throw new AppError(409, 'ANALYSIS_REQUIRED', 'Complete a compliance scan of the current revision first');
  return scan;
}

export async function submitContent(actor: Actor, contentId: string, version: number) {
  return transaction(async session => {
    const content = await getContent(actor, contentId, session);
    if (content.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before submitting');
    if (!['analyzed', 'changes_requested'].includes(content.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Only analyzed content or requested changes can be submitted');
    await requireCurrentAnalysis(actor, content, session);
    const status = content.status === 'changes_requested' ? 'resubmitted' : 'in_review';
    const updated = await ContentDocument.findOneAndUpdate({ _id: content._id, organizationId: actor.organizationId, version, status: content.status },
      { $set: { status }, $inc: { version: 1 } }, { new: true, runValidators: true, session });
    if (!updated) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before submitting');
    const [review] = await Review.create([{
      organizationId: actor.organizationId, contentId: content._id, revisionId: content.currentRevisionId,
      submittedBy: actor.userId, status: 'pending',
    }], { session });
    await recordAudit(actor, 'content.submitted', 'ContentDocument', contentId, { reviewId: String(review!._id), status }, session);
    await notifyRole(actor, 'reviewer', 'review_requested', 'Content submitted for review', contentId, session);
    return { content: updated, review };
  });
}

export async function listReviews(actor: Actor, contentId: string, query: { page: number; limit: number }) {
  await getContent(actor, contentId);
  const filter = { organizationId: actor.organizationId, contentId };
  const [items, total] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Review.countDocuments(filter),
  ]);
  return { items, total, page: query.page, limit: query.limit };
}

export async function decideReview(actor: Actor, contentId: string, input: ReviewInput) {
  return transaction(async session => {
    const content = await getContent(actor, contentId, session);
    if (content.version !== input.version) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before deciding');
    if (!['in_review', 'resubmitted'].includes(content.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Content must be in review before a decision');
    if (input.decision === 'approved' && String(content.createdBy) === actor.userId) {
      throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', 'An independent reviewer must approve this content');
    }
    await requireCurrentAnalysis(actor, content, session);
    const review = await Review.findOne({ organizationId: actor.organizationId, contentId: content._id, revisionId: content.currentRevisionId, status: 'pending' }).session(session);
    if (!review) throw new AppError(409, 'REVIEW_NOT_PENDING', 'There is no pending review of this revision');
    if (input.decision === 'approved' && String(review.submittedBy) === actor.userId) {
      throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', 'An independent reviewer must approve this submission');
    }
    if (input.decision === 'approved') {
      const revision = await ContentRevision.findOne({
        _id: content.currentRevisionId, contentId: content._id, organizationId: actor.organizationId,
      }).session(session);
      if (!revision) throw new AppError(409, 'REVISION_NOT_FOUND', 'The submitted content revision is unavailable');
      if (String(revision.createdBy) === actor.userId) {
        throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', 'An independent reviewer must approve the revision you edited');
      }
    }
    const updated = await ContentDocument.findOneAndUpdate({
      _id: content._id, organizationId: actor.organizationId, version: input.version, currentRevisionId: content.currentRevisionId, status: content.status,
    }, {
      $set: { status: input.decision, ...(input.decision === 'approved' ? { approvedRevisionId: content.currentRevisionId } : {}) }, $inc: { version: 1 },
    }, { new: true, runValidators: true, session });
    if (!updated) throw new AppError(409, 'VERSION_CONFLICT', 'Content changed; reload before deciding');
    const decided = await Review.findOneAndUpdate({ _id: review._id, organizationId: actor.organizationId, status: 'pending' }, {
      $set: { status: input.decision, decidedBy: actor.userId, decidedAt: new Date() },
    }, { new: true, runValidators: true, session });
    if (!decided) throw new AppError(409, 'REVIEW_NOT_PENDING', 'This review already has a decision');
    const [decision] = await ApprovalDecision.create([{
      organizationId: actor.organizationId, contentId: content._id, revisionId: content.currentRevisionId,
      reviewId: review._id, actorId: actor.userId, decision: input.decision, comment: input.comment,
    }], { session });
    await recordAudit(actor, 'approval.decided', 'ContentDocument', contentId, { decision: input.decision, decisionId: String(decision!._id), revisionId: String(content.currentRevisionId) }, session);
    await notifyRole(actor, 'creator', 'review_decided', `Review decision: ${input.decision}`, contentId, session);
    return { content: updated, review: decided, decision };
  });
}
