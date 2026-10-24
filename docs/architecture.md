# TRUST MARK architecture

## Current repository map

- `src/` is the Express 5 and TypeScript API, MongoDB/Mongoose persistence layer, tenant authorization, durable MongoDB job queue, audit log, and API-to-AI adapter.
- `trustmark-frontends/trustmark-frontend/` is the React 18, Vite, and TypeScript browser app. Login, registration, protected routing, and persisted dashboard metrics are implemented. Content, brand, analytics, review, and settings routes are still placeholders.
- `ai-service (1)/ai-service/` is the FastAPI analysis service. It owns deterministic rules/fact analysis, optional LLM analysis, evidence validation, injection signals, and retrieval components. It does not own users, approvals, or application records.
- `compose.yaml` supplies MongoDB replica-set initialization, Mailpit, API, worker, AI service, and web server for local development.

The existing structure is retained to avoid moving source trees and breaking established scripts. The intended logical boundary is `apps/web`, `apps/api`, `apps/ai-service`, and `packages/contracts`; a physical monorepo migration is not required for runtime integration and remains future maintenance work.

## Runtime flow

The browser calls same-origin `/api/v1` with an HTTP-only session cookie. Nginx proxies that path to Express. Express verifies the session, membership, role, CSRF/origin policy, and tenant ID before reading tenant-scoped data. Scan initiation snapshots published knowledge, stores a scan and durable job in a MongoDB transaction, and the worker sends the immutable content revision and snapshot to FastAPI over the private Compose network. FastAPI checks service authentication, performs analysis, and holds a bounded in-memory task result. The worker polls it and validates every finding, range, rule reference, and evidence quote against the exact revision and snapshot before persistence. Only a human review endpoint can approve a revision.

## Contracts and trust boundaries

The canonical scan request and result validation are TypeScript Zod schemas in `src/integrations/ai/contracts.ts`. FastAPI validates its native analysis request and its scan compatibility request with Pydantic. Text offsets are zero-based JavaScript UTF-16 code units; Python offsets are Unicode code points, so non-BMP text offsets require adapter normalization before persistence. The present adapter has not yet normalized those offsets; do not treat emoji-containing finding offsets as production safe.

MongoDB is required as a replica set because business mutations use transactions. The API and worker are separate Compose processes sharing a private storage volume. AI tasks and the vector store are currently in memory; AI task results can be lost on AI container restart. Use an external durable task/result store and tenant-partitioned vector database before production workloads.
