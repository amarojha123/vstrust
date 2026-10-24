import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../config/logger';
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let status = 500, code = 'INTERNAL_ERROR', message = 'An unexpected error occurred';
  if (error instanceof AppError) { status = error.status; code = error.code; message = error.message; }
  else if (error instanceof ZodError || error?.name === 'ValidationError' || error?.name === 'CastError' || error?.name === 'StrictModeError') { status = 400; code = 'INVALID_INPUT'; message = 'Request validation failed'; }
  else if (error?.code === 11000 || error?.name === 'VersionError') { status = 409; code = 'CONFLICT'; message = 'The resource changed or already exists'; }
  else if (error?.type === 'entity.too.large' || error?.code === 'LIMIT_FILE_SIZE') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request is too large'; }
  else if (error?.name === 'MulterError') { status = 400; code = 'INVALID_UPLOAD'; message = 'Invalid file upload'; }
  else if (error instanceof SyntaxError && 'body' in error) { status = 400; code = 'INVALID_JSON'; message = 'Invalid JSON body'; }
  else if (error?.name === 'MongoServerSelectionError' || error?.name === 'MongoNetworkError') { status = 503; code = 'DATABASE_UNAVAILABLE'; message = 'Service temporarily unavailable'; }
  if (status >= 500) logger.error({ code, correlationId: req.correlationId, errorType: error?.name ?? 'Error' }, 'Request failed');
  res.status(status).json({ error: { code, message, correlationId: req.correlationId } });
};
