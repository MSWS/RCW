# RCW Reader — Claude guidance

## Project overview

RCW Reader is a Bun + TypeScript HTTP server for reading the Revised Code of Washington. It uses SQLite (via `bun:sqlite`) for storage and serves server-rendered HTML. There is no frontend framework — UI is plain HTML/JS/CSS.

## Stack

- **Runtime**: Bun (test runner, SQLite, password hashing, HTTP server)
- **Language**: TypeScript (server); vanilla JS (client)
- **Database**: SQLite via `bun:sqlite`
- **Tests**: `bun test` — files named `*.test.ts`

## Key files

| File | Purpose |
|------|---------|
| `src/database.ts` | All DB schema, queries, and mutations |
| `src/server.ts` | HTTP handler, HTML rendering, API routes |
| `src/database.test.ts` | Unit tests for the DB layer |
| `src/server.test.ts` | Integration tests via `createHandler` |
| `src/public/index.html` | Interactive index/TOC — pure client-side JS, no build step |

## Architecture notes

- **Auth**: session cookie (`HttpOnly`, `SameSite=Strict`). Session data lives in an in-memory map.
- **Guest users**: No account needed. State is stored in `localStorage` (`rcw_guest_state`, a `Record<cite, ReadState>`). The server always returns `unread` for unauthenticated requests.
- **Per-user state**: `user_section_state` table — only non-`unread` rows are stored (absent = unread). Uses `COALESCE(uss.state, 'unread')` in queries.
- **Citation format**: `<title>/<chapter>/<section>` — e.g. `1/1.04/1.04.013`.
- **Bulk operations**: `setTitleState` / `setChapterState` in `database.ts`. Skipping only touches unread sections; un-skipping only touches skipped sections (read is never downgraded by bulk ops).

## Feature parity rule

**Guest users must have feature parity with authenticated users**, except for features that are inherently account-specific (login, logout, signup, account settings, password reset). Features like reading progress, skipping, and filtering must work for both guests (localStorage) and authenticated users (server-side DB).

## Bulk skip behaviour

- Skipping a title/chapter: marks all currently-`unread` sections as `skipped`. Already-`read` sections are untouched.
- Un-skipping: only clears `skipped` rows; `read` sections are never downgraded to `unread`.
- `allowMarkRead` flag (default `false`) gates whether bulk `read` is accepted at all.
- Server endpoint: `PATCH /api/toc/:title` and `PATCH /api/toc/:title/:chapter` — accepts `{ state: "skipped"|"unread" }`. Rejects `state=read` unless the method is called with `allowMarkRead=true` (not currently exposed via the API).

## Running tests

```bash
bun test src/
```

## Coding conventions

- Keep server-side HTML rendering in `server.ts` as template-literal functions.
- Client JS in `index.html` uses `var` / old-style functions (no ES6 modules, no bundler).
- SQL queries use positional `?` parameters; never interpolate user input.
- Do not add comments unless logic is non-obvious.
- Do not add error handling for scenarios that cannot happen.
