# OpenSuite Architecture

## System Boundaries

OpenSuite consists of two independent systems.

### `opensuite` (this repository)

Product/application repository. Owns:

* web
* API
* database
* users
* workspaces
* files
* versions
* conversations
* agent execution
* storage
* engine communication

### `opensuite-engine`

Independent Rust repository. Owns:

* Office file parsing
* document models
* typed mutations
* preservation
* validation
* diagnostics
* serialization
* rendering
* visual artifacts

The engine must remain useful independently of the OpenSuite product.

## Initial Product Layers

```text
Web
 ↓
API / Product Services
 ↓
Agent Core
 ↓
Engine Client
 ↓
OpenSuite Engine
```

Dependencies should flow downward.

Higher layers may orchestrate lower layers.

Lower layers should not know about higher-layer product concepts.

Agent Core responsibilities and its execution loop are documented separately in [`agent_core.md`](./agent_core.md).

## Repository Layout

This repository is a TypeScript monorepo managed with pnpm workspaces and Turborepo. The conceptual layers above map to concrete packages:

```text
apps/
  web/            # Web (UI layer)
  api/            # API / Product Services

packages/
  agent-core/     # Agent Core
  engine-client/  # Engine Client
  contracts/      # Shared types/schemas used across the layers above
  db/             # Persistence for users, workspaces, files, versions, conversations

docs/             # This documentation
```

`opensuite-engine` is not part of this repository; `packages/engine-client` is the sole integration point with it (see [`engine_integration.md`](./engine_integration.md)). See [`status.md`](./status.md) for what has actually been implemented.

## Tooling

* **Language:** TypeScript everywhere in this repository.
* **Package manager:** pnpm workspaces (`pnpm-workspace.yaml`).
* **Task runner:** Turborepo (`turbo.json`) for `build`/`dev`/`lint`/`typecheck`/`test` across packages.
* **Shared TS config:** `tsconfig.base.json` at the repo root, extended by each package.

The `dev` task declares `dependsOn: ["^build"]`. Without this, `pnpm dev` starts every package's persistent dev watcher in parallel with no ordering; on a cold start (no `dist/` yet — e.g. right after `git clone` or `pnpm install`, or after cleaning build output), `apps/api`'s `tsx watch src/server.ts` begins importing `@opensuite/db` before `packages/db`'s `tsc -w` has produced its first `dist/index.js`, crashing the API with `ERR_MODULE_NOT_FOUND` for a few seconds until the race resolves. `dependsOn: ["^build"]` runs a one-shot `build` of all workspace dependencies first, so the persistent watchers only start once `dist/` already exists.

## `apps/web`

The frontend is a **Next.js (App Router) + React + TypeScript** application, deployed on Vercel. It does not extend the repo's shared `tsconfig.base.json` — Next.js apps need `noEmit`, `jsx: "preserve"`, the `next` TS plugin, and their own build pipeline (`next build`/`next dev`, not `tsc` emit), which conflicts with the library-oriented `composite`/`declaration` settings the base config uses for `packages/*`. This is a deliberate, contained deviation, not an inconsistency.

Visual design comes directly from `opensuite_v4_modern_minimal.html` (the source of truth): its final "modern minimal refresh" color palette (paper `#F5F6F8`, ink `#14161A`, accent `#5B5CE2`, etc.), spacing, and Inter typography are captured as CSS custom properties and Tailwind v4 `@theme` tokens in `src/app/globals.css`, then reused via small hand-written UI primitives (`components/ui/button.tsx`, `input.tsx`, `label.tsx` — shadcn-style `cva` + `cn` conventions, not the shadcn CLI/Radix stack, to keep dependencies minimal) and shell components (`components/shell/topbar.tsx`, `sidebar.tsx`) that mirror the HTML's topbar/sidebar structure.

Routes: `/` (redirects based on session), `/sign-in`, `/sign-up` (centered auth card), and `/app` (authenticated shell — topbar + sidebar + a placeholder home screen that calls `GET /api/me`). Documents/workspaces/file browsing are not implemented; the sidebar is a static visual placeholder.

Authentication uses Better Auth's official React client (`better-auth/react` → `createAuthClient`), not a hand-rolled auth layer. `src/lib/auth-client.ts` configures `baseURL: NEXT_PUBLIC_API_URL` (apps/api's origin); `useSession()` drives client-side session restoration and route gating (`app/(auth)/layout.tsx` vs `app/app/layout.tsx`), and `signIn.email` / `signUp.email` / `signOut` drive the forms. `apps/web` and `apps/api` are always separate origins (different ports locally, different domains in production) — Better Auth's client already sends `credentials: "include"` by default, and apps/api's existing CORS (`origin: WEB_ORIGIN`, `credentials: true`) plus `trustedOrigins: [WEB_ORIGIN]` are what make cross-origin cookies work. `apps/web`'s own `GET /api/me` calls (`src/lib/api.ts`) must set `credentials: "include"` explicitly since they're plain `fetch`, not Better Auth client calls.

Local dev ports are fixed to match existing config rather than left to Next's default: `apps/web` runs on `:3001` (`next dev -p 3001`) to match the root `.env`'s `WEB_ORIGIN=http://localhost:3001`; `apps/api` runs on `:3000`. `apps/web/.env.local` (gitignored, `.env.example` committed) holds `NEXT_PUBLIC_API_URL`.

## `apps/api`

The backend API is a **Fastify** HTTP service, run as a **long-running Node process** (not a Vercel/edge function or serverless handler). It is developed and initially deployed on a home server, but must stay deployable to any environment that can run a Node process — no platform-specific runtime APIs. `apps/web`, in contrast, is deployed on Vercel; the two apps intentionally have different deployment models and must not be coupled to each other's runtime assumptions.

## `packages/db`

Persistence is **PostgreSQL**, accessed through **Drizzle ORM** with **Drizzle Kit** for migrations. Connection is configured exclusively via `DATABASE_URL` (a standard `postgresql://...` connection string) — no host-specific hardcoding, so contributors can point at any PostgreSQL instance. The package exposes `createDbClient`, `loadDatabaseConfig`, and `checkDatabaseConnection`; callers can use Drizzle's typed query API or raw SQL via `db.execute(sql`...`)` as needed.

Auth tables (`user`, `session`, `account`, `verification`) are generated by the **Better Auth CLI** into `packages/db/src/schema/auth.ts` and migrated via Drizzle Kit. Better Auth owns this schema — OpenSuite does not define competing user/session tables.

Passwords containing URL-special characters (`+`, `/`, etc.) must be **URL-encoded** in `DATABASE_URL`. The repo's custom `.env` loader preserves encoding as written (it does not URL-decode values).

Drizzle's Postgres migrator always issues `CREATE SCHEMA IF NOT EXISTS <schema>` for its migration-tracking table, which requires `CREATE` on the database itself (Postgres checks the privilege before the existence check, even with `IF NOT EXISTS`). `drizzle.config.ts` sets `migrations.schema: "public"` so this tracking table lives alongside application tables in `public` rather than provisioning a separate `drizzle` schema — the DB role still needs `CREATE` on the database (for that bootstrap statement) and `CREATE` on `public` (for actual tables). `drizzle-kit migrate` does not surface the underlying `pg` error on failure; run the migrator programmatically (`drizzle-orm/node-postgres/migrator`) to see the real cause when debugging.

### Product model

Product tables live in `packages/db/src/schema/product.ts` (separate from Better Auth's generated auth schema):

* `workspace` → owned by `user.id`
* `document` → belongs to a workspace (`docx` / `pptx` / `xlsx`)
* `document_version` → immutable byte snapshot referenced by object-storage `storage_key` (not a URL; bytes are not stored in Postgres)

There is no `current_version_id`. The latest version is the highest `version_number` for a document (`UNIQUE (document_id, version_number)`). Foreign keys use `ON DELETE RESTRICT` so history cannot be cascade-wiped; `created_by_user_id` uses `SET NULL`. Soft delete is via `deleted_at` on workspace/document only. Workspaces are not created during signup.

## Authentication

Authentication is handled by **Better Auth** in `apps/api`, using the Drizzle adapter backed by the shared `@opensuite/db` client (no second PostgreSQL pool). The handler is mounted at `/api/auth/*` per Better Auth's Fastify integration guide. Email/password, sessions, mandatory email verification, and password reset are enabled; OAuth is deferred.

Email verification is **mandatory and enforced server-side**: `emailAndPassword.requireEmailVerification: true`. Sign-up creates the user but never returns a session; sign-in for an unverified user fails with `403 { code: "EMAIL_NOT_VERIFIED" }`. Verification uses Better Auth's own signed, time-limited JWTs (`GET /api/auth/verify-email?token=...&callbackURL=...`) — no custom token table or logic. `callbackURL` must always be an absolute URL matching `WEB_ORIGIN`: Better Auth's `originCheck` middleware validates it against `trustedOrigins`, and on success it redirects to `callbackURL` verbatim (a relative path would resolve against `apps/api`'s own origin in the redirect, not `apps/web`'s).

Password reset uses Better Auth's official flow (`sendResetPassword`, `POST /request-password-reset`, `GET /reset-password/:token` → redirect with `?token=`, `POST /reset-password`). Responses are enumeration-safe. `revokeSessionsOnPasswordReset: true` invalidates existing sessions after a successful reset. The API does not auto-sign-in after reset — the user signs in with the new password.

Email delivery goes through a small provider-agnostic boundary in `apps/api/src/email/`: an `EmailSender` interface, a Resend-backed implementation (`createResendEmailSender`), and template renderers for verification and password-reset emails. `createAuth(config, db, emailSender)` takes the `EmailSender` as a parameter — Better Auth and the rest of the app depend only on the interface, never on the Resend SDK directly, and tests inject a stub that captures the message instead of calling the network.

Environment: `DATABASE_URL`, `BETTER_AUTH_SECRET` (≥32 chars), `BETTER_AUTH_URL` (API base URL), `WEB_ORIGIN` (Next.js frontend origin for CORS and trusted origins), `RESEND_API_KEY`, `EMAIL_FROM`.
