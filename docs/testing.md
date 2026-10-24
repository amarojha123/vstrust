# Testing and verification

Backend scripts: `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, `npm.cmd run smoke:built`, and `npm.cmd run openapi`. Tests use an ephemeral MongoDB replica set and mock AI HTTP responses. Python tests are under `ai-service (1)/ai-service/app/tests` and run with `pytest` in that directory after installing `requirements.txt`. Frontend checks are `npm.cmd run typecheck`, `npm.cmd run lint`, and `npm.cmd run build` in `trustmark-frontends/trustmark-frontend`.

The current frontend does not implement the full operational screens, so a Playwright end-to-end compliance workflow is not present. Existing backend integration tests exercise portions of registration, organization, content, scan, approval, and audit behavior directly over HTTP and MongoDB. Tests do not exercise a live LLM provider or production infrastructure.

## Integration verification performed

- Backend Vitest: 10 files, 92 tests passed.
- Compiled API smoke: passed 13 HTTP checks and the compiled PDF parser check.
- Backend TypeScript typecheck and production compilation: passed.
- Frontend TypeScript typecheck and Vite production build: passed. Rollup emitted removable `@__PURE__` annotation warnings from the installed Zod package.
- Python source compilation: passed.
- Python service: 95 pytest tests passed in a project-local Python 3.14 virtual environment. The deployment image targets Python 3.11; Docker image execution was unavailable locally.
- Docker Compose validation and container builds could not run because the Docker CLI is unavailable.
- Frontend ESLint did not run successfully: the package has ESLint 9 but no `eslint.config.*` flat configuration.
- Local live scan smoke: the React app, Express API, MongoDB replica set, Node worker, and FastAPI mock provider were started together. API/AI readiness, the frontend API proxy, and a real scan through Express → worker → FastAPI → persisted findings all passed. The scan returned two findings for the seeded terminology violation and unsupported fact claim.
