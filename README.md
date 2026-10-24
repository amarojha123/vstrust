# TRUST MARK

TRUST MARK is a multi-tenant brand compliance product. The Express API owns authentication, tenant authorization, persistence, immutable content revisions, review decisions, and audit records. The Python service analyzes authorized content and returns advisory findings. The React frontend uses the API session cookie.

## Technology and architecture

- Web: React 18, TypeScript, Vite, React Query, Tailwind.
- API: Node.js 24, Express 5, TypeScript, MongoDB/Mongoose, Zod, durable MongoDB job queue.
- AI service: Python 3.11, FastAPI, Pydantic, deterministic analysis with optional LLM layers.
- Local infrastructure: Docker Compose, MongoDB replica set, Mailpit, Nginx.

See [architecture](docs/architecture.md) and [API details](docs/api.md). Existing paths are retained: `trustmark-frontends/trustmark-frontend`, root `src`, and `ai-service (1)/ai-service`.

## Prerequisites and configuration

Install Docker Desktop with Compose. Copy `.env.example` to `.env` and set independent random secrets for `JWT_SECRET` and `AI_SERVICE_TOKEN` (at least 48 and 32 characters). `AI_SERVICE_TOKEN` is shared by the API and AI container; do not commit `.env` or real provider keys. The default AI provider is mock for offline local use.

## Install and start

```powershell
npm.cmd ci
Copy-Item .env.example .env
# Generate independent values and place them in .env.
docker compose up --build
```

Open the web app at `http://localhost:3000`, API docs at `http://localhost:4000/docs`, and Mailpit at `http://localhost:8025`. The AI service is private to the Compose network. Native API development: `docker compose up -d mongodb mongo-init mailpit ai-service`, then `npm.cmd run dev`. Frontend development: in `trustmark-frontends/trustmark-frontend`, run `npm.cmd ci` and `npm.cmd run dev`; Vite proxies `/api` to port 4000.

For native Windows development without Compose's Mailpit, run
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-mailpit.ps1`.
The helper downloads a pinned official Mailpit release, verifies its SHA-256,
and starts a local inbox at `http://localhost:8025` with SMTP on port 1026.
Set `SMTP_URL=smtp://localhost:1026`, `APP_URL=http://localhost:5173`, and
`RUN_WORKER=true` in the root `.env`, then restart the API. The application URL
must match the frontend port so verification links return to the app. Local
verification messages appear in Mailpit instead of the recipient's real inbox.

## Demo workflow and current scope

Register an account, inspect the verification message in Mailpit, verify the email, log in, and create an organization through the API. Organization endpoints are under `/api/v1/organizations`; Swagger documents their payloads. The API supports brand knowledge, private document uploads, content revisions, compliance scans, findings, review decisions, analytics, notifications, exports, and audit events.

The browser implements registration, email verification, login, protected navigation, organization creation, and a dashboard backed by persisted analytics. Brand knowledge, content editing, scan findings/corrections, review queue, and settings pages remain placeholders; the full requested browser workflow is not yet implemented. Python scan jobs and retrieval data are in memory. Python code-point offsets are not yet converted to JavaScript UTF-16 offsets, so findings over non-BMP text require additional work before production.

## Verification commands

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:built
npm.cmd run openapi
```

Frontend commands from its directory: `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run build`. Python commands from the AI service directory after installing `requirements.txt`: `python -m pytest` and `python -m eval.run_eval`. See [testing](docs/testing.md) for actual scope and limitations.

## Operations and security

See [deployment](docs/deployment.md), [database and backup](docs/database.md), [security](docs/security.md), and [AI evaluation](docs/ai-evaluation.md). Compose is for local development; production requires authenticated managed MongoDB, HTTPS, explicit origins, secure cookies, secret management, durable AI task storage, and private persistent upload storage. Back up the database and uploads together.
