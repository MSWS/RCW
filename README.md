# RCW Reader

A personal reading tracker for the [Revised Code of Washington](https://app.leg.wa.gov/RCW/). Scrape the full text of the RCW, then read through it section by section with progress tracking, full-text search, and multi-user accounts.

---

> **AI-generated codebase.** The vast majority of this project's code was written by [Claude](https://claude.ai) (Anthropic). The human author directed the design, reviewed the output, and made targeted edits — but most lines were produced by an AI assistant. Treat it accordingly.

---

## Overview

The project has two parts:

1. **`scrape.py`** — Downloads the full text of the RCW from the Washington State Legislature website into a local directory of `.txt` files.
2. **`src/server.ts`** — A Bun HTTP server that indexes those files into a SQLite database and serves a web UI for reading and tracking progress.

## Setup

### 1. Scrape the RCW

Requires Python 3 with `requests` and `beautifulsoup4`.

```sh
pip install requests beautifulsoup4
python scrape.py
```

This populates `./rcw/<title>/<chapter>/<section>.txt`. The scraper is resumable — re-running it skips already-downloaded sections.

### 2. Run the server

Requires [Bun](https://bun.sh).

```sh
bun src/server.ts
```

The server indexes the `./rcw` directory on startup (new sections only; safe to restart). Open [http://localhost:3000](http://localhost:3000) to start reading.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `RCW_DIR` | `/rcw` | Path to the scraped RCW text files |
| `DB_FILE` | `/data/rcw.db` | Path to the SQLite database |
| `STATE_FILE` | `/data/rcw_reader_state.json` | Legacy JSON state file (one-time migration only) |
| `PORT` | `3000` | HTTP port |

## Docker / Compose

```sh
docker compose up -d
```

The compose file expects:
- `./rcw/` — scraped RCW text (read-only mount)
- `./data/` — persistent database storage

The server is exposed on port 3000 and attached to `local` and `cloudflared` external Docker networks.

Images are published to the container registry on every push to `main` (tagged `:latest`) and `dev` (tagged `:dev`).

## Features

- **Sequential reader** — Navigate section by section through the entire RCW. Mark each section as **read** or **skip** it. Cross-referenced RCW citations are hyperlinked with hover tooltips showing the referenced section heading.
- **Index** — Browse the full table of contents by title → chapter → section, with per-level read/skip progress bars and filtering by state.
- **Full-text search** — FTS5-powered search across all section headings and body text, with highlighted snippets. Also supports direct section-number lookup (e.g. `69.50.401`).
- **Multi-user accounts** — Each user has isolated progress. Sign up with a username and password; sessions are stored server-side with `HttpOnly` cookies.
- **Guest mode** — Visitors without an account can still read and track progress; state is stored in `localStorage` and persists across sessions in the same browser.
- **Account management** — Change username or password, or reset all reading progress (requires password confirmation).
- **Rate limiting** — Login attempts are rate-limited to 10 failures per 15-minute window per IP. All auth events are logged in a fail2ban-compatible format.
- **About page** — Accessible via the footer; explains the project and links to source and donation page.

## Security

Auth events are written to stdout in a structured format suitable for fail2ban monitoring:

```
2025-01-01T00:00:00.000Z [FAIL] LOGIN_FAIL ip=1.2.3.4 user=alice
2025-01-01T00:00:00.000Z [WARN] LOGIN_BLOCKED ip=1.2.3.4 rate limited
```

A fail2ban filter can match `\[FAIL\] LOGIN_FAIL` or `\[WARN\] LOGIN_BLOCKED` lines on the configured log path.

## Data model

Sections are stored in a SQLite database with FTS5 full-text search. Each section has an ID in cite format (`<title>/<chapter>/<section>`, e.g. `1/1.04/1.04.013`).

User progress is tracked in a `user_section_state` table — only non-unread rows are stored (absent row = unread). Guest progress uses the same `unread`/`read`/`skipped` states, stored client-side in `localStorage`.

## Tests

```sh
bun test src/
```

Unit tests cover database indexing, user management, state isolation, search, and traversal. Tests run automatically in CI on every push to `main` or `dev`.
