import { z } from 'zod';

export const emailSchema = z.string().trim().email().max(254).transform(value => value.toLowerCase());
export const passwordSchema = z.string().min(12).max(128);
export const roleSchema = z.enum(['admin', 'creator', 'reviewer', 'auditor']);
export const registerSchema = z.object({ email: emailSchema, name: z.string().trim().min(1).max(100), password: passwordSchema }).strict();
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
export const emailRequestSchema = z.object({ email: emailSchema }).strict();
export const tokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const resetSchema = tokenSchema.extend({ password: passwordSchema });
export const organizationSchema = z.object({ name: z.string().trim().min(1).max(120), slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict();
export const invitationSchema = z.object({ email: emailSchema, role: roleSchema }).strict();
export const roleUpdateSchema = z.object({ role: roleSchema }).strict();
