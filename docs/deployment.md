# Local and production deployment

## Local Compose

1. Copy `.env.example` to `.env`.
2. Generate independent random values for `JWT_SECRET` and `AI_SERVICE_TOKEN` (at least 48 and 32 characters respectively).
3. Run `docker compose up --build`.
4. Open `http://localhost:3000`; API docs are at `http://localhost:4000/docs`; Mailpit is at `http://localhost:8025`.

Compose starts a single-node MongoDB replica set, API, durable worker, mock-provider AI service, and web container. The AI service is not published on a host port. Local MongoDB and Mailpit are for development only.

## Production requirements

Build and deploy the three Dockerfiles independently. Configure a managed authenticated MongoDB replica set, TLS ingress, exact HTTPS CORS origins, secure cookies, SMTP, durable private object storage, secrets manager, and external monitoring. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, explicit HTTPS `APP_URL` and `CORS_ORIGINS`, and matching independently rotated backend/AI service credentials. Run database indexes before directing traffic. Provide an AI durable task store and production vector store before relying on scans at scale. The included Compose file is a local development topology, not a hardened production deployment manifest.

Back up MongoDB and private uploads together, encrypt backups, retain recovery keys separately, and regularly test restore procedures. MongoDB-only backups are insufficient for uploaded source files.
