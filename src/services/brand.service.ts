import type { ClientSession, Model } from 'mongoose';
import { ApprovedFact, BrandProfile, Guideline, KnowledgeChunk, KnowledgeDocument, TerminologyRule } from '../models';
import { transaction } from '../config/database';
import type { Actor } from '../types';
import { AppError } from '../utils/errors';
import { recordAudit } from './audit.service';

export type KnowledgeKind = 'guidelines' | 'approved-facts' | 'terminology-rules';
const knowledgeModels: Record<KnowledgeKind, Model<any>> = { guidelines: Guideline, 'approved-facts': ApprovedFact, 'terminology-rules': TerminologyRule };

export async function getProfile(actor: Actor) {
  return BrandProfile.findOne({ organizationId: actor.organizationId }).lean();
}

export async function createProfile(actor: Actor, data: Record<string, unknown>) {
  return transaction(async session => {
    if (await BrandProfile.exists({ organizationId: actor.organizationId }).session(session)) throw new AppError(409, 'PROFILE_EXISTS', 'Brand profile already exists');
    const [profile] = await BrandProfile.create([{ ...data, organizationId: actor.organizationId }], { session });
    await recordAudit(actor, 'brand.profile.created', 'BrandProfile', String(profile!._id), {}, session);
    return profile;
  });
}

export async function updateProfile(actor: Actor, data: Record<string, unknown> & { version: number }) {
  const { version, ...changes } = data;
  return transaction(async session => {
    const profile = await BrandProfile.findOneAndUpdate({ organizationId: actor.organizationId, version }, { $set: changes, $inc: { version: 1 } }, { new: true, runValidators: true, session });
    if (!profile) throw new AppError(409, 'VERSION_CONFLICT', 'Brand profile is missing or has changed; reload before saving');
    await recordAudit(actor, 'brand.profile.updated', 'BrandProfile', String(profile._id), { version: version + 1 }, session);
    return profile;
  });
}

export async function listKnowledge(actor: Actor, kind: KnowledgeKind, options: { page: number; limit: number; skip: number; sort: Record<string, 1 | -1> }, status?: string) {
  const filter = { organizationId: actor.organizationId, ...(status ? { status } : {}) };
  const model = knowledgeModels[kind];
  const [data, total] = await Promise.all([model.find(filter).sort(options.sort).skip(options.skip).limit(options.limit).lean(), model.countDocuments(filter)]);
  return { data, pagination: { page: options.page, limit: options.limit, total } };
}

export async function getKnowledge(actor: Actor, kind: KnowledgeKind, id: string) {
  const item = await knowledgeModels[kind].findOne({ _id: id, organizationId: actor.organizationId }).lean();
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Knowledge item not found');
  return item;
}

export async function createKnowledge(actor: Actor, kind: KnowledgeKind, data: Record<string, unknown>) {
  return transaction(async session => {
    const [item] = await knowledgeModels[kind].create([{ ...data, organizationId: actor.organizationId, createdBy: actor.userId, status: 'draft' }], { session });
    await recordAudit(actor, 'brand.knowledge.created', kind, String(item!._id), {}, session);
    return item;
  });
}

export async function updateKnowledge(actor: Actor, kind: KnowledgeKind, id: string, data: Record<string, unknown> & { version: number }) {
  const { version, ...changes } = data;
  return transaction(async session => {
    const item = await knowledgeModels[kind].findOneAndUpdate({ _id: id, organizationId: actor.organizationId, version }, { $set: { ...changes, status: 'draft' }, $inc: { version: 1 } }, { new: true, runValidators: true, session });
    if (!item) {
      if (!await knowledgeModels[kind].exists({ _id: id, organizationId: actor.organizationId }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Knowledge item not found');
      throw new AppError(409, 'VERSION_CONFLICT', 'Knowledge item has changed; reload before saving');
    }
    await recordAudit(actor, 'brand.knowledge.updated', kind, String(item._id), { version: version + 1 }, session);
    return item;
  });
}

export async function transitionKnowledge(actor: Actor, kind: KnowledgeKind, id: string, version: number, status: 'published' | 'archived') {
  return transaction(async session => {
    const item = await knowledgeModels[kind].findOneAndUpdate({ _id: id, organizationId: actor.organizationId, version, status: { $ne: status } }, { $set: { status }, $inc: { version: 1 } }, { new: true, runValidators: true, session });
    if (!item) {
      if (!await knowledgeModels[kind].exists({ _id: id, organizationId: actor.organizationId }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Knowledge item not found');
      throw new AppError(409, 'VERSION_CONFLICT', 'Knowledge item has changed or is already in that state');
    }
    await recordAudit(actor, `brand.knowledge.${status}`, kind, String(item._id), { version: version + 1 }, session);
    return item;
  });
}

/** A bounded immutable set of published tenant sources; no draft knowledge reaches AI. */
export async function buildKnowledgeSnapshot(organizationId: string, session?: ClientSession) {
  const query = { organizationId, status: 'published' };
  const read = (model: Model<any>) => {
    const result = model.find(query).sort({ _id: 1 }).limit(1001).lean();
    return session ? result.session(session) : result;
  };
  // MongoDB transactions do not support parallel operations on a single session.
  let profileQuery = BrandProfile.findOne({ organizationId }).lean();
  if (session) profileQuery = profileQuery.session(session);
  const profile: any = await profileQuery;
  const guidelines = await read(Guideline);
  const approvedFacts = await read(ApprovedFact);
  const terminologyRules = await read(TerminologyRule);
  const documents = await read(KnowledgeDocument);
  let chunkQuery = KnowledgeChunk.find({ organizationId, documentId: { $in: documents.map(d => d._id) } }).sort({ documentId: 1, index: 1 }).limit(2001).lean();
  if (session) chunkQuery = chunkQuery.session(session);
  const chunks = await chunkQuery;
  if ([guidelines, approvedFacts, terminologyRules, documents].some(items => items.length > 1000) || chunks.length > 2000) throw new AppError(422, 'KNOWLEDGE_TOO_LARGE', 'Published knowledge exceeds the configured scan limit');
  const snapshot = {
    ...(profile ? { brandProfile: { id: String(profile._id), name: profile.name, voice: profile.voice ?? '', tone: profile.tone ?? '', audience: profile.audience ?? '', description: profile.description ?? '' } } : {}),
    guidelines: guidelines.map((d: any) => ({ id: String(d._id), title: d.title, description: d.description, category: d.category, severity: d.severity })),
    approvedFacts: approvedFacts.map((d: any) => ({ id: String(d._id), title: d.title, statement: d.statement, ...(d.sourceUrl ? { sourceUrl: d.sourceUrl } : {}) })),
    terminologyRules: terminologyRules.map((d: any) => ({ id: String(d._id), term: d.term, replacement: d.replacement ?? '', description: d.description ?? '', caseSensitive: d.caseSensitive ?? false })),
    chunks: chunks.map((d: any) => ({ id: String(d._id), documentId: String(d.documentId), text: d.text, ...(d.page ? { page: d.page } : {}) })),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024) throw new AppError(422, 'KNOWLEDGE_TOO_LARGE', 'Published knowledge exceeds the configured scan size');
  return snapshot;
}
