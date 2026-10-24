import { Types } from 'mongoose';
import { z } from 'zod';
import { ApprovalDecision, Finding, FindingDecision, Review } from '../models';
const dates = z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }).refine(v => !v.from || !v.to || new Date(v.from) < new Date(v.to), { message: 'from must precede to' });
export function dateWindow(query: unknown) {
  const { from, to } = dates.parse(query);
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400000);
  return { from: start, to: end };
}
export async function analytics(organizationId: string, query: unknown) {
  const window = dateWindow(query);
  const match = { organizationId: new Types.ObjectId(organizationId), createdAt: { $gte: window.from, $lt: window.to } };
  const [submissions, decisions, categories, severities, rules, turnaround, corrections] = await Promise.all([
    Review.countDocuments(match),
    ApprovalDecision.aggregate([{ $match: match }, { $group: { _id: '$decision', count: { $sum: 1 } } }]),
    Finding.aggregate([{ $match: match }, { $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }]),
    Finding.aggregate([{ $match: match }, { $group: { _id: '$severity', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }]),
    Finding.aggregate([{ $match: { ...match, ruleId: { $exists: true, $ne: null } } }, { $group: { _id: { ruleId: '$ruleId', ruleType: '$ruleType' }, count: { $sum: 1 } } }, { $sort: { count: -1, '_id.ruleId': 1 } }, { $limit: 20 }]),
    Review.aggregate([{ $match: { ...match, decidedAt: { $type: 'date' } } }, { $group: { _id: null, averageMs: { $avg: { $subtract: ['$decidedAt', '$createdAt'] } }, count: { $sum: 1 } } }]),
    FindingDecision.aggregate([{ $match: match }, { $group: { _id: '$decision', count: { $sum: 1 } } }]),
  ]);
  const count = (rows: any[], key: string) => rows.find(r => r._id === key)?.count ?? 0;
  const approvals = count(decisions, 'approved'), rejections = count(decisions, 'rejected');
  const accepted = count(corrections, 'accepted'), edited = count(corrections, 'edited'), dismissed = count(corrections, 'rejected');
  return {
    window, submissions, approvals, rejections, changesRequested: count(decisions, 'changes_requested'),
    approvalRate: approvals + rejections ? approvals / (approvals + rejections) : null,
    findingsByCategory: categories.map(({ _id, count }) => ({ category: _id, count })),
    findingsBySeverity: severities.map(({ _id, count }) => ({ severity: _id, count })),
    frequentlyViolatedRules: rules.map(({ _id, count }) => ({ ..._id, count })),
    reviewTurnaround: { averageMs: turnaround[0]?.averageMs ?? null, sampleSize: turnaround[0]?.count ?? 0 },
    corrections: { accepted, edited, rejected: dismissed, rate: accepted + edited + dismissed ? (accepted + edited) / (accepted + edited + dismissed) : null },
  };
}
