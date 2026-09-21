# Deploy

## Frontend (Vercel)

1. Root Directory: `apps/web`
2. Env:
   - `NEXT_PUBLIC_API_URL` = public **API** URL (same as `BETTER_AUTH_URL`)
   - `NEXT_PUBLIC_ALLOW_SIGNUP=false`
3. **Do not** set `NEXT_PUBLIC_API_URL` to the Vercel web host (`https://opensuite.tech` / `www`). That host 308-redirects apex→www and is not the Fastify API. No trailing slash.

## Two URLs

| Env | What | Hosted example |
|---|---|---|
| `BETTER_AUTH_URL` | Public **API** URL | `https://api.opensuite.tech` |
| `WEB_ORIGIN` | Public **web** URL | `https://www.opensuite.tech` |
| `NEXT_PUBLIC_API_URL` | Same as `BETTER_AUTH_URL` | `https://api.opensuite.tech` |

Browser check (after API is routed): open `https://api.opensuite.tech/` → plain text `OpenSuite API`. Structured: `/health`.

## Backend — Atlas (Dokploy)

* Compose: `docker-compose.atlas.yml` (API only; your Postgres + MinIO)
* Image: `node:22-bookworm-slim` (glibc). Native `@opensuitehq/engine@0.1.1` — **not** Alpine/musl.
* Soft-boot: API starts even if the native binding fails to load (auth etc. work; DOCX disabled)

1. Import compose; paste `.env`; set production `BETTER_AUTH_URL` / `WEB_ORIGIN` / `ALLOW_SIGNUP=false` / `AUTH_CROSS_ORIGIN=true`
2. Proxy Dokploy domain → container port **3000** (DNS for `api.opensuite.tech` must hit this service, not Vercel)
3. Engine comes from npm via `packages/engine-client` → `@opensuitehq/engine@0.1.1` (no sibling repo, no vendor stub)

Entrypoint: migrate (programmatic, prints pg errors) then start. Rebuild after committing migration SQL — `0013`/`0014` must be in the image.

## Not Edge

`@opensuitehq/engine` is Node N-API only — used by `apps/api` through `@opensuite/engine-client`. Do not bundle into Vercel Edge, browsers, or the web app.
