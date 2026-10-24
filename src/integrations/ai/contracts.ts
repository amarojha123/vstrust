import { z } from 'zod';
import { isWellFormedText } from '../../utils/text';

const id = z.string().regex(/^[a-f\d]{24}$/i).transform(value => value.toLowerCase());
const wellFormedUnicode = isWellFormedText;
export const externalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const severitySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export const knowledgeSnapshotSchema = z.object({
  brandProfile: z.object({ id, name: z.string().max(120), voice: z.string().max(2000), tone: z.string().max(2000), audience: z.string().max(2000), description: z.string().max(10000) }).strict().optional(),
  guidelines: z.array(z.object({ id, title: z.string().max(200), description: z.string().max(10000), category: z.string().max(80), severity: severitySchema }).strict()).max(1000),
  approvedFacts: z.array(z.object({ id, title: z.string().max(200), statement: z.string().max(10000), sourceUrl: z.string().url().optional() }).strict()).max(1000),
  terminologyRules: z.array(z.object({ id, term: z.string().max(200), replacement: z.string().max(500), description: z.string().max(4000), caseSensitive: z.boolean() }).strict()).max(1000),
  chunks: z.array(z.object({ id, documentId: id, text: z.string().max(4000), page: z.number().int().positive().optional() }).strict()).max(2000),
}).strict();
export const scanRequestSchema = z.object({
  organizationId: id,
  content: z.object({ id, revisionId: id, title: z.string().max(500), body: z.string().max(2_000_000) }).strict(),
  knowledge: knowledgeSnapshotSchema,
}).strict();
export const scanStatusSchema = z.object({ id: externalIdSchema, status: z.enum(['queued', 'running', 'completed', 'failed']) }).strict();
export const evidenceSchema = z.object({ sourceId: id, chunkId: id.optional(), quote: z.string().min(1).max(10000).refine(wellFormedUnicode, 'Invalid Unicode'), start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional() }).strict();
export const resultFindingSchema = z.object({
  id: externalIdSchema,
  category: z.string().trim().min(1).max(80).refine(wellFormedUnicode, 'Invalid Unicode'),
  severity: severitySchema,
  message: z.string().trim().min(1).max(10000).refine(wellFormedUnicode, 'Invalid Unicode'),
  suggestion: z.string().max(10000).refine(wellFormedUnicode, 'Invalid Unicode').optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().positive().optional(),
  ruleId: id.optional(),
  ruleType: z.enum(['brandProfile', 'guideline', 'approvedFact', 'terminologyRule', 'document']).optional(),
  evidence: z.array(evidenceSchema).max(50).default([]),
}).strict();
export const scanResultsSchema = z.object({ findings: z.array(resultFindingSchema).max(1000) }).strict();
export type ScanRequest = z.infer<typeof scanRequestSchema>;
export type KnowledgeSnapshot = z.infer<typeof knowledgeSnapshotSchema>;
export type ScanResults = z.infer<typeof scanResultsSchema>;
