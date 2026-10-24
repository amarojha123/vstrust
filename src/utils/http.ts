import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { Actor } from '../types';
import { AppError } from './errors';
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');
export function actor(req: Request): Actor {
  if (!req.auth || !req.tenant) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  return { ...req.tenant, userId: req.auth.userId, correlationId: req.correlationId };
}
export function param(req: Request, name: string): string { return objectId.parse(req.params[name]); }
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
}
export function validate(schema: z.ZodType): RequestHandler {
  return (req, _res, next) => { req.body = schema.parse(req.body); next(); };
}
