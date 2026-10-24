import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { AuditEvent } from '../models';
import type { Actor } from '../types';
type AuditActor = Partial<Actor>;
// Audit metadata is deliberately structural. Bodies, email addresses, tokens and
// provider payloads must never be persisted in event metadata.
const allowed = new Set(['version', 'revisionNumber', 'number', 'revisionId', 'contentId', 'scanId', 'reviewId', 'findingId', 'decisionId', 'memberId', 'role', 'previousRole', 'status', 'previousStatus', 'decision', 'count', 'format', 'kind', 'bytes', 'size', 'mimeType', 'category', 'severity', 'reasonCode', 'sessionId', 'invitationId', 'targetUserId', 'from', 'to']);
export async function recordAudit(actor: AuditActor, action: string, resourceType: string, resourceId?: unknown, metadata: Record<string, unknown> = {}, session?: ClientSession) {
  const safe = Object.fromEntries(Object.entries(metadata).filter(([k, v]) => allowed.has(k) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200))));
  const [event] = await AuditEvent.create([{
    organizationId: actor.organizationId || undefined, actorId: actor.userId || undefined,
    action, resourceType, resourceId: resourceId == null ? undefined : String(resourceId),
    correlationId: actor.correlationId || randomUUID(), metadata: safe,
  }], { session });
  return event;
}
