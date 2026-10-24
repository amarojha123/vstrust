# API overview

The Express API serves `/api/v1/openapi.json` and Swagger UI at `/docs`. Tenant endpoints use `/api/v1/organizations/:organizationId`; successful API resources use `{data: ...}`, lists include pagination, and errors use `{error:{code,message,correlationId}}`. Send `X-Correlation-ID` to trace a request. Cookie-authenticated mutations require CSRF protection and valid origin checks.

## Browser

The web app defaults to same-origin `/api/v1`. The local Vite server proxies `/api` to port 4000; the Compose Nginx server proxies to the `api` service. Browser requests include credentials so the HTTP-only session cookie is sent.

## Internal scan bridge

Express sends `Authorization: Bearer <AI_SERVICE_TOKEN>`, `X-Correlation-ID`, and `Idempotency-Key` to FastAPI. FastAPI accepts the bearer form and its native `X-Service-Token` form. The scan payload carries `organizationId`, an immutable content revision, and the published knowledge snapshot. Poll requests carry `organizationId` in the query, and FastAPI hides tasks from other organizations. The bridge maps the snapshot into Pydantic rule, fact, and approved chunk types, and maps results to the strict Zod response schema.

Analysis tasks currently live in memory in the AI process. A restart can discard results and permit work to be repeated; the Node queue remains durable and retries transient failures. The AI task store needs persistence and expiry policy before production deployment. The bridge currently maps terminology rules and approved facts; the brand profile is not yet converted to an AI tone profile.

See [the existing detailed API contract](API.md) for authentication, lifecycle, pagination, revision, and analytics semantics.
