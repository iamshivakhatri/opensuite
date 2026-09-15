# Deploy

## Frontend (Vercel)

1. Root Directory: `apps/web`
2. Env: `NEXT_PUBLIC_API_URL` (= API public URL), `NEXT_PUBLIC_ALLOW_SIGNUP=false`

## Two URLs

| Env | What | Hosted example |
|---|---|---|
| `BETTER_AUTH_URL` | Public **API** URL | `https://api.opensuite.tech` |
| `WEB_ORIGIN` | Public **web** URL | `https://www.opensuite.tech` |
| `NEXT_PUBLIC_API_URL` | Same as `BETTER_AUTH_URL` | `https://api.opensuite.tech` |

## Backend — Atlas (Dokploy)

* Compose: `docker-compose.atlas.yml` (API only; your Postgres + MinIO)
* Soft-boot: API starts even without a native DOCX engine (auth etc. work; DOCX disabled)

1. Import compose; paste `.env`; set production `BETTER_AUTH_URL` / `WEB_ORIGIN` / `ALLOW_SIGNUP=false` / `AUTH_CROSS_ORIGIN=true`
2. Proxy Dokploy domain → container port **3000**
3. Engine:
   - Default build uses in-repo stub (`USE_PUBLISHED_ENGINE=false`) — no DOCX
   - Publish `@opensuite/engine` from `opensuite-engine` (see `crates/opensuite-node/PUBLISH.md`), then rebuild with `USE_PUBLISHED_ENGINE=true`

Local dev keeps sibling engine via root `pnpm.overrides` → `link:../opensuite-engine/crates/opensuite-node`.

Entrypoint: migrate then start.
