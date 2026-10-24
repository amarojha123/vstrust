import type { Request, Response } from 'express';
import * as documents from '../services/document.service';
import { actor } from '../utils/http';
import { paginate } from '../utils/pagination';
import { AppError } from '../utils/errors';
import { documentListSchema, objectIdSchema, versionSchema } from '../validators/brand.validators';

export const upload = async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'FILE_REQUIRED', 'Upload one file in the file form field');
  res.status(202).json({ data: await documents.uploadDocument(actor(req), req.file) });
};
export const list = async (req: Request, res: Response) => { const query = documentListSchema.parse(req.query); res.json(await documents.listDocuments(actor(req), paginate(req.query), query.status)); };
export const get = async (req: Request, res: Response) => { res.json({ data: await documents.getDocument(actor(req), objectIdSchema.parse(req.params.id)) }); };
export const chunks = async (req: Request, res: Response) => { res.json(await documents.getDocumentChunks(actor(req), objectIdSchema.parse(req.params.id), paginate(req.query))); };
export const download = async (req: Request, res: Response) => {
  const document = await documents.downloadDocument(actor(req), objectIdSchema.parse(req.params.id));
  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(document.buffer);
};
export const retry = async (req: Request, res: Response) => { res.status(202).json({ data: await documents.retryDocument(actor(req), objectIdSchema.parse(req.params.id), versionSchema.parse(req.body).version) }); };
export const publish = async (req: Request, res: Response) => { res.json({ data: await documents.transitionDocument(actor(req), objectIdSchema.parse(req.params.id), versionSchema.parse(req.body).version, 'published') }); };
export const archive = async (req: Request, res: Response) => { res.json({ data: await documents.transitionDocument(actor(req), objectIdSchema.parse(req.params.id), versionSchema.parse(req.body).version, 'archived') }); };
