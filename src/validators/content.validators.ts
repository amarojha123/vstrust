import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Expected a MongoDB object ID');
export const versionSchema = z.number().int().min(0);
export const contentStates = ['draft', 'analyzed', 'in_review', 'changes_requested', 'resubmitted', 'approved', 'rejected'] as const;
export const createContentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(200_000),
}).strict();
export const updateContentSchema = z.object({
  version: versionSchema,
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().min(1).max(200_000).optional(),
}).strict().refine(value => value.title !== undefined || value.body !== undefined, 'Provide title or body');
export const contentVersionSchema = z.object({ version: versionSchema }).strict();
export const reviewDecisionSchema = z.object({
  version: versionSchema,
  decision: z.enum(['changes_requested', 'approved', 'rejected']),
  comment: z.string().trim().min(1).max(4_000),
}).strict();
export const findingDecisionSchema = z.object({
  version: versionSchema,
  findingVersion: versionSchema,
  decision: z.enum(['accepted', 'edited', 'rejected']),
  replacement: z.string().max(10_000).optional(),
  reason: z.string().trim().min(1).max(4_000),
}).strict().superRefine((value, context) => {
  if (value.decision === 'edited' && value.replacement === undefined) {
    context.addIssue({ code: 'custom', path: ['replacement'], message: 'An edited suggestion requires replacement text' });
  }
  if (value.decision !== 'edited' && value.replacement !== undefined) {
    context.addIssue({ code: 'custom', path: ['replacement'], message: 'Replacement is only accepted for edited suggestions' });
  }
});
export const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export const contentListSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['createdAt', '-createdAt', 'updatedAt', '-updatedAt', 'title', '-title']).default('-createdAt'),
  status: z.enum(contentStates).optional(),
}).strict();
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export const compareSchema = z.object({ from: objectId, to: objectId }).strict();
export const findingListSchema = pageSchema.extend({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  status: z.enum(['open', 'accepted', 'edited', 'rejected']).optional(),
  category: z.string().min(1).max(100).optional(),
});
