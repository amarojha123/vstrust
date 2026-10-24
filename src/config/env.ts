import 'dotenv/config';
import { z } from 'zod';

const boolean = z.enum(['true', 'false']).transform(v => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().startsWith('mongodb').default('mongodb://127.0.0.1:27017/trustmark?replicaSet=rs0'),
  JWT_SECRET: z.string().min(48),
  JWT_ISSUER: z.string().default('trust-mark'),
  JWT_AUDIENCE: z.string().default('trust-mark-api'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2592000).default(86400),
  COOKIE_SECURE: boolean.default(false),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  APP_URL: z.url().default('http://localhost:3000'),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.email().default('noreply@trustmark.local'),
  AI_SERVICE_URL: z.url().default('http://localhost:8000'),
  AI_SERVICE_TOKEN: z.string().min(32),
  AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(15000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  STORAGE_PATH: z.string().default('./private-storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(20971520).default(10485760),
  JOB_POLL_MS: z.coerce.number().int().min(100).default(1000),
  JOB_LEASE_MS: z.coerce.number().int().min(10000).default(60000),
  RUN_WORKER: boolean.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
}).superRefine((v,ctx) => {
  if (v.NODE_ENV === 'production') {
    if (!v.COOKIE_SECURE) ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'Production requires secure cookies' });
    if (!v.APP_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'Production requires HTTPS' });
    if (!v.SMTP_URL) ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'Production requires SMTP delivery' });
    if (v.CORS_ORIGINS.split(',').some(s => !s.trim().startsWith('https://') || s.includes('*'))) ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Explicit HTTPS origins required' });
  }
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Report configuration field names only, never secret values.
  throw new Error(`Invalid environment fields: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
}
export const env = parsed.data;
