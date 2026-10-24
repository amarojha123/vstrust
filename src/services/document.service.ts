import { KnowledgeChunk, KnowledgeDocument } from '../models';
import { transaction } from '../config/database';
import type { Actor } from '../types';
import { AppError } from '../utils/errors';
import { recordAudit } from './audit.service';
import { enqueue } from '../jobs/queue';
import { validateUpload } from '../integrations/storage/extract';
import { readPrivate, removePrivate, storePrivate } from '../integrations/storage/local.storage';

function publicDocument(document: any) {
  const value = typeof document.toObject === 'function' ? document.toObject() : { ...document };
  delete value.storageKey;
  return value;
}

export async function uploadDocument(actor: Actor, file: Express.Multer.File) {
  const validated = await validateUpload(file);
  const key = await storePrivate(actor.organizationId, validated.extension, file.buffer);
  try {
    return await transaction(async session => {
      const [document] = await KnowledgeDocument.create([{ organizationId: actor.organizationId, filename: validated.filename, mimeType: validated.mimeType, size: validated.size, sha256: validated.sha256, storageKey: key, createdBy: actor.userId, status: 'uploaded' }], { session });
      await enqueue('document', { documentId: String(document!._id) }, actor.organizationId, session);
      await recordAudit(actor, 'document.uploaded', 'KnowledgeDocument', String(document!._id), { mimeType: validated.mimeType, size: validated.size }, session);
      return publicDocument(document);
    });
  } catch (error) { await removePrivate(key); throw error; }
}

export async function listDocuments(actor: Actor, options: { page: number; limit: number; skip: number; sort: Record<string, 1 | -1> }, status?: string) {
  const filter = { organizationId: actor.organizationId, ...(status ? { status } : {}) };
  const [data, total] = await Promise.all([KnowledgeDocument.find(filter).sort(options.sort).skip(options.skip).limit(options.limit).lean(), KnowledgeDocument.countDocuments(filter)]);
  return { data, pagination: { page: options.page, limit: options.limit, total } };
}

export async function getDocument(actor: Actor, id: string) {
  const document = await KnowledgeDocument.findOne({ _id: id, organizationId: actor.organizationId }).lean();
  if (!document) throw new AppError(404, 'NOT_FOUND', 'Document not found');
  return publicDocument(document);
}

export async function getDocumentChunks(actor: Actor, id: string, options: { page: number; limit: number; skip: number }) {
  await getDocument(actor, id);
  const filter = { organizationId: actor.organizationId, documentId: id };
  const [data, total] = await Promise.all([KnowledgeChunk.find(filter).sort({ index: 1 }).skip(options.skip).limit(options.limit).lean(), KnowledgeChunk.countDocuments(filter)]);
  return { data, pagination: { page: options.page, limit: options.limit, total } };
}

export async function downloadDocument(actor: Actor, id: string) {
  const document: any = await KnowledgeDocument.findOne({ _id: id, organizationId: actor.organizationId }).select('+storageKey').lean();
  if (!document) throw new AppError(404, 'NOT_FOUND', 'Document not found');
  const buffer = await readPrivate(document.storageKey, actor.organizationId);
  await recordAudit(actor, 'document.exported', 'KnowledgeDocument', String(document._id), { size: document.size });
  return { buffer, filename: document.filename as string, mimeType: document.mimeType as string };
}

export async function retryDocument(actor: Actor, id: string, version: number) {
  return transaction(async session => {
    const document: any = await KnowledgeDocument.findOneAndUpdate({ _id: id, organizationId: actor.organizationId, version, status: 'failed', retryCount: { $lt: 3 } }, { $set: { status: 'uploaded', errorCode: null }, $inc: { version: 1, retryCount: 1 } }, { new: true, runValidators: true, session });
    if (!document) {
      if (!await KnowledgeDocument.exists({ _id: id, organizationId: actor.organizationId }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Document not found');
      throw new AppError(409, 'RETRY_UNAVAILABLE', 'Only failed documents below the retry limit can be retried with their current version');
    }
    await enqueue('document', { documentId: id }, actor.organizationId, session);
    await recordAudit(actor, 'document.retried', 'KnowledgeDocument', id, { version: version + 1 }, session);
    return publicDocument(document);
  });
}

export async function transitionDocument(actor: Actor, id: string, version: number, status: 'published' | 'archived') {
  return transaction(async session => {
    const document: any = await KnowledgeDocument.findOneAndUpdate({ _id: id, organizationId: actor.organizationId, version, status: status === 'published' ? 'ready' : { $in: ['ready', 'published', 'failed'] } }, { $set: { status }, $inc: { version: 1 } }, { new: true, runValidators: true, session });
    if (!document) {
      if (!await KnowledgeDocument.exists({ _id: id, organizationId: actor.organizationId }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Document not found');
      throw new AppError(409, 'INVALID_DOCUMENT_STATE', 'Document must be ready to publish, or ready, published, or failed to archive; reload its version');
    }
    await recordAudit(actor, `document.${status}`, 'KnowledgeDocument', id, { version: version + 1 }, session);
    return publicDocument(document);
  });
}
