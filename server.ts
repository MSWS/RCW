import { join } from "path";
import { RcwDatabase, type SectionRow } from "./database";

const RCW_DIR  = process.env.RCW_DIR   ?? "/rcw";
const STATE_FILE = process.env.STATE_FILE ?? "/data/rcw_reader_state.json"; // only used for one-time migration
const DB_FILE  = process.env.DB_FILE   ?? "/data/rcw.db";
const PORT     = Number(process.env.PORT ?? 3000);

const db = new RcwDatabase(DB_FILE);

// ── Startup ──────────────────────────────────────────────────────────────────

db.migrateFromJson(STATE_FILE); // no-op if already migrated or file absent
db.index(RCW_DIR);

// ── HTML helpers ─────────────────────────────────────────────────────────────

const baseStyle = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, serif; max-width: 960px; margin: 0 auto; padding: 2rem 1rem; color: #1a1a1a; }
  nav { margin-bottom: 1.5rem; font-size: 0.9rem; }
  nav a { color: #226; text-decoration: none; margin-right: 1rem; }
  nav a:hover { text-decoration: underline; }
  button { padding: 0.4rem 1rem; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer; font-size: 0.9rem; }
  button.primary { background: #2a5; color: #fff; border-color: #2a5; }
  button:hover { filter: brightness(0.93); }
  progress { width: 100%; height: 6px; margin-bottom: 1rem; }
  .meta { font-size: 0.8rem; color: #888; margin-bottom: 1.5rem; }
`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readerPage(section: SectionRow): string {
  const s = db.getStats();
  const pct = ((s.read / s.total) * 100).toFixed(1);
  const cite = section.id;
  const name = cite.split("/").pop()!;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RCW ${esc(name)}</title>
<style>
  ${baseStyle}
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
  .header-text h1 { font-size: 1rem; color: #555; margin-bottom: 0.25rem; }
  .header-text h2 { font-size: 1.15rem; color: #1a1a1a; font-weight: 600; }
  .actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
  pre { white-space: pre-wrap; font-family: Georgia, serif; line-height: 1.7; font-size: 1rem; }
</style>
</head>
<body>
<nav><a href="/">Reader</a><a href="/index">Index</a></nav>
<header>
  <div class="header-text">
    <h1>RCW ${esc(name)}</h1>
    ${section.heading ? `<h2>${esc(section.heading)}</h2>` : ""}
  </div>
  <div class="actions">
    <button onclick="act('skip')">Skip →</button>
    <button class="primary" onclick="act('read')">Mark Read ✓</button>
  </div>
</header>
<progress value="${s.read}" max="${s.total}"></progress>
<p class="meta">${s.read} read · ${s.skipped} skipped · ${s.unread} remaining · ${pct}% complete</p>
<pre>${esc(section.text)}</pre>
<script>
async function act(action) {
  await fetch('/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cite: ${JSON.stringify(cite)} })
  });
  window.location.href = '/';
}
</script>
</body>
</html>`;
}

function donePage(): string {
  const s = db.getStats();
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:4rem auto;text-align:center">
<h1>You've read the entire RCW.</h1>
<p style="margin-top:1rem;color:#555">${s.read} sections read · ${s.skipped} skipped</p>
<p style="margin-top:1rem"><a href="/index">View Index</a></p>
</body></html>`;
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const htmlResp = (body: string) =>
    new Response(body, { headers: { "Content-Type": "text/html" } });
  const jsonResp = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

  const parts = url.pathname.split("/").map(decodeURIComponent);

  // ── Stats ──────────────────────────────────────────────────────────────────
  if (url.pathname === "/api/stats") {
    return jsonResp(db.getStats());
  }

  // ── Full-text search ───────────────────────────────────────────────────────
  // GET /api/search?q=<query>[&filter=all|read|unread|skipped]
  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const filter = url.searchParams.get("filter") ?? "all";
    if (!q) return jsonResp([]);
    return jsonResp(db.search(q, filter));
  }

  // ── TOC ────────────────────────────────────────────────────────────────────
  // /api/toc                      → title list with stats
  // /api/toc/:title               → chapter list with stats
  // /api/toc/:title/:chapter      → section list with heading + state
  if (parts[1] === "api" && parts[2] === "toc") {
    const filter = url.searchParams.get("filter") ?? "all";
    const search = url.searchParams.get("search") ?? "";

    if (parts.length === 3) {
      return jsonResp(db.getTitleStats(filter, search));
    }
    if (parts.length === 4) {
      return jsonResp(db.getChapterStats(parts[3], filter, search));
    }
    if (parts.length === 5) {
      return jsonResp(db.getSectionList(parts[3], parts[4], filter, search));
    }
  }

  // ── Status mutations ───────────────────────────────────────────────────────
  if (req.method === "POST" && (url.pathname === "/read" || url.pathname === "/skip")) {
    const { cite } = await req.json();
    if (cite) db.setState(cite, url.pathname === "/read" ? "read" : "skipped");
    return jsonResp({ ok: true });
  }

  if (req.method === "POST" && url.pathname === "/set-status") {
    const { cite, status } = await req.json();
    if (cite && ["unread", "read", "skipped"].includes(status)) {
      db.setState(cite, status);
    }
    return jsonResp({ ok: true });
  }

  // ── Reader ─────────────────────────────────────────────────────────────────
  if (url.pathname === "/section") {
    const cite = url.searchParams.get("cite");
    if (!cite) return new Response("Not found", { status: 404 });
    const section = db.getSection(cite);
    if (!section) return new Response("Not found", { status: 404 });
    // Fire-and-forget prefetch of next unread into SQLite page cache
    db.nextUnread(cite);
    return htmlResp(readerPage(section));
  }

  if (url.pathname === "/index") {
    return new Response(Bun.file("public/index.html"));
  }

  if (url.pathname === "/") {
    const cite = db.nextUnread();
    if (!cite) return htmlResp(donePage());
    const section = db.getSection(cite)!;
    db.nextUnread(cite); // warm next
    return htmlResp(readerPage(section));
  }

  return new Response("Not found", { status: 404 });
}

Bun.serve({ port: PORT, fetch: handle });
console.log(`Listening on http://localhost:${PORT}`);