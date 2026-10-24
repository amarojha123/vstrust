# Environment and operations

Copy `.env.example` and supply independent random JWT/AI secrets before starting. Configuration is validated at startup; invalid configuration reports only field names.

| Variable | Purpose / default |
| --- | --- |
| NODE_ENV / PORT | development, test or production / 4000 |
| MONGODB_URI | Replica-set URI; default local rs0; authentication/TLS required in production |
| JWT_SECRET | Required, minimum 48 characters; rotate through a planned session invalidation |
| JWT_ISSUER / JWT_AUDIENCE | trust-mark / trust-mark-api |
| SESSION_TTL_SECONDS | 86400; range 300–2592000 |
| COOKIE_SECURE | false locally; must be true in production |
| APP_URL | Frontend base URL for email action links; HTTPS required in production |
| CORS_ORIGINS | Comma-separated exact frontend origins; HTTPS only in production |
| SMTP_URL / EMAIL_FROM | SMTP transport / noreply@trustmark.local; production requires SMTP |
| AI_SERVICE_URL | http://localhost:8000; internal service origin |
| AI_SERVICE_TOKEN | Required, minimum 32 characters; Python service must verify it |
| AI_TIMEOUT_MS / AI_MAX_RETRIES | 15000 per request / 2 bounded retries |
| STORAGE_PATH | ./private-storage; never exposed through express.static |
| MAX_UPLOAD_BYTES | 10485760 (10 MiB); maximum configurable 20 MiB |
| RUN_WORKER | true; false when running workers separately |
| JOB_POLL_MS / JOB_LEASE_MS | 1000 / 60000; shared Mongo queue with lease renewal |
| TRUST_PROXY_HOPS | 0; set exact trusted proxy count only behind a controlled proxy |
| RATE_LIMIT_MAX | 300 requests per minute per client IP |
| AUTH_RATE_LIMIT_MAX | 20 requests per 15 minutes per client IP |
| LOG_LEVEL | info; fatal/error/warn/info/debug/silent |

Production image runs as the unprivileged `node` user. Keep production secrets in the deployment secret manager, not Docker build arguments, repository files or logs. Use authenticated TLS MongoDB with transactions enabled. Configure API ingress HTTPS and body/time limits; limit network access to MongoDB, SMTP, private storage and the Python service. The Compose file is a development topology, with MongoDB/Mailpit bound to localhost.

Run `npm ci`, `npm run build`, `npm run start:indexes`, then `npm start`. The index command uses compiled JavaScript and also works in the production Docker image, which omits development dependencies. Workers run `npm run start:worker`; set RUN_WORKER=false on API instances. Workers share the same database and private storage. The local storage adapter requires a shared private persistent filesystem for multiple hosts; an object-storage implementation can replace the adapter. Do not run private storage as a public web volume.

`GET /health` checks process liveness. `GET /ready` performs a database ping with a deadline and returns 503 when unavailable. AI outages do not make the API unready; scan jobs retry separately. Monitor queued job age, failed job counts, scan/document failures, HTTP error rates, database capacity and worker logs. Correlation IDs propagate from requests to jobs and AI requests.

Jobs use bounded exponential backoff and expiring renewable leases. Completed jobs erase payloads; crashed final attempts are reaped and their resources marked failed. SMTP is at-least-once: an acknowledgement lost after delivery can produce a duplicate email. The AI must honor idempotency keys so retries do not create duplicate external scans.

Provider scans that remain queued/running are polled durably without consuming the transient failure budget, with an overall 30-minute deadline. Terminal failures update the job, linked resource and audit event in one transaction. Documents allow three manual retry cycles in addition to bounded automatic attempts. PDF/DOCX parsing runs in an isolated child process with a 30-second termination deadline, a 256 MiB V8 heap limit and a minimal environment that omits service secrets. Configure container memory limits to bound native allocations too. PDFs are limited to 200 pages, 100,000 characters per page and two million extracted characters. DOCX preflight rejects unsafe paths, encrypted/macro packages, excessive compression ratios, more than 2,000 ZIP entries or more than 50 MiB of declared decompressed data. Image-only PDFs need OCR outside this extraction adapter and fail safely when no text can be extracted.

SIGTERM/SIGINT stop accepting API traffic, finish active requests/jobs, and disconnect MongoDB with a bounded shutdown deadline. Configure at least 30 seconds of termination grace. API request/header timeouts are set explicitly. Back up MongoDB and private files, encrypt backups, test restore procedures and apply retention policy to append-only history.

CI runs type checking, integration tests against an ephemeral MongoDB replica set, a production build and a Docker build. The first test run needs network access to download MongoDB's binary; cache it in restricted/offline CI. Tests use a mock AI service and do not require actual Python service credentials.
