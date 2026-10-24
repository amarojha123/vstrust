# Authentication and authorization

Passwords use Argon2id with a unique salt, 19 MiB memory, two iterations and one lane. Parameters follow the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Account email is normalized and unique. Registration queues a one-time verification email, and tenant access requires verification.

Login issues an HS256 JWT with `sub` (user), `sid` (session), issuer, audience and expiry. The database stores a SHA-256 hash of the full JWT and CSRF secret. Every protected request verifies the JWT signature and claims, then checks session expiry/revocation and active user status. Role and organization authority come from current database memberships, never JWT role claims. Logout revokes the current session; password reset revokes all sessions. Session deletion is scoped to its owner.

Browser cookie: `tm_session`, HttpOnly, SameSite=Lax, Secure in production, host-only and Path=/. The `tm_csrf` cookie is readable by the frontend. For browser writes, copy its value to `X-CSRF-Token`; the backend checks header/cookie equality and the server-side hash. Use `credentials: 'include'` on fetch. The configured frontend origins are the only allowed credentialed CORS origins; disallowed and cross-site mutations are rejected. SameSite=Lax assumes a same-site frontend/API deployment. Use a reverse proxy on the same site for production.

Bearer clients send `Authorization: Bearer <jwt>`. They must keep the token confidential; bearer credentials are not ambient cookies and do not require CSRF headers. Use cookie sessions for browsers whenever practical. Action tokens are high-entropy opaque values, hashed in MongoDB, expiring and single-use. Email action links are consumed by the frontend, which POSTs the token in JSON; credentials do not belong in API query strings.

| Capability | Admin | Creator | Reviewer / Brand Manager | Auditor |
| --- | --- | --- | --- | --- |
| Read brand, documents, content | yes | yes | yes | yes |
| Invite/manage members and roles | yes | no | no | no |
| Manage brand/knowledge/documents | yes | no | yes | no |
| Create/edit drafts, decide findings, start scans | yes | yes | yes | no |
| Make review/approval decisions | yes | no | yes | no |
| Read analytics | yes | no | yes | yes |
| Read audit history | yes | no | no | yes |
| Export content | yes | no | yes | yes |
| Create evaluation summaries | yes | no | no | no |

Even an administrator cannot approve their own content. Approval requires a different person from the original author, the current revision's editor and the submitter. Changes requests and rejection decisions still require review permission. All organization-scoped endpoints resolve the URL organization against current active membership. Foreign resource IDs return 404; supplied organization IDs/roles/states are rejected by strict input schemas. Last-administrator changes are serialized by a transaction. Invitations are bound to the recipient's verified email and cannot grant access merely by possessing another person's link.

Structured logs omit request bodies, cookies, authorization headers and provider payloads. Audit metadata is restricted to structural fields and contains no content bodies or credentials. Errors contain a stable code, safe message and correlation ID; stacks and driver/provider messages are not returned.

## Implemented authentication flow

All routes below start with `/api/v1`. Successful JSON responses use a `data` envelope.

1. `POST /auth/register` accepts `{ "name": "Name", "email": "user@example.com", "password": "at-least-12-characters" }`, creates an unverified account, and queues a verification email. Registration does not create a session. Passwords must contain 12–128 characters and are stored as Argon2id hashes with 19 MiB memory, two iterations, and parallelism one.
2. The email links to the frontend `/verify-email?token=...` page. The frontend submits `{ "token": "..." }` to `POST /auth/verify-email`. Tokens expire after 24 hours and can be consumed only once. `POST /auth/resend-verification` is a public endpoint accepting `{ "email": "user@example.com" }`; it returns a generic `202` response and invalidates earlier unused verification tokens when it issues a replacement.
3. `POST /auth/login` accepts email and password. The response is `{ "data": { "user": { "id": "...", "email": "...", "name": "...", "emailVerified": true }, "accessToken": "...", "csrfToken": "...", "expiresAt": "..." } }` (the user also has `createdAt`). The JWT uses HS256, a user subject, a session ID, configured issuer/audience, and the configured session lifetime. A database session stores hashes of the JWT and CSRF value. Authentication validates both the JWT and the live, unrevoked database session.
4. Login sets `tm_session` as an HttpOnly cookie and `tm_csrf` as a JavaScript-readable cookie. Both use `SameSite=Lax`, path `/`, the configured secure-cookie policy, and the session expiry. Cookie clients send credentials and copy `tm_csrf` into the `X-CSRF-Token` header on authenticated mutations. The submitted header/cookie must match the CSRF hash stored for that session. Bearer clients send `Authorization: Bearer <accessToken>`.
5. `GET /auth/me` returns the current public user and active organization memberships. Unverified accounts may authenticate and inspect their own account, but organization access, organization creation, and invitation acceptance require email verification. Protected organization routes resolve current membership and permissions on the server; removed memberships lose access without waiting for JWT expiry.
6. `POST /auth/refresh` requires authentication and rotates the current session. It returns a new access token, CSRF token, and expiry and replaces both cookies. The previous access token becomes invalid immediately. `POST /auth/logout` revokes the current database session, clears both cookies, and returns `204`.
7. `GET /auth/sessions` lists up to 100 active sessions belonging to the current user, including `id`, `current`, `createdAt`, and `expiresAt`. `DELETE /auth/sessions/:sessionId` revokes only a session belonging to that user; revoking the current session also clears its cookies. Session identifiers are not credentials, and another user's session cannot be revoked through this endpoint.

`POST /auth/forgot-password` accepts an email and always returns the same generic `202` message for existing and unknown accounts. Its email links to the frontend `/reset-password?token=...` page. The frontend submits `{ "token": "...", "password": "new-password-at-least-12-characters" }` to `POST /auth/reset-password`. Reset tokens expire after 30 minutes and are single use. A successful reset replaces the password hash, revokes all current sessions, invalidates other unused reset tokens, and clears the browser cookies. The user must sign in again. Reset and verification tokens are never returned by these APIs; queued email payloads are private and are removed after delivery or terminal job failure.

Organization administrators invite members with `POST /organizations/:organizationId/invitations` and a body containing `email` and `role` (`admin`, `creator`, `reviewer`, or `auditor`). The invitation email links to the frontend `/accept-invitation?token=...` page; the verified recipient submits the token to `POST /organizations/invitations/accept`. Acceptance is bound to the authenticated user's email and to an active organization. Invitations expire after seven days and cannot be reused or accepted after revocation. Existing active memberships are not overwritten by invitation acceptance. Member role changes and removals require current administrator membership and run in serialized transactions that preserve at least one active organization administrator.
