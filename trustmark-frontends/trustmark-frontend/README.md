# Trust Mark frontend

From this directory, run `npm.cmd ci` and `npm.cmd run dev`. Open
`http://localhost:5173`. The default `/api/v1` base URL uses Vite's proxy to the
API on port 4000; `.env.example` contains the matching setting.

Signup requires a password of 12–128 characters. Successful registration moves
to login with email verification instructions. Follow the emailed verification
link, log in, then create an organization on the dashboard. Local development
uses the Mailpit inbox at `http://localhost:8025`; messages are captured there
rather than delivered to a real inbox. See the root README for service setup.

If you log in before verifying, organization setup shows verification steps,
the local inbox link during development, and actions to resend the email or
check verification status. Organization details remain in the form while you
verify in another tab. Opening the verification link refreshes the session;
signed-in users can continue straight to organization setup.

Run `npm.cmd run typecheck`, `npm.cmd run lint`, and `npm.cmd run build` for
frontend checks. With Vite running, the focused form regressions need no database:

```powershell
npm.cmd run test:auth
```

The full `npm.cmd run test:e2e` suite requires the backend and its database
fixtures. Role checks in the browser are for UX; the API enforces permissions.
