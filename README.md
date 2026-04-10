# RCW Reader

A personal reading tracker for the [Revised Code of Washington](https://app.leg.wa.gov/RCW/). Scrape the full text of the RCW, then read through it section by section with progress tracking and full-text search.

## Overview

The project has two parts:

1. **`scrape.py`** — Downloads the full text of the RCW from the Washington State Legislature website into a local directory of `.txt` files.
2. **`server.ts`** — A Bun HTTP server that indexes those files into a SQLite database and serves a web UI for reading and tracking progress.

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
bun server.ts
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

## Features

- **Sequential reader** — Navigate section by section through the entire RCW. Mark each section as **read** or **skip** it.
- **Index** — Browse the full table of contents by title → chapter → section, with per-level read/skip progress bars.
- **Full-text search** — FTS5-powered search across all section headings and body text, with highlighted snippets.
- **Filtering** — Filter the index and search results by read state (all / unread / read / skipped).
- **Status cycling** — Click any status badge in the index to cycle it between unread → read → skipped without leaving the page.
- **Progress tracking** — A segmented progress bar shows read vs. skipped vs. unread across the entire corpus.

## Data model

Sections are stored in a SQLite database with FTS5 full-text search. Each section has an ID in cite format (`<title>/<chapter>/<section>`, e.g. `1/1.04/1.04.013`) and a read state of `unread`, `read`, or `skipped`.

Traversal order follows the natural sort order of the source directory (numerically sorted titles → chapters → sections).
