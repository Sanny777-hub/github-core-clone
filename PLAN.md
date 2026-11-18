# Git Forge Build Plan

One Node 22 process. No npm dependencies. No network calls. No `git` binary
on PATH. The store lives entirely in memory because the repo is mounted
read-only and only `/tmp` is writable; the trial runs a single process, so
nothing needs to survive a restart. `main.ts` is the lifecycle (bind an
ephemeral port, register the base URL with the harness via the env, then poll
`/done`) and must not be modified.

## Invariants

- **Auth**: every route except `GET /healthz` requires
  `Authorization: Bearer <token>`. A missing or wrong token is refused with
  HTTP 401 before any handler runs. The token is read once at boot (from env
  or the init artifacts) and compared with a constant-time check.
- **Store**: single in-memory `createStore()` instance owned by `app.ts`,
  injected into every layer. No layer reaches around it.
- **Single process**: the HTTP server, the smart-HTTP router, and the store
  all live in the one process; no child processes, no sockets beyond the one
  listener.

## Build Order

1. **store** — `lib/store.ts`: `createStore()` returning `repos` (a `Map`
   keyed by `owner/name`) plus the repo/issue/comment/label/pull methods.
   This is the only data layer; every other layer consumes it.
2. **REST** — GitHub REST v3 under `/api/v3/`: repositories, branches,
   commits, contents, issues, comments, labels, pull requests, files, merges.
   Thin handlers that translate HTTP into store calls and shape store records
   into GitHub-shaped JSON.
3. **GraphQL** — v4 at `POST /api/graphql`: `viewer`, `repository`, `issues`,
   mutations, plus introspection. Resolves fields over the same store; reuse
   the REST record shapes where possible.
4. **MCP** — at `POST /mcp`: `initialize`, `tools/list`, `tools/call`. The
   tool set mirrors the forge surface (repo, issue, PR operations) and talks
   to the store directly.
5. **git smart HTTP** — under `/<owner>/<repo>.git/`: `info/refs` and the
   `git-upload-pack` / `git-receive-pack` POSTs. Since there is no git binary
   and no repo on disk, the wire protocol is served from the store's branch
   and file state (refs advertise the store's branches; pack negotiation and
   object resolution read from the in-memory `files`/`branches` maps).
6. **auth** — the bearer middleware applied to all routes except `/healthz`,
   wired last so it can be installed across the whole router in one pass.
7. **local conformance runner** — a `test/` script that boots the server on
   an ephemeral port, drives each endpoint with a valid and an invalid token,
   and asserts the 401 / 200 / 4xx behavior and the store's responses.

## Acceptance Checks

- `GET /healthz` returns 200 with no token.
- Any other route with a missing or wrong token returns 401.
- REST create/list/update round-trips against the store.
- GraphQL query + mutation round-trip; introspection responds.
- MCP initialize, tools/list, and at least one tools/call succeed.
- Smart-HTTP `info/refs` returns advertised refs from the store's branches.
- All of the above run with a single Node 22 process, no network, no deps.
