import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid resource ID');
export const versionSchema = z.object({ version: z.number().int().min(0) }).strict();
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  voice: z.string().max(2000).optional(),
  tone: z.string().max(2000).optional(),
  audience: z.string().max(2000).optional(),
  description: z.string().max(10000).optional(),
}).strict();
export const profileUpdateSchema = profileSchema.partial().extend({ version: z.number().int().min(0) }).strict();
export const guidelineSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10000),
  category: z.string().trim().min(1).max(80),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
}).strict();
export const factSchema = z.object({
  title: z.string().trim().min(1).max(200),
  statement: z.string().trim().min(1).max(10000),
  sourceUrl: z.string().url().max(2000).refine(v => /^https?:\/\//i.test(v), 'Only HTTP(S) sources are permitted').optional(),
}).strict();
export const terminologySchema = z.object({
  term: z.string().trim().min(1).max(200),
  replacement: z.string().max(500).optional(),
  description: z.string().max(4000).optional(),
  caseSensitive: z.boolean().optional(),
}).strict();
export const knowledgeSchemas = { guidelines: guidelineSchema, 'approved-facts': factSchema, 'terminology-rules': terminologySchema };
export const knowledgeListSchema = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
}).passthrough();
export const documentListSchema = z.object({
  status: z.enum(['uploaded', 'processing', 'ready', 'failed', 'published', 'archived']).optional(),
}).passthrough();
