import { Schema, model, type SchemaDefinition, type ClientSession } from 'mongoose';
import { contentStates, roles, severities } from '../types';

const ref = (name: string, required = true) => ({ type: Schema.Types.ObjectId, ref: name, required });
const text = (max = 1000, required = true) => ({ type: String, maxlength: max, required, trim: true });
const org = { organizationId: { ...ref('Organization'), immutable: true } };
const lifecycle = { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', required: true };
const version = { type: Number, default: 0, min: 0, required: true };
const expiry = { type: Date, required: true };

// Dynamic model factory centralizes strict runtime schemas and tenant indexes.
// Services whitelist fields with Zod and always construct organization predicates.
function entity(name: string, definition: SchemaDefinition, immutable = false) {
  const schema = new Schema(definition, {
    timestamps: immutable ? { createdAt: true, updatedAt: false } : true,
    strict: 'throw', optimisticConcurrency: true, toJSON: { transform: (_doc, ret: any) => { delete ret.passwordHash; delete ret.tokenHash; delete ret.csrfHash; delete ret.storageKey; delete ret.knowledgeSnapshot; delete ret.__v; return ret; } },
  });
  if ('organizationId' in definition) schema.index({ organizationId: 1, createdAt: -1, _id: 1 });
  if (immutable) {
    schema.pre('save', function () { if (!this.isNew) throw new Error(`${name} is append-only`); });
    for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
      schema.pre(operation as any, function () { throw new Error(`${name} is append-only`); });
    }
  }
  return schema;
}

const userSchema = entity('User', {
  email: { ...text(254), lowercase: true }, name: text(100),
  passwordHash: { type: String, required: true, select: false },
  emailVerifiedAt: Date, status: { type: String, enum: ['active', 'disabled'], default: 'active', required: true },
});
userSchema.index({ email: 1 }, { unique: true });
export const User = model('User', userSchema);

const organizationSchema = entity('Organization', {
  name: text(120), slug: { ...text(80), lowercase: true, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  status: { type: String, enum: ['active', 'archived'], default: 'active' }, membershipVersion: version,
});
organizationSchema.index({ slug: 1 }, { unique: true });
export const Organization = model('Organization', organizationSchema);

const membershipSchema = entity('Membership', {
  ...org, userId: ref('User'), role: { type: String, enum: roles, required: true },
  status: { type: String, enum: ['active', 'removed'], default: 'active' },
});
membershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1, status: 1 });
export const Membership = model('Membership', membershipSchema);

const invitationSchema = entity('Invitation', {
  ...org, email: { ...text(254), lowercase: true }, role: { type: String, enum: roles, required: true },
  tokenHash: { type: String, select: false, required: true }, expiresAt: expiry,
  acceptedAt: Date, revokedAt: Date, invitedBy: ref('User'),
});
invitationSchema.index({ tokenHash: 1 }, { unique: true });
invitationSchema.index({ organizationId: 1, email: 1, expiresAt: -1 });
export const Invitation = model('Invitation', invitationSchema);

const sessionSchema = entity('Session', {
  userId: ref('User'), tokenHash: { type: String, required: true, select: false },
  csrfHash: { type: String, required: true, select: false }, expiresAt: expiry, revokedAt: Date,
});
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1, revokedAt: 1 });
export const Session = model('Session', sessionSchema);
const actionSchema = entity('ActionToken', {
  userId: ref('User'), purpose: { type: String, enum: ['verify_email', 'reset_password'], required: true },
  tokenHash: { type: String, required: true, select: false }, expiresAt: expiry, usedAt: Date,
});
actionSchema.index({ tokenHash: 1 }, { unique: true });
actionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ActionToken = model('ActionToken', actionSchema);

const brandSchema = entity('BrandProfile', { ...org, name: text(120), voice: text(2000, false), tone: text(2000, false), audience: text(2000, false), description: text(10000, false), version });
brandSchema.index({ organizationId: 1 }, { unique: true });
export const BrandProfile = model('BrandProfile', brandSchema);
const guidelineSchema = entity('Guideline', { ...org, title: text(200), description: text(10000), category: text(80), severity: { type: String, enum: severities, default: 'medium' }, status: lifecycle, version, createdBy: ref('User') });
guidelineSchema.index({ organizationId: 1, status: 1, category: 1 });
export const Guideline = model('Guideline', guidelineSchema);
const factSchema = entity('ApprovedFact', { ...org, title: text(200), statement: text(10000), sourceUrl: text(2000, false), status: lifecycle, version, createdBy: ref('User') });
factSchema.index({ organizationId: 1, status: 1 });
export const ApprovedFact = model('ApprovedFact', factSchema);
const terminologySchema = entity('TerminologyRule', { ...org, term: text(200), replacement: text(500, false), description: text(4000, false), caseSensitive: { type: Boolean, default: false }, status: lifecycle, version, createdBy: ref('User') });
terminologySchema.index({ organizationId: 1, term: 1 }, { unique: true });
export const TerminologyRule = model('TerminologyRule', terminologySchema);

const documentSchema = entity('KnowledgeDocument', {
  ...org, filename: text(255), mimeType: text(150), size: { type: Number, min: 1, required: true },
  storageKey: { type: String, required: true, select: false }, sha256: text(64),
  status: { type: String, enum: ['uploaded', 'processing', 'ready', 'failed', 'published', 'archived'], default: 'uploaded' },
  attempts: { type: Number, default: 0 }, retryCount: { type: Number, default: 0, min: 0, max: 3 }, errorCode: text(100, false), version, createdBy: ref('User'),
});
documentSchema.index({ organizationId: 1, status: 1 });
export const KnowledgeDocument = model('KnowledgeDocument', documentSchema);
const chunkSchema = entity('KnowledgeChunk', { ...org, documentId: ref('KnowledgeDocument'), index: { type: Number, required: true, min: 0 }, text: text(10000), page: { type: Number, min: 1 }, sha256: text(64) });
chunkSchema.index({ organizationId: 1, documentId: 1, index: 1 }, { unique: true });
export const KnowledgeChunk = model('KnowledgeChunk', chunkSchema);

const contentSchema = entity('ContentDocument', {
  ...org, title: text(200), body: { type: String, maxlength: 200000, required: true }, createdBy: ref('User'),
  status: { type: String, enum: contentStates, default: 'draft' }, version,
  revisionNumber: { type: Number, min: 1, default: 1 }, currentRevisionId: ref('ContentRevision', false),
  approvedRevisionId: ref('ContentRevision', false), latestScanId: ref('ComplianceScan', false),
});
contentSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });
export const ContentDocument = model('ContentDocument', contentSchema);
const revisionSchema = entity('ContentRevision', {
  ...org, contentId: ref('ContentDocument'), number: { type: Number, min: 1, required: true },
  title: text(200), body: { type: String, maxlength: 200000, required: true }, createdBy: ref('User'), contentHash: text(64),
}, true);
revisionSchema.index({ organizationId: 1, contentId: 1, number: 1 }, { unique: true });
export const ContentRevision = model('ContentRevision', revisionSchema);
const scanSchema = entity('ComplianceScan', {
  ...org, contentId: ref('ContentDocument'), revisionId: ref('ContentRevision'), requestedBy: ref('User'),
  idempotencyKey: text(128), requestHash: text(64),
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
  externalId: text(200, false), attempts: { type: Number, min: 0, default: 0 }, errorCode: text(100, false),
  completedAt: Date, correlationId: text(100), knowledgeSnapshot: { type: Schema.Types.Mixed, select: false },
});
scanSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
scanSchema.index({ organizationId: 1, revisionId: 1, status: 1 });
export const ComplianceScan = model('ComplianceScan', scanSchema);
const evidence = new Schema({ sourceId: { type: String, required: true }, chunkId: String, quote: text(10000), start: { type: Number, min: 0 }, end: { type: Number, min: 0 } }, { _id: false, strict: 'throw' });
const findingSchema = entity('Finding', {
  ...org, scanId: ref('ComplianceScan'), contentId: ref('ContentDocument'), revisionId: ref('ContentRevision'), externalId: text(200),
  category: text(80), severity: { type: String, enum: severities, required: true }, ruleId: String,
  ruleType: { type: String, enum: ['brandProfile', 'guideline', 'approvedFact', 'terminologyRule', 'document'] },
  message: text(10000), suggestion: { type: String, maxlength: 10000 }, evidence: { type: [evidence], default: [] },
  start: { type: Number, min: 0 }, end: { type: Number, min: 0 },
  status: { type: String, enum: ['open', 'accepted', 'edited', 'rejected'], default: 'open' }, version,
});
findingSchema.index({ organizationId: 1, scanId: 1, externalId: 1 }, { unique: true });
findingSchema.index({ organizationId: 1, category: 1, severity: 1 });
export const Finding = model('Finding', findingSchema);
const findingDecisionSchema = entity('FindingDecision', {
  ...org, findingId: ref('Finding'), scanId: ref('ComplianceScan'), revisionId: ref('ContentRevision'), actorId: ref('User'),
  decision: { type: String, enum: ['accepted', 'edited', 'rejected'], required: true }, replacement: { type: String, maxlength: 10000 }, reason: text(4000, false),
}, true);
findingDecisionSchema.index({ organizationId: 1, findingId: 1 }, { unique: true });
export const FindingDecision = model('FindingDecision', findingDecisionSchema);
const reviewSchema = entity('Review', {
  ...org, contentId: ref('ContentDocument'), revisionId: ref('ContentRevision'), submittedBy: ref('User'),
  status: { type: String, enum: ['pending', 'changes_requested', 'approved', 'rejected'], default: 'pending' }, decidedBy: ref('User', false), decidedAt: Date,
});
reviewSchema.index({ organizationId: 1, contentId: 1, revisionId: 1 }, { unique: true });
export const Review = model('Review', reviewSchema);
const approvalSchema = entity('ApprovalDecision', {
  ...org, contentId: ref('ContentDocument'), revisionId: ref('ContentRevision'), reviewId: ref('Review'), actorId: ref('User'),
  decision: { type: String, enum: ['changes_requested', 'approved', 'rejected'], required: true }, comment: text(4000, false),
}, true);
approvalSchema.index({ organizationId: 1, reviewId: 1 }, { unique: true });
export const ApprovalDecision = model('ApprovalDecision', approvalSchema);
const notificationSchema = entity('Notification', {
  ...org, userId: ref('User'), type: text(100), title: text(200), message: text(4000, false), resourceId: String, readAt: Date,
});
notificationSchema.index({ organizationId: 1, userId: 1, readAt: 1, createdAt: -1 });
export const Notification = model('Notification', notificationSchema);
const auditSchema = entity('AuditEvent', {
  organizationId: { ...ref('Organization', false), immutable: true }, actorId: ref('User', false),
  action: text(100), resourceType: text(80), resourceId: text(200, false), correlationId: text(100),
  metadata: { type: Schema.Types.Mixed, default: {} },
}, true);
auditSchema.index({ organizationId: 1, action: 1, createdAt: -1 });
export const AuditEvent = model('AuditEvent', auditSchema);
const evaluationSchema = entity('EvaluationRun', {
  ...org, requestedBy: ref('User'), name: text(200), status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
  scanIds: [ref('ComplianceScan')], metrics: { type: Schema.Types.Mixed }, completedAt: Date,
});
export const EvaluationRun = model('EvaluationRun', evaluationSchema);

const jobSchema = entity('Job', {
  organizationId: ref('Organization', false), kind: { type: String, enum: ['email', 'document', 'scan'], required: true },
  payload: { type: Schema.Types.Mixed, required: true, select: false },
  status: { type: String, enum: ['pending', 'running', 'completed', 'failed'], default: 'pending' },
  attempts: { type: Number, default: 0 }, maxAttempts: { type: Number, default: 5, min: 1, max: 10 },
  runAt: { type: Date, default: Date.now }, lockedAt: Date, lockedBy: String, leaseUntil: Date, lastError: String, completedAt: Date,
});
jobSchema.index({ status: 1, runAt: 1, leaseUntil: 1 });
jobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 604800 });
export const Job = model('Job', jobSchema);
const rateSchema = new Schema({ _id: String, hits: Number, resetTime: Date }, { versionKey: false });
rateSchema.index({ resetTime: 1 }, { expireAfterSeconds: 0 });
export const RateLimitBucket = model('RateLimitBucket', rateSchema);
export const allModels = [User, Organization, Membership, Invitation, Session, ActionToken, BrandProfile, Guideline, ApprovedFact, TerminologyRule, KnowledgeDocument, KnowledgeChunk, ContentDocument, ContentRevision, ComplianceScan, Finding, FindingDecision, Review, ApprovalDecision, Notification, AuditEvent, EvaluationRun, Job, RateLimitBucket];
export type TransactionSession = ClientSession;
