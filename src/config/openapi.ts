import { enrichResponses } from './openapi-responses';
type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const id = { type: 'string', pattern: '^[a-fA-F0-9]{24}$', example: '507f1f77bcf86cd799439011' };
const str = (maxLength: number, description?: string): Schema => ({ type: 'string', maxLength, ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const version = { type: 'integer', minimum: 0, description: 'Expected current version; a stale version returns HTTP 409.' };
const role = { type: 'string', enum: ['admin', 'creator', 'reviewer', 'auditor'] };
const knowledgeInputs: Record<string, Schema> = {
  GuidelineInput: obj({ title: str(200), description: str(10000), category: str(80), severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] } }),
  ApprovedFactInput: obj({ title: str(200), statement: str(10000), sourceUrl: { type: 'string', format: 'uri', maxLength: 2000 } }, ['title', 'statement']),
  TerminologyInput: obj({ term: str(200), replacement: str(500), description: str(4000), caseSensitive: { type: 'boolean' } }, ['term']),
};
const body = (schema: Schema) => ({ required: true, content: { 'application/json': { schema } } });
const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503].map(code => [code, { description: ({ 400: 'Invalid input', 401: 'Authentication required', 403: 'Insufficient permission or CSRF failure', 404: 'Resource not found in this organization', 409: 'Version, state or idempotency conflict', 413: 'Upload or body exceeds limit', 415: 'Unsupported upload media type', 422: 'Invalid document or AI result', 429: 'Rate limit exceeded', 500: 'Unexpected error with safe public response', 502: 'Upstream AI failure', 503: 'Dependency unavailable' } as Record<number, string>)[code], content: { 'application/json': { schema: ref('Error') } } }]));
const paths: Record<string, Record<string, unknown>> = {};
function operation(method: string, path: string, summary: string, tag: string, schema?: Schema, options: { public?: boolean; status?: number; permission?: string; query?: string[]; idempotency?: boolean; description?: string } = {}) {
  const full = `/api/v1${path}`;
  const parameters: Schema[] = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: id }));
  for (const query of options.query ?? []) parameters.push({ name: query, in: 'query', schema: ['page', 'limit'].includes(query) ? { type: 'integer', minimum: 1, maximum: query === 'limit' ? 100 : 10000 } : { type: 'string' } });
  if (options.idempotency) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 }, description: 'Unique per organization. Reusing it for different content returns 409.' });
  if (!options.public && !['get', 'head'].includes(method)) parameters.push({ name: 'X-CSRF-Token', in: 'header', schema: { type: 'string' }, description: 'Required for cookie authentication. Copy the tm_csrf cookie value.' });
  const code = options.status ?? (method === 'post' ? 201 : 200);
  paths[full] ??= {};
  paths[full][method] = {
    operationId: `${method}_${path.replace(/[^\w]+/g, '_')}`, tags: [tag], summary,
    description: [options.description, options.permission ? `Required permission: ${options.permission}.` : '', 'All resource identifiers are scoped to the organization in the URL.'].filter(Boolean).join(' '),
    security: options.public ? [] : [{ bearerAuth: [] }, { cookieAuth: [] }], parameters,
    ...(schema ? { requestBody: body(schema) } : {}),
    responses: { [code]: { description: 'Success', ...(code === 204 ? {} : { content: { 'application/json': { schema: { type: 'object', properties: { data: {} }, additionalProperties: true } } } }) }, ...errors },
  };
}
const o = '/organizations/{organizationId}';
const list = ['page', 'limit', 'sort'];
operation('post', '/auth/register', 'Register and queue email verification', 'Authentication', ref('Register'), { public: true });
operation('post', '/auth/login', 'Create a revocable JWT session', 'Authentication', ref('Login'), { public: true, status: 200 });
operation('post', '/auth/logout', 'Revoke the current session and clear cookies', 'Authentication', undefined, { status: 204 });
operation('get', '/auth/me', 'Get the authenticated user', 'Authentication');
operation('post', '/auth/verify-email', 'Consume a one-time email verification token', 'Authentication', ref('Token'), { public: true, status: 200 });
operation('post', '/auth/resend-verification', 'Queue a replacement verification email', 'Authentication', obj({ email: { type: 'string', format: 'email' } }), { public: true, status: 202 });
operation('post', '/auth/forgot-password', 'Request a password reset without revealing account existence', 'Authentication', obj({ email: { type: 'string', format: 'email' } }), { public: true, status: 202 });
operation('post', '/auth/reset-password', 'Reset password and revoke all sessions', 'Authentication', obj({ token: str(200), password: str(128) }), { public: true, status: 200 });
operation('get', '/auth/sessions', 'List your active sessions', 'Authentication');
operation('post', '/auth/refresh', 'Rotate the current session and revoke its previous JWT', 'Authentication', undefined, { status: 200 });
operation('delete', '/auth/sessions/{sessionId}', 'Revoke one of your sessions', 'Authentication', undefined, { status: 204 });
operation('post', '/organizations/invitations/accept', 'Accept an invitation for your verified email', 'Organizations', ref('Token'), { status: 200 });
operation('post', '/organizations', 'Create an organization and its first administrator', 'Organizations', obj({ name: str(120), slug: str(80) }));
operation('get', '/organizations', 'List organizations where you are an active member', 'Organizations', undefined, { query: ['page', 'limit'] });
operation('get', o, 'Get organization details', 'Organizations', undefined, { permission: 'organization:read' });
operation('patch', o, 'Update organization name or slug', 'Organizations', obj({ name: str(120), slug: str(80) }, []), { permission: 'member:write' });
operation('get', `${o}/members`, 'List organization members', 'Organizations', undefined, { query: ['page', 'limit'], permission: 'organization:read' });
operation('post', `${o}/invitations`, 'Invite an organization member by email', 'Organizations', obj({ email: { type: 'string', format: 'email' }, role }), { permission: 'member:write' });
operation('get', `${o}/invitations`, 'List organization invitations', 'Organizations', undefined, { permission: 'member:write', query: ['page', 'limit'] });
operation('delete', `${o}/invitations/{invitationId}`, 'Revoke an invitation', 'Organizations', undefined, { permission: 'member:write', status: 204 });
operation('patch', `${o}/members/{memberId}/role`, 'Change member role while retaining an administrator', 'Organizations', obj({ role }), { permission: 'member:write' });
operation('delete', `${o}/members/{memberId}`, 'Remove a member while retaining an administrator', 'Organizations', undefined, { permission: 'member:write', status: 204 });
operation('get', `${o}/brand-profile`, 'Read brand profile', 'Brand', undefined, { permission: 'brand:read' });
operation('post', `${o}/brand-profile`, 'Create brand profile', 'Brand', obj({ name: str(120), voice: str(2000), tone: str(2000), audience: str(2000), description: str(10000) }, ['name']), { permission: 'brand:write' });
operation('put', `${o}/brand-profile`, 'Update brand profile', 'Brand', ref('BrandProfileInput'), { permission: 'brand:write' });
operation('patch', `${o}/brand-profile`, 'Update brand profile', 'Brand', ref('BrandProfileInput'), { permission: 'brand:write' });
for (const [path, schema] of [['guidelines', 'GuidelineInput'], ['approved-facts', 'ApprovedFactInput'], ['terminology-rules', 'TerminologyInput']]) {
  operation('get', `${o}/${path}`, `List ${path}`, 'Brand', undefined, { permission: 'brand:read', query: [...list, 'status'] });
  operation('post', `${o}/${path}`, `Create draft ${path}`, 'Brand', ref(schema!), { permission: 'brand:write' });
  operation('get', `${o}/${path}/{itemId}`, 'Read knowledge item', 'Brand', undefined, { permission: 'brand:read' });
  operation('patch', `${o}/${path}/{itemId}`, 'Update draft knowledge with optimistic concurrency', 'Brand', obj({ ...(knowledgeInputs[schema!]!.properties as Record<string, unknown>), version }, ['version']), { permission: 'brand:write' });
  operation('post', `${o}/${path}/{itemId}/publish`, 'Publish knowledge', 'Brand', obj({ version }), { permission: 'brand:write', status: 200 });
  operation('post', `${o}/${path}/{itemId}/archive`, 'Archive knowledge', 'Brand', obj({ version }), { permission: 'brand:write', status: 200 });
}
operation('post', `${o}/documents`, 'Upload a private PDF or DOCX and queue extraction', 'Documents', undefined, { permission: 'document:write', status: 202 });
(paths[`/api/v1${o}/documents`]!.post as any).requestBody = { required: true, content: { 'multipart/form-data': { schema: obj({ file: { type: 'string', format: 'binary', description: 'PDF or DOCX. Maximum 10 MiB by default.' } }) } } };
operation('get', `${o}/documents`, 'List document processing states', 'Documents', undefined, { permission: 'document:read', query: [...list, 'status'] });
operation('get', `${o}/documents/{documentId}`, 'Get document processing metadata', 'Documents', undefined, { permission: 'document:read' });
operation('get', `${o}/documents/{documentId}/chunks`, 'Read extracted document chunks', 'Documents', undefined, { permission: 'document:read', query: ['page', 'limit'] });
operation('get', `${o}/documents/{documentId}/download`, 'Download a private document and record an export audit event', 'Documents', undefined, { permission: 'document:read' });
(paths[`/api/v1${o}/documents/{documentId}/download`]!.get as any).responses[200] = {
  description: 'Private document bytes; Content-Disposition: attachment',
  headers: { 'Content-Disposition': { schema: { type: 'string' }, description: 'Attachment filename' } },
  content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } }, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { schema: { type: 'string', format: 'binary' } } },
};
operation('post', `${o}/documents/{documentId}/retry`, 'Retry a failed document', 'Documents', obj({ version }), { permission: 'document:write', status: 202 });
for (const action of ['publish', 'archive']) operation('post', `${o}/documents/{documentId}/${action}`, `${action} extracted knowledge`, 'Documents', obj({ version }), { permission: 'document:write', status: 200 });
operation('get', `${o}/content`, 'List content documents', 'Content', undefined, { permission: 'content:read', query: [...list, 'status'] });
operation('post', `${o}/content`, 'Create a draft and its first immutable revision', 'Content', obj({ title: str(200), body: str(200000) }), { permission: 'content:write' });
operation('get', `${o}/content/{contentId}`, 'Read content and workflow state', 'Content', undefined, { permission: 'content:read' });
operation('patch', `${o}/content/{contentId}`, 'Save content and append an immutable revision', 'Content', obj({ title: str(200), body: str(200000), version }, ['version']), { permission: 'content:write' });
operation('post', `${o}/content/{contentId}/autosave`, 'Autosave with optimistic concurrency', 'Content', obj({ title: str(200), body: str(200000), version }, ['version']), { permission: 'content:write', status: 200 });
operation('put', `${o}/content/{contentId}/autosave`, 'Autosave with optimistic concurrency', 'Content', obj({ title: str(200), body: str(200000), version }, ['version']), { permission: 'content:write', status: 200 });
operation('get', `${o}/content/{contentId}/revisions`, 'Retrieve immutable revision history', 'Content', undefined, { permission: 'content:read', query: ['page', 'limit'] });
operation('get', `${o}/content/{contentId}/revisions/compare`, 'Compare two revisions of this content', 'Content', undefined, { permission: 'content:read', query: ['from', 'to'] });
operation('get', `${o}/content/{contentId}/revisions/{revisionId}`, 'Read an immutable revision', 'Content', undefined, { permission: 'content:read' });
operation('post', `${o}/content/{contentId}/submit`, 'Submit an analyzed revision or resubmit changes for review', 'Approvals', obj({ version }), { permission: 'content:write', status: 200, description: 'Requires a completed scan of the current immutable revision.' });
operation('get', `${o}/content/{contentId}/reviews`, 'Read review history', 'Approvals', undefined, { permission: 'content:read', query: ['page', 'limit'] });
operation('post', `${o}/content/{contentId}/review`, 'Record a human approval decision', 'Approvals', obj({ version, decision: { type: 'string', enum: ['changes_requested', 'approved', 'rejected'] }, comment: str(4000) }), { permission: 'review:write', status: 200, description: 'Authors and submitters cannot approve their own content. Approved revisions are immutable.' });
operation('post', `${o}/content/{contentId}/scans`, 'Queue a scan of the current immutable revision', 'Compliance', obj({ version }), { permission: 'scan:write', idempotency: true, status: 202 });
operation('get', `${o}/content/{contentId}/scans`, 'List scans for content', 'Compliance', undefined, { permission: 'content:read', query: ['page', 'limit'] });
operation('get', `${o}/scans/{scanId}`, 'Read scan processing status', 'Compliance', undefined, { permission: 'content:read' });
operation('get', `${o}/scans/{scanId}/findings`, 'List persisted findings', 'Compliance', undefined, { permission: 'content:read', query: ['page', 'limit', 'severity', 'category', 'status'] });
operation('get', `${o}/findings/{findingId}`, 'Read a finding', 'Compliance', undefined, { permission: 'content:read' });
operation('get', `${o}/findings/{findingId}/evidence`, 'Retrieve validated evidence from the scan snapshot', 'Compliance', undefined, { permission: 'content:read' });
operation('get', `${o}/findings/{findingId}/decisions`, 'Read finding decision history', 'Compliance', undefined, { permission: 'content:read' });
operation('post', `${o}/findings/{findingId}/decisions`, 'Accept, edit, or reject a finding', 'Compliance', obj({ version, findingVersion: version, decision: { type: 'string', enum: ['accepted', 'edited', 'rejected'] }, replacement: str(10000), reason: str(4000) }, ['version', 'findingVersion', 'decision', 'reason']), { permission: 'content:write', status: 200, description: 'version is the content version; findingVersion is the finding version. Accept/edit applies only to the exact unchanged source revision and appends a new content revision.' });
operation('get', `${o}/analytics`, 'Aggregate actual stored submissions, findings and review outcomes', 'Reporting', undefined, { permission: 'analytics:read', query: ['from', 'to'], description: 'UTC ISO dates; [from,to). Defaults to the last 30 days. Rates with no denominator are null.' });
operation('get', `${o}/audit-events`, 'Read append-only organization audit events', 'Reporting', undefined, { permission: 'audit:read', query: [...list, 'from', 'to', 'action', 'actorId'] });
operation('get', `${o}/notifications`, 'List your organization notifications', 'Reporting', undefined, { permission: 'organization:read', query: [...list, 'unread'] });
operation('patch', `${o}/notifications/{notificationId}/read`, 'Mark your notification as read', 'Reporting', undefined, { permission: 'organization:read' });
operation('get', `${o}/content/{contentId}/export`, 'Export content revision and approval provenance as JSON', 'Reporting', undefined, { permission: 'export:read', query: ['revisionId'] });
operation('post', `${o}/evaluations`, 'Persist an evaluation summary of completed organization scans', 'Reporting', obj({ name: str(200), scanIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: id } }), { permission: 'evaluation:write', description: 'Counts stored findings only. Does not invent model accuracy or labeled ground truth.' });
operation('get', `${o}/evaluations`, 'List persisted scan evaluation summaries', 'Reporting', undefined, { permission: 'analytics:read', query: list });

export const openapi = {
  openapi: '3.0.3', info: { title: 'TRUST MARK API', version: '1.0.0', description: 'Brand compliance backend. Authenticate with a Bearer JWT or tm_session cookie. Cookie mutations require X-CSRF-Token matching tm_csrf. Organization membership and verified email are checked on every tenant request. Content is plain text. Scan results never approve content.' },
  servers: [{ url: '/', description: 'Current API server' }], paths,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, cookieAuth: { type: 'apiKey', in: 'cookie', name: 'tm_session' } },
    schemas: {
      Error: obj({ error: obj({ code: str(100), message: str(500), correlationId: str(100) }, ['code', 'message']) }),
      Register: obj({ name: str(100), email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 12, maxLength: 128 } }),
      Login: obj({ email: { type: 'string', format: 'email' }, password: str(128) }), Token: obj({ token: str(200) }),
      BrandProfileInput: obj({ name: str(120), voice: str(2000), tone: str(2000), audience: str(2000), description: str(10000), version }, ['version']),
      ...knowledgeInputs,
    },
  },
};
enrichResponses(openapi);

const dateTime = { type: 'string', format: 'date-time' };
const publicUserProperties = { id, email: { type: 'string', format: 'email' }, name: str(100), emailVerified: { type: 'boolean' }, createdAt: dateTime };
const credentials = { accessToken: { type: 'string', description: 'Confidential revocable JWT. Do not log or persist in browser localStorage.' }, csrfToken: { type: 'string' }, expiresAt: dateTime };
Object.assign(openapi.components.schemas, {
  PublicUser: obj(publicUserProperties),
  SessionCredentials: obj(credentials),
});
function authResponse(path: string, method: string, status: number, data: Schema) {
  const operation = paths[`/api/v1${path}`]?.[method] as any;
  if (operation) operation.responses[status].content = { 'application/json': { schema: obj({ data }) } };
}
authResponse('/auth/register', 'post', 201, obj({ user: ref('PublicUser'), message: str(500) }));
authResponse('/auth/login', 'post', 200, obj({ user: ref('PublicUser'), ...credentials }));
authResponse('/auth/refresh', 'post', 200, ref('SessionCredentials'));
authResponse('/auth/me', 'get', 200, obj({ ...publicUserProperties, memberships: { type: 'array', items: { type: 'object', properties: { _id: id, organizationId: id, role } } } }));
authResponse('/auth/sessions', 'get', 200, { type: 'array', maxItems: 100, items: obj({ id, current: { type: 'boolean' }, createdAt: dateTime, expiresAt: dateTime }) });
for (const [path, status] of [['verify-email', 200], ['reset-password', 200], ['resend-verification', 202], ['forgot-password', 202]] as const) authResponse(`/auth/${path}`, 'post', status, obj({ message: str(500) }));
