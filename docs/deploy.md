# Deploy

## Frontend (Vercel)

1. Import the repo (or `apps/web` only). Set **Root Directory** to `apps/web`.
2. Env:
   - `NEXT_PUBLIC_API_URL` = public HTTPS API URL
   - `NEXT_PUBLIC_ALLOW_SIGNUP` = `false` (match API `ALLOW_SIGNUP`)
3. Deploy. No backend runs on Vercel.

## Backend (Dokploy / Docker)

Files: `Dockerfile`, `docker-compose.yml`, `deploy/docker-entrypoint.sh`.

1. Import compose from repo root in Dokploy.
2. Set env (see compose comments). Critical:
   - `WEB_ORIGIN` = Vercel URL
   - `BETTER_AUTH_URL` = public API HTTPS URL
   - `BETTER_AUTH_SECRET` (≥32 chars)
   - `ALLOW_SIGNUP=false`
   - `AUTH_CROSS_ORIGIN=true` (Vercel ↔ API cookies; API must be HTTPS)
   - `ENGINE_GIT_URL` = git URL of `opensuite-engine` (linux N-API build)
3. First user: temporarily `ALLOW_SIGNUP=true` (+ web `NEXT_PUBLIC_ALLOW_SIGNUP=true`), sign up, verify email, then set both back to `false`.

Entrypoint runs `db:migrate` then starts the API.
