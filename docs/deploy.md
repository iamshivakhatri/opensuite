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

## Backend — home server behind Cloudflare Tunnel

* Compose: `docker-compose.atlas.yml` (API only; your private Postgres + MinIO)
* Image: `node:22-bookworm-slim` (glibc). Native `@opensuitehq/engine@0.1.1` — **not** Alpine/musl.
* Soft-boot: API starts even if the native binding fails to load (auth etc. work; DOCX disabled)

1. Set `BETTER_AUTH_URL=https://api.opensuite.tech`, `WEB_ORIGIN=https://www.opensuite.tech`, `ALLOW_SIGNUP=false` (unless actively admitting testers), and `AUTH_CROSS_ORIGIN=false`. Production refuses HTTP for the two public URLs. Private S3/MinIO endpoints may remain HTTP.
2. Configure Cloudflare Tunnel so `api.opensuite.tech` reaches container port **3000**. Do not publish the API port directly; DNS for `api.opensuite.tech` must not point to Vercel.
3. Engine comes from npm via `packages/engine-client` → `@opensuitehq/engine@0.1.1` (no sibling repo, no vendor stub)

Entrypoint: migrate (programmatic, prints pg errors) then start. Rebuild after committing migration SQL — `0013`/`0014` must be in the image.

## Alpha abuse limits

The API has process-local authenticated limits keyed by OpenSuite user ID: agent runs 10/hour and 40/day; document or version uploads 20/hour; workspace creation 10/day. They reset when the API restarts and are appropriate only while this is one API instance.

At Cloudflare, add anonymous limits before traffic reaches the tunnel: sign-up 5/IP/hour, sign-in 10/IP/15 minutes, password reset 5/IP/hour, and verification resend 5/IP/hour. Do not pass Cloudflare client-IP headers to Fastify or use them for API authorization/rate limits.

No generic CSRF middleware is needed for the current `www.opensuite.tech` + `api.opensuite.tech` same-site cookie setup. Keep CORS restricted to `WEB_ORIGIN`; reassess if the frontend/API become cross-site.

## Not Edge

`@opensuitehq/engine` is Node N-API only — used by `apps/api` through `@opensuite/engine-client`. Do not bundle into Vercel Edge, browsers, or the web app.
