# Database model

MongoDB is configured as a replica set and transaction support is required. Collections are declared in `src/models/index.ts`; organization-scoped records are filtered by organization ID in tenant repositories and service queries.

Core relationships:

- User ↔ Organization through Membership (role and membership status).
- Organization → BrandProfile, Guideline, ApprovedFact, TerminologyRule, KnowledgeDocument, KnowledgeChunk.
- Organization → ContentDocument → immutable ContentRevision.
- ContentDocument → ComplianceScan → Finding → FindingDecision.
- ContentDocument → Review → ReviewDecision.
- Organization → AuditEvent and durable Job records.

The API creates indexes through `npm run indexes`; unique organization and idempotency indexes and tenant lookup indexes are defined in `src/jobs/indexes.ts` and model schemas. Uploads are private files addressed by organization-scoped storage keys; file metadata and hashes are persisted in MongoDB. Mongo transactions bind state changes, queue operations, and audit records where the operation requires atomicity.

For production, use an authenticated replica set, scheduled backups, tested point-in-time recovery, and a private object store with lifecycle and malware scanning. The local Compose database is intentionally unauthenticated and loopback-bound.
