# Deploy

## Frontend (Vercel)

1. Root Directory: `apps/web`
2. Env: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ALLOW_SIGNUP=false`
3. No backend on Vercel.

## Backend — Atlas (Dokploy)

API-only compose (your existing Postgres + MinIO):

* Compose: `docker-compose.atlas.yml`
* Image: `Dockerfile` + `deploy/docker-entrypoint.sh`

1. Import `docker-compose.atlas.yml` in Dokploy.
2. Paste the same `.env` you use locally (Dokploy env UI), then set production URLs:
   - `WEB_ORIGIN` = Vercel HTTPS URL
   - `BETTER_AUTH_URL` = public API HTTPS URL
   - `ALLOW_SIGNUP=false`
   - `AUTH_CROSS_ORIGIN=true`
   - `ENGINE_GIT_URL` = opensuite-engine git URL (build-time)
3. `DATABASE_URL` / `MINIO_*` stay pointed at your existing services (reachable from the API container — not `localhost` unless you use host networking).
4. First user: temporarily `ALLOW_SIGNUP=true` (+ web flag), sign up, then lock.

Legacy `MINIO_ENDPOINT` + `MINIO_PORT` (+ `MINIO_USE_SSL`) are supported.

Entrypoint: `db:migrate` then API start.
