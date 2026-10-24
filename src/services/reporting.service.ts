import { Types } from 'mongoose';
import { z } from 'zod';
import { transaction } from '../config/database';
import { ApprovalDecision, AuditEvent, ComplianceScan, ContentDocument, ContentRevision, EvaluationRun, Finding, Notification } from '../models';
import { dateWindow } from './analytics.service';
import { recordAudit } from './audit.service';
import { objectId } from '../utils/http';
import type { Actor } from '../types';
import { paginate } from '../utils/pagination';
import { AppError } from '../utils/errors';
const eventFilters = z.object({ action: z.string().regex(/^[\w.:-]{1,100}$/).optional(), actorId: objectId.optional() });

export async function listAuditEvents(context: Actor, query: unknown) {
  const pagination = paginate(query), filter = eventFilters.parse(query), window = dateWindow(query);
  const match = { organizationId: context.organizationId, createdAt: { $gte: window.from, $lt: window.to }, ...filter };
  const [data, total] = await Promise.all([AuditEvent.find(match).sort(pagination.sort).skip(pagination.skip).limit(pagination.limit).lean(), AuditEvent.countDocuments(match)]);
  return { data, pagination: { page: pagination.page, limit: pagination.limit, total } };
}
export async function listNotifications(context: Actor, rawQuery: unknown) {
  const pagination = paginate(rawQuery);
  const query = z.object({ unread: z.enum(['true', 'false']).optional() }).parse(rawQuery);
  const match = { organizationId: context.organizationId, userId: context.userId, ...(query.unread === 'true' ? { readAt: null } : {}) };
  const [data, total] = await Promise.all([Notification.find(match).sort(pagination.sort).skip(pagination.skip).limit(pagination.limit), Notification.countDocuments(match)]);
  return { data, pagination: { page: pagination.page, limit: pagination.limit, total } };
}
export async function markNotification(context: Actor, notificationId: string) {
  const item = await Notification.findOneAndUpdate({ _id: notificationId, organizationId: context.organizationId, userId: context.userId }, { $set: { readAt: new Date() } }, { new: true });
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Notification not found');
  return item;
}
export async function exportContent(context: Actor, contentId: string, rawQuery: unknown) {
  return transaction(async session => {
    const content = await ContentDocument.findOne({ _id: contentId, organizationId: context.organizationId }).session(session);
    if (!content) throw new AppError(404, 'NOT_FOUND', 'Content not found');
    const query = z.object({ revisionId: objectId.optional() }).parse(rawQuery);
    const revision = await ContentRevision.findOne({ _id: query.revisionId || content.currentRevisionId, contentId, organizationId: context.organizationId }).session(session);
    if (!revision) throw new AppError(404, 'NOT_FOUND', 'Revision not found');
    const decisions = await ApprovalDecision.find({ organizationId: context.organizationId, contentId, revisionId: revision._id }).session(session);
    await recordAudit(context, 'content.exported', 'ContentRevision', revision._id, { format: 'json', revisionId: String(revision._id) }, session);
    return { contentId, revision: revision.toJSON(), status: content.status, approved: String(content.approvedRevisionId) === String(revision._id), decisions };
  });
}
export async function createEvaluation(context: Actor, input: unknown) {
  const body = z.object({ name: z.string().trim().min(1).max(200), scanIds: z.array(objectId).min(1).max(100).refine(v => new Set(v).size === v.length) }).strict().parse(input);
  return transaction(async session => {
    const scans = await ComplianceScan.find({ _id: { $in: body.scanIds }, organizationId: context.organizationId, status: 'completed' }).session(session);
    if (scans.length !== body.scanIds.length) throw new AppError(400, 'INVALID_SCANS', 'Every scan must be completed and belong to this organization');
    const groups = await Finding.aggregate([{ $match: { organizationId: new Types.ObjectId(context.organizationId), scanId: { $in: scans.map(s => s._id) } } }, { $group: { _id: '$severity', count: { $sum: 1 } } }]).session(session);
    const [run] = await EvaluationRun.create([{ ...body, organizationId: context.organizationId, requestedBy: context.userId, status: 'completed', completedAt: new Date(), metrics: { scanCount: scans.length, findingCount: groups.reduce((sum, g) => sum + g.count, 0), findingsBySeverity: groups.map(g => ({ severity: g._id, count: g.count })) } }], { session });
    await recordAudit(context, 'evaluation.completed', 'EvaluationRun', run!._id, { count: scans.length }, session);
    return run;
  });
}
export async function listEvaluations(context: Actor, query: unknown) {
  const p = paginate(query);
  const [data, total] = await Promise.all([EvaluationRun.find({ organizationId: context.organizationId }).sort(p.sort).skip(p.skip).limit(p.limit), EvaluationRun.countDocuments({ organizationId: context.organizationId })]);
  return { data, pagination: { page: p.page, limit: p.limit, total } };
}
