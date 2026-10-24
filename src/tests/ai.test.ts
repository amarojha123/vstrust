import { describe, expect, it, vi } from 'vitest';
import { AIServiceClient, AIServiceError } from '../integrations/ai/client';
import { scanRequestSchema, scanResultsSchema, type ScanRequest } from '../integrations/ai/contracts';
import { validateResults } from '../integrations/ai/evidence';

const org = 'a'.repeat(24);
const content = 'b'.repeat(24);
const revision = 'c'.repeat(24);
const rule = 'd'.repeat(24);
const doc = 'e'.repeat(24);
const chunk = 'f'.repeat(24);
const request: ScanRequest = { organizationId: org, content: { id: content, revisionId: revision, title: 'Campaign', body: 'Too loud' }, knowledge: { guidelines: [{ id: rule, title: 'Voice', description: 'Use a calm tone', category: 'tone', severity: 'medium' }], approvedFacts: [], terminologyRules: [], chunks: [{ id: chunk, documentId: doc, text: 'Evidence belongs to this organization.' }] } };
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function client(transport: typeof fetch, maxRetries = 2, timeoutMs = 200) { return new AIServiceClient({ baseUrl: 'http://ai.internal:8000', token: 'server-only-secret', timeoutMs, maxRetries, fetch: transport, sleep: async () => undefined }); }

describe('authenticated AI service contract', () => {
  it('validates requests and sends correlation, idempotency, and service authentication', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 'remote-1', status: 'queued' }));
    await expect(client(transport).initiateScan(request, 'correlation-123', 'stable-key')).resolves.toEqual({ id: 'remote-1', status: 'queued' });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('http://ai.internal:8000/api/v1/scans');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer server-only-secret', 'X-Correlation-ID': 'correlation-123', 'Idempotency-Key': 'stable-key' });
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(scanRequestSchema.safeParse({ ...request, organizationId: { $ne: null } }).success).toBe(false);
  });

  it('retries transient failures with the same idempotency key and limits attempts', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ secret: 'must not surface' }, 503)).mockResolvedValueOnce(jsonResponse({ id: 'remote-1', status: 'completed' }));
    await expect(client(transport).getStatus('remote-1', org, 'correlation', 'stable-key')).resolves.toEqual({ id: 'remote-1', status: 'completed' });
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [, init] of transport.mock.calls) expect(init?.headers).toMatchObject({ 'Idempotency-Key': 'stable-key' });
    const failure = vi.fn<typeof fetch>().mockRejectedValue(new Error('provider stack and secret'));
    await expect(client(failure).getStatus('remote-1', org, 'correlation', 'stable-key')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', retryable: true, message: 'AI service request could not be completed' });
    expect(failure).toHaveBeenCalledTimes(3);
  });

  it('does not retry authentication failures or return provider error bodies', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'provider-api-key=secret' }, 401));
    await expect(client(transport).getStatus('remote-1', org, 'correlation', 'stable-key')).rejects.toMatchObject({ code: 'AI_AUTHENTICATION_FAILED', retryable: false });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('aborts slow provider requests and reports a bounded timeout', async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); }));
    await expect(client(transport, 0, 10).getStatus('remote-1', org, 'correlation', 'stable-key')).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('rejects malformed results, unexpected states, oversized payloads, and unsafe remote IDs', async () => {
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 'remote-1', status: 'approved' }));
    await expect(client(invalid).getStatus('remote-1', org, 'c', 'k')).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE', retryable: false });
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(' '.repeat(4 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }));
    await expect(client(oversized).getResults('remote-1', org, 'c', 'k')).rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' });
    expect(() => client(invalid).getStatus('../other-tenant', org, 'c', 'k')).toThrow();
  });
});

describe('AI evidence and tenant reference validation', () => {
  const finding = { id: 'finding-1', category: 'tone', severity: 'medium' as const, message: 'Use a calmer opening', suggestion: 'Calm', start: 0, end: 3, ruleId: rule, ruleType: 'guideline' as const, evidence: [{ sourceId: rule, quote: 'calm tone', start: 6, end: 15 }] };
  it('accepts evidence only when quotes, offsets, and rule type match the sent snapshot', () => {
    const parsed = scanResultsSchema.parse({ findings: [finding] });
    expect(validateResults(parsed, request.knowledge, request.content.body)).toEqual(parsed);
    const documentEvidence = scanResultsSchema.parse({ findings: [{ ...finding, evidence: [{ sourceId: doc, chunkId: chunk, quote: 'this organization' }] }] });
    expect(() => validateResults(documentEvidence, request.knowledge, request.content.body)).not.toThrow();
  });
  it('rejects malformed provider Unicode before MongoDB can silently replace it', () => {
    for (const field of ['category', 'message', 'suggestion'] as const) {
      for (const code of [0xd800, 0xdc00]) expect(scanResultsSchema.safeParse({ findings: [{ ...finding, [field]: `bad${String.fromCharCode(code)}text` }] }).success).toBe(false);
    }
    expect(scanResultsSchema.safeParse({ findings: [{ ...finding, evidence: [{ sourceId: rule, quote: String.fromCharCode(0xd800) }] }] }).success).toBe(false);
    expect(scanResultsSchema.safeParse({ findings: [{ ...finding, message: String.raw`Literal \ud800 escape` }] }).success).toBe(true);
    expect(scanResultsSchema.safeParse({ findings: [{ ...finding, message: 'Use a calmer tone 😀' }] }).success).toBe(true);
  });
  it.each([
    { ruleId: '1'.repeat(24) },
    { ruleType: 'approvedFact' },
    { end: 500 },
    { start: 5, end: 2 },
    { evidence: [{ sourceId: '1'.repeat(24), quote: 'calm tone' }] },
    { evidence: [{ sourceId: rule, quote: 'invented evidence' }] },
    { evidence: [{ sourceId: rule, quote: 'calm tone', start: 0, end: 9 }] },
    { evidence: [{ sourceId: '1'.repeat(24), chunkId: chunk, quote: 'this organization' }] },
  ])('rejects untrusted source references or invalid text ranges: %j', override => {
    const parsed = scanResultsSchema.parse({ findings: [{ ...finding, ...override }] });
    expect(() => validateResults(parsed, request.knowledge, request.content.body)).toThrow(AIServiceError);
  });
  it('rejects duplicate provider finding IDs atomically', () => {
    const parsed = scanResultsSchema.parse({ findings: [finding, finding] });
    expect(() => validateResults(parsed, request.knowledge, request.content.body)).toThrow(AIServiceError);
  });
});
