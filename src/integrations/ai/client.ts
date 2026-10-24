import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { env } from '../../config/env';
import { externalIdSchema, scanRequestSchema, scanResultsSchema, scanStatusSchema, type ScanRequest } from './contracts';

export class AIServiceError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean) { super('AI service request could not be completed'); this.name = 'AIServiceError'; }
}

export interface AIClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  maxRetries: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

export class AIServiceClient {
  private readonly transport: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<unknown>;
  constructor(private readonly options: AIClientOptions) { this.transport = options.fetch ?? fetch; this.sleep = options.sleep ?? (milliseconds => delay(milliseconds)); }

  private async request<T>(path: string, method: 'GET' | 'POST', correlationId: string, idempotencyKey: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    if (!this.options.token) throw new AIServiceError('AI_NOT_CONFIGURED', false);
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.transport(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
          method, signal: controller.signal, redirect: 'error',
          headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId, 'Idempotency-Key': idempotencyKey },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new AIServiceError(response.status === 401 || response.status === 403 ? 'AI_AUTHENTICATION_FAILED' : `AI_HTTP_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); throw new AIServiceError('AI_INVALID_RESPONSE', false); }
        const reader = response.body?.getReader();
        if (!reader) throw new AIServiceError('AI_INVALID_RESPONSE', false);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new AIServiceError('AI_RESPONSE_TOO_LARGE', false); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AIServiceError('AI_INVALID_RESPONSE', false); }
        const result = schema.safeParse(parsed);
        if (!result.success) throw new AIServiceError('AI_INVALID_RESPONSE', false);
        return result.data;
      } catch (error) {
        const failure = error instanceof AIServiceError ? error : new AIServiceError(controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', true);
        if (!failure.retryable || attempt === this.options.maxRetries) throw failure;
      } finally { clearTimeout(timeout); }
      await this.sleep(Math.min(200 * 2 ** attempt, 2000));
    }
    throw new AIServiceError('AI_UNAVAILABLE', true);
  }

  initiateScan(input: ScanRequest, correlationId: string, idempotencyKey: string) {
    return this.request('/api/v1/scans', 'POST', correlationId, idempotencyKey, scanStatusSchema, scanRequestSchema.parse(input));
  }
  getStatus(id: string, organizationId: string, correlationId: string, idempotencyKey: string) {
    return this.request(`/api/v1/scans/${encodeURIComponent(externalIdSchema.parse(id))}?organizationId=${encodeURIComponent(organizationId)}`, 'GET', correlationId, idempotencyKey, scanStatusSchema);
  }
  getResults(id: string, organizationId: string, correlationId: string, idempotencyKey: string) {
    return this.request(`/api/v1/scans/${encodeURIComponent(externalIdSchema.parse(id))}/results?organizationId=${encodeURIComponent(organizationId)}`, 'GET', correlationId, idempotencyKey, scanResultsSchema);
  }
}

export const aiClient = new AIServiceClient({ baseUrl: env.AI_SERVICE_URL, token: env.AI_SERVICE_TOKEN ?? '', timeoutMs: env.AI_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
