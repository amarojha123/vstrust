# Security controls and verification limits

Express owns identity, role checks, tenant scoping, CSRF/origin checks, rate limits, security headers, request validation, and audit persistence. AI requests are made only by the authorized backend worker with the published tenant snapshot. Python rejects missing or incorrect service credentials and validates evidence against request-scoped registries. Findings cannot approve content. Approval and rejection are separate backend actions with reviewer authorization and self-review restrictions.

Uploads are size-limited, stored outside the web root, hashed, and parsed in a worker. Content is plain text; clients must render text and suggestions as text, not unsanitized HTML. Logs omit request bodies and token values. Secrets belong in environment configuration or a production secret manager; `.env` must not be committed.

Repository tests cover auth, tenant behavior, content, approval workflow, AI response validation, queue behavior, and reporting security. This is not a complete independent security assessment. No automated browser security suite or full adversarial review of every export, role transition, upload parser, cache, and deployment edge has been completed. Production use needs a separate penetration test, production TLS, authenticated MongoDB, secret rotation, upload malware scanning, and monitored backups.
