# Deploy

## Frontend (Vercel)

1. Root Directory: `apps/web`
2. Env: `NEXT_PUBLIC_API_URL` (= API public URL), `NEXT_PUBLIC_ALLOW_SIGNUP=false`
3. No backend on Vercel.

## Two URLs (easy to mix up)

| Env | What it is | Example hosted |
|---|---|---|
| `BETTER_AUTH_URL` | Public URL of the **API** | `https://api.example.com` |
| `WEB_ORIGIN` | Public URL of the **web app** | `https://app.vercel.app` |
| `NEXT_PUBLIC_API_URL` | Same as `BETTER_AUTH_URL` (for the browser) | `https://api.example.com` |

Local `localhost:3000` / `:3001` are only for `pnpm dev`. On Atlas + Vercel, replace both with HTTPS domains. Port 3000 inside Docker is just the process listen port — Dokploy proxies your domain to it; you do not need host port 3000 open.

## Backend — Atlas (Dokploy)

* Compose: `docker-compose.atlas.yml` (API only; your Postgres + MinIO)
* Image: `Dockerfile` + `deploy/docker-entrypoint.sh`

1. Import `docker-compose.atlas.yml`.
2. Paste local `.env` into Dokploy, then set:
   - `BETTER_AUTH_URL` / `WEB_ORIGIN` as above
   - `ALLOW_SIGNUP=false`, `AUTH_CROSS_ORIGIN=true`
   - `ENGINE_GIT_URL` (opensuite-engine git, build-time)
3. Point Dokploy domain at container port **3000**.
4. First user: briefly open signup, then lock.

`DATABASE_URL` / `MINIO_*` must be reachable from the container (not `localhost` unless host networking).

Entrypoint: `db:migrate` then API start.
