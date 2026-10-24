import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { requirePermission } from '../middlewares/security';
import { AppError } from '../utils/errors';
import * as controller from '../controllers/document.controller';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 } }).single('file');
export const documentRouter = Router({ mergeParams: true });
documentRouter.post('/documents', requirePermission('document:write'), (req, res, next) => {
  upload(req, res, error => {
    if (error) { next(new AppError(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'INVALID_UPLOAD', 'Upload one PDF or DOCX file within the configured size limit')); return; }
    next();
  });
}, controller.upload);
documentRouter.get('/documents', requirePermission('document:read'), controller.list);
documentRouter.get('/documents/:id', requirePermission('document:read'), controller.get);
documentRouter.get('/documents/:id/chunks', requirePermission('document:read'), controller.chunks);
documentRouter.get('/documents/:id/download', requirePermission('document:read'), controller.download);
documentRouter.post('/documents/:id/retry', requirePermission('document:write'), controller.retry);
documentRouter.post('/documents/:id/publish', requirePermission('brand:write'), controller.publish);
documentRouter.post('/documents/:id/archive', requirePermission('brand:write'), controller.archive);
