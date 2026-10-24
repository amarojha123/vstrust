/** Public response contracts. Deliberately excludes authentication secrets and private storage/provider payloads. */
export function enrichResponses(spec: any): void {
  spec.components ??= {};
  spec.components.schemas ??= {};
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const date = { type: 'string', format: 'date-time' };
  const count = { type: 'integer', minimum: 0 };
  const text = { type: 'string' };
  const nullableRate = { type: 'number', minimum: 0, nullable: true };
  const array = (items: any) => ({ type: 'array', items });
  const object = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'object', properties, required });
  const entity = (properties: Record<string, any>, required: string[], mutable = true) => object({
    _id: ref('ObjectId'), organizationId: ref('ObjectId'), ...properties,
    createdAt: date, ...(mutable ? { updatedAt: date } : {}),
  }, ['_id', 'organizationId', ...required, 'createdAt', ...(mutable ? ['updatedAt'] : [])]);
  const state = { type: 'string', enum: ['draft', 'analyzed', 'in_review', 'changes_requested', 'resubmitted', 'approved', 'rejected'] };
  const severity = { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] };
  const role = { type: 'string', enum: ['admin', 'creator', 'reviewer', 'auditor'] };
  const decision = { type: 'string', enum: ['changes_requested', 'approved', 'rejected'] };
  const severityCount = object({ severity, count });

  Object.assign(spec.components.schemas, {
    ObjectId: { type: 'string', pattern: '^[a-f0-9]{24}$', description: 'MongoDB document identifier.' },
    Pagination: object({ page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, total: count }),
    UserSummary: object({ _id: ref('ObjectId'), name: text, email: { type: 'string', format: 'email' } }),
    Organization: object({
      _id: ref('ObjectId'), name: text, slug: text,
      status: { type: 'string', enum: ['active', 'archived'] }, membershipVersion: count, createdAt: date, updatedAt: date,
    }),
    OrganizationListItem: { allOf: [ref('Organization'), object({ role })] },
    Membership: entity({
      userId: ref('ObjectId'), role, status: { type: 'string', enum: ['active', 'removed'] },
    }, ['userId', 'role', 'status']),
    MembershipListItem: object({
      _id: ref('ObjectId'), userId: ref('UserSummary'), role,
      status: { type: 'string', enum: ['active', 'removed'] }, createdAt: date,
    }),
    ContentDocument: entity({
      title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 200000 },
      createdBy: ref('ObjectId'), status: state, version: count, revisionNumber: { type: 'integer', minimum: 1 },
      currentRevisionId: ref('ObjectId'), approvedRevisionId: ref('ObjectId'), latestScanId: ref('ObjectId'),
    }, ['title', 'body', 'createdBy', 'status', 'version', 'revisionNumber', 'currentRevisionId']),
    ContentRevision: entity({
      contentId: ref('ObjectId'), number: { type: 'integer', minimum: 1 },
      title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 200000 },
      createdBy: ref('ObjectId'), contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA-256 of the immutable title/body snapshot.' },
    }, ['contentId', 'number', 'title', 'body', 'createdBy', 'contentHash'], false),
    ComplianceScan: entity({
      contentId: ref('ObjectId'), revisionId: ref('ObjectId'), requestedBy: ref('ObjectId'),
      status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed'] },
      idempotencyKey: { type: 'string', description: 'The client-supplied key used to deduplicate scan initiation.' },
      correlationId: text, externalId: text, attempts: count, errorCode: text, completedAt: date,
    }, ['contentId', 'revisionId', 'requestedBy', 'status', 'attempts', 'correlationId']),
    Evidence: object({
      sourceId: ref('ObjectId'), chunkId: ref('ObjectId'), quote: text,
      start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 },
    }, ['sourceId', 'quote']),
    Finding: entity({
      scanId: ref('ObjectId'), contentId: ref('ObjectId'), revisionId: ref('ObjectId'), externalId: text,
      category: text, severity, ruleId: ref('ObjectId'), ruleType: text, message: text,
      suggestion: { type: 'string', maxLength: 10000 }, evidence: array(ref('Evidence')),
      start: { type: 'integer', minimum: 0, description: 'Inclusive UTF-16 offset in the immutable source revision.' },
      end: { type: 'integer', minimum: 0, description: 'Exclusive UTF-16 offset in the immutable source revision.' },
      status: { type: 'string', enum: ['open', 'accepted', 'edited', 'rejected'] }, version: count,
    }, ['scanId', 'contentId', 'revisionId', 'externalId', 'category', 'severity', 'message', 'status', 'version']),
    FindingDecision: entity({
      findingId: ref('ObjectId'), scanId: ref('ObjectId'), revisionId: ref('ObjectId'), actorId: ref('ObjectId'),
      decision: { type: 'string', enum: ['accepted', 'edited', 'rejected'] },
      replacement: { type: 'string', maxLength: 10000 }, reason: { type: 'string', maxLength: 4000 },
    }, ['findingId', 'scanId', 'revisionId', 'actorId', 'decision', 'reason'], false),
    Review: entity({
      contentId: ref('ObjectId'), revisionId: ref('ObjectId'), submittedBy: ref('ObjectId'),
      status: { type: 'string', enum: ['pending', 'changes_requested', 'approved', 'rejected'] },
      decidedBy: ref('ObjectId'), decidedAt: date,
    }, ['contentId', 'revisionId', 'submittedBy', 'status']),
    ApprovalDecision: entity({
      contentId: ref('ObjectId'), revisionId: ref('ObjectId'), reviewId: ref('ObjectId'), actorId: ref('ObjectId'), decision,
      comment: { type: 'string', maxLength: 4000 },
    }, ['contentId', 'revisionId', 'reviewId', 'actorId', 'decision', 'comment'], false),
    EvaluationRun: entity({
      requestedBy: ref('ObjectId'), name: { type: 'string', maxLength: 200 },
      status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed'] },
      scanIds: array(ref('ObjectId')), completedAt: date,
      metrics: object({ scanCount: count, findingCount: count, findingsBySeverity: array(severityCount) }),
    }, ['requestedBy', 'name', 'status', 'scanIds', 'metrics']),
    Notification: entity({
      userId: ref('ObjectId'), type: text, title: text, message: text, resourceId: text, readAt: date,
    }, ['userId', 'type', 'title']),
    AuditEvent: object({
      _id: ref('ObjectId'), organizationId: ref('ObjectId'), actorId: ref('ObjectId'),
      action: text, resourceType: text, resourceId: text, correlationId: text,
      metadata: { type: 'object', additionalProperties: true, description: 'Privacy-filtered structural metadata; excludes raw content and secrets.' },
      createdAt: date,
    }, ['_id', 'action', 'resourceType', 'correlationId', 'metadata', 'createdAt']),
    Analytics: object({
      window: object({ from: date, to: date }), submissions: count, approvals: count, rejections: count, changesRequested: count,
      approvalRate: nullableRate,
      findingsByCategory: array(object({ category: text, count })), findingsBySeverity: array(severityCount),
      frequentlyViolatedRules: array(object({
        ruleId: { type: 'string', pattern: '^[a-f0-9]{24}$', nullable: true }, ruleType: { type: 'string', nullable: true }, count,
      })),
      reviewTurnaround: object({ averageMs: { type: 'number', minimum: 0, nullable: true }, sampleSize: count }),
      corrections: object({ accepted: count, edited: count, rejected: count, rate: nullableRate }),
    }),
    ContentSubmission: object({ content: ref('ContentDocument'), review: ref('Review') }),
    ReviewDecisionResult: object({ content: ref('ContentDocument'), review: ref('Review'), decision: ref('ApprovalDecision') }),
    FindingDecisionResult: object({ finding: ref('Finding'), content: ref('ContentDocument'), decision: ref('FindingDecision') }),
    FindingEvidence: object({ findingId: ref('ObjectId'), scanId: ref('ObjectId'), revisionId: ref('ObjectId'), evidence: array(ref('Evidence')) }),
    RevisionComparison: object({
      from: ref('ContentRevision'), to: ref('ContentRevision'), titleChanged: { type: 'boolean' },
      change: object({ start: { type: 'integer', minimum: 0 }, removed: text, added: text }),
    }),
    ContentExport: object({
      contentId: ref('ObjectId'), revision: ref('ContentRevision'), status: state,
      approved: { type: 'boolean', description: 'Whether the exported revision is the recorded approved revision.' }, decisions: array(ref('ApprovalDecision')),
    }),
  });

  const data = (schema: any) => object({ data: schema });
  const page = (schema: any) => object({ data: array(schema), pagination: ref('Pagination') });
  const response = (path: string, method: string, schema: any) => {
    const operation = spec.paths?.[path]?.[method];
    if (!operation) return;
    for (const [code, value] of Object.entries(operation.responses ?? {})) {
      if (!/^2\d\d$/.test(code) || code === '204' || !value || typeof value !== 'object') continue;
      const entry = value as Record<string, any>;
      entry.content ??= {};
      entry.content['application/json'] ??= {};
      entry.content['application/json'].schema = schema;
    }
  };
  const organization = '/api/v1/organizations/{organizationId}';
  const content = `${organization}/content/{contentId}`;

  response('/api/v1/organizations', 'get', page(ref('OrganizationListItem')));
  response('/api/v1/organizations', 'post', data(ref('Organization')));
  response(organization, 'get', data(ref('Organization')));
  response(organization, 'patch', data(ref('Organization')));
  response(`${organization}/members`, 'get', page(ref('MembershipListItem')));
  response(`${organization}/members/{membershipId}/role`, 'patch', data(ref('Membership')));
  response(`${organization}/members/{memberId}/role`, 'patch', data(ref('Membership')));
  response(`${organization}/content`, 'get', page(ref('ContentDocument')));
  response(`${organization}/content`, 'post', data(ref('ContentDocument')));
  response(content, 'get', data(ref('ContentDocument')));
  response(content, 'patch', data(ref('ContentDocument')));
  response(`${content}/autosave`, 'post', data(ref('ContentDocument')));
  response(`${content}/autosave`, 'put', data(ref('ContentDocument')));
  response(`${content}/revisions`, 'get', page(ref('ContentRevision')));
  response(`${content}/revisions/{revisionId}`, 'get', data(ref('ContentRevision')));
  response(`${content}/revisions/compare`, 'get', data(ref('RevisionComparison')));
  response(`${content}/submit`, 'post', data(ref('ContentSubmission')));
  response(`${content}/reviews`, 'get', page(ref('Review')));
  response(`${content}/review`, 'post', data(ref('ReviewDecisionResult')));
  response(`${content}/export`, 'get', data(ref('ContentExport')));
  response(`${content}/scans`, 'get', page(ref('ComplianceScan')));
  response(`${content}/scans`, 'post', data(ref('ComplianceScan')));
  response(`${organization}/scans/{scanId}`, 'get', data(ref('ComplianceScan')));
  response(`${organization}/scans/{scanId}/findings`, 'get', page(ref('Finding')));
  response(`${organization}/findings/{findingId}`, 'get', data(ref('Finding')));
  response(`${organization}/findings/{findingId}/evidence`, 'get', data(ref('FindingEvidence')));
  response(`${organization}/findings/{findingId}/decisions`, 'get', data(array(ref('FindingDecision'))));
  response(`${organization}/findings/{findingId}/decisions`, 'post', data(ref('FindingDecisionResult')));
  response(`${organization}/evaluations`, 'get', page(ref('EvaluationRun')));
  response(`${organization}/evaluations`, 'post', data(ref('EvaluationRun')));
  response(`${organization}/notifications`, 'get', page(ref('Notification')));
  response(`${organization}/notifications/{notificationId}/read`, 'patch', data(ref('Notification')));
  response(`${organization}/audit-events`, 'get', page(ref('AuditEvent')));
  response(`${organization}/analytics`, 'get', data(ref('Analytics')));
}
