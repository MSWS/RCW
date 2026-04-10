import { readdir, readFile } from "fs/promises";
import { join } from "path";

const RCW_DIR = process.env.RCW_DIR ?? "/rcw";
const STATE_FILE = process.env.STATE_FILE ?? "/data/rcw_reader_state.json";
const PORT = Number(process.env.PORT ?? 3000);

type SectionStatus = "unread" | "read" | "skipped";

interface State {
  sections: string[];
  status: Record<string, SectionStatus>;
}

let state: State = { sections: [], status: {} };
let cachedStats: { total: number; read: number; skipped: number; unread: number } | null = null;

// Hierarchical index: title → chapter → sections[]
const tocIndex = new Map<string, Map<string, string[]>>();

function getStats() {
  if (cachedStats) return cachedStats;
  let read = 0, skipped = 0;
  for (const v of Object.values(state.status)) {
    if (v === "read") read++;
    else if (v === "skipped") skipped++;
  }
  const total = state.sections.length;
  cachedStats = { total, read, skipped, unread: total - read - skipped };
  return cachedStats;
}

async function loadState(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    state = JSON.parse(raw);
  } catch {
    state = { sections: [], status: {} };
  }
  cachedStats = null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  cachedStats = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await Bun.write(STATE_FILE, JSON.stringify(state));
    saveTimer = null;
  }, 500);
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function buildIndex(): Promise<void> {
  const sections: string[] = [];
  tocIndex.clear();

  const titles = (await readdir(RCW_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(naturalSort);

  for (const title of titles) {
    const titlePath = join(RCW_DIR, title);
    const chapters = (await readdir(titlePath, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(naturalSort);

    const chapterMap = new Map<string, string[]>();
    tocIndex.set(title, chapterMap);

    for (const chapter of chapters) {
      const chapterPath = join(titlePath, chapter);
      const files = (await readdir(chapterPath))
        .filter((f) => f.endsWith(".txt"))
        .sort(naturalSort);

      const sectionCites: string[] = [];
      for (const file of files) {
        const cite = title + "/" + chapter + "/" + file.replace(".txt", "");
        sections.push(cite);
        sectionCites.push(cite);
      }
      chapterMap.set(chapter, sectionCites);
    }
  }

  const existingStatus = state.status;
  state.sections = sections;
  state.status = Object.fromEntries(
    sections.map((s) => [s, existingStatus[s] ?? "unread"])
  );
  cachedStats = null;

  await Bun.write(STATE_FILE, JSON.stringify(state));
  console.log(`Indexed ${sections.length} sections.`);
}

function countAll(cites: string[]): { read: number; skipped: number; unread: number; total: number } {
  let read = 0, skipped = 0, unread = 0;
  for (const cite of cites) {
    const s = state.status[cite];
    if (s === "read") read++;
    else if (s === "skipped") skipped++;
    else unread++;
  }
  return { read, skipped, unread, total: cites.length };
}

function hasMatch(cites: string[], filter: string, search: string): boolean {
  for (const cite of cites) {
    if (search && !cite.toLowerCase().includes(search)) continue;
    if (filter !== "all" && state.status[cite] !== filter) continue;
    return true;
  }
  return false;
}

const textCache = new Map<string, string>();
const TEXT_CACHE_MAX = 64;

async function getSectionText(cite: string): Promise<string> {
  if (textCache.has(cite)) return textCache.get(cite)!;
  const [title, chapter, section] = cite.split("/");
  const text = await readFile(join(RCW_DIR, title, chapter, `${section}.txt`), "utf-8");
  if (textCache.size >= TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value!);
  textCache.set(cite, text);
  return text;
}

function prefetchNext(currentCite: string) {
  const idx = state.sections.indexOf(currentCite);
  const next = state.sections.slice(idx + 1).find((s) => state.status[s] === "unread");
  if (next) getSectionText(next).catch(() => {});
}

function nextUnread(): string | null {
  return state.sections.find((s) => state.status[s] === "unread") ?? null;
}

function citeName(cite: string): string {
  return cite.split("/").pop() ?? cite;
}

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

function readerPage(cite: string, text: string): string {
  const s = getStats();
  const pct = ((s.read / s.total) * 100).toFixed(1);
  const name = citeName(cite);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RCW ${name}</title>
<style>
  ${baseStyle}
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
  h1 { font-size: 1.1rem; color: #555; }
  .actions { display: flex; gap: 0.5rem; }
  pre { white-space: pre-wrap; font-family: Georgia, serif; line-height: 1.7; font-size: 1rem; }
</style>
</head>
<body>
<nav><a href="/">Reader</a><a href="/index">Index</a></nav>
<header>
  <h1>RCW ${name}</h1>
  <div class="actions">
    <button onclick="act('skip')">Skip →</button>
    <button class="primary" onclick="act('read')">Mark Read ✓</button>
  </div>
</header>
<progress value="${s.read}" max="${s.total}"></progress>
<p class="meta">${s.read} read · ${s.skipped} skipped · ${s.unread} remaining · ${pct}% complete</p>
<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>
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
  const s = getStats();
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:4rem auto;text-align:center">
<h1>You've read the entire RCW.</h1>
<p style="margin-top:1rem;color:#555">${s.read} sections read · ${s.skipped} skipped</p>
<p style="margin-top:1rem"><a href="/index">View Index</a></p>
</body></html>`;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const htmlResp = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });
  const jsonResp = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

  const pathParts = url.pathname.split("/").map(decodeURIComponent);

  if (url.pathname === "/api/stats") {
    return jsonResp(getStats());
  }

  // TOC API: /api/toc, /api/toc/:title, /api/toc/:title/:chapter
  if (pathParts[1] === "api" && pathParts[2] === "toc") {
    const filter = url.searchParams.get("filter") ?? "all";
    const search = (url.searchParams.get("search") ?? "").toLowerCase();

    if (pathParts.length === 3) {
      const results = [];
      for (const [title, chapters] of tocIndex) {
        const all: string[] = [];
        for (const secs of chapters.values()) for (const s of secs) all.push(s);
        if (!hasMatch(all, filter, search)) continue;
        results.push({ title, ...countAll(all) });
      }
      return jsonResp(results);
    }

    if (pathParts.length === 4) {
      const chapterMap = tocIndex.get(pathParts[3]);
      if (!chapterMap) return new Response("Not found", { status: 404 });
      const results = [];
      for (const [chapter, sections] of chapterMap) {
        if (!hasMatch(sections, filter, search)) continue;
        results.push({ chapter, ...countAll(sections) });
      }
      return jsonResp(results);
    }

    if (pathParts.length === 5) {
      const chapterMap = tocIndex.get(pathParts[3]);
      if (!chapterMap) return new Response("Not found", { status: 404 });
      let sections = chapterMap.get(pathParts[4]);
      if (!sections) return new Response("Not found", { status: 404 });
      if (search) sections = sections.filter(c => c.toLowerCase().includes(search));
      if (filter !== "all") sections = sections.filter(c => state.status[c] === filter);
      return jsonResp(sections.map(c => [c, state.status[c]]));
    }
  }

  if (req.method === "POST" && (url.pathname === "/read" || url.pathname === "/skip")) {
    const { cite } = await req.json();
    if (cite && state.status[cite] !== undefined) {
      state.status[cite] = url.pathname === "/read" ? "read" : "skipped";
      scheduleSave();
    }
    return jsonResp({ ok: true });
  }

  if (req.method === "POST" && url.pathname === "/set-status") {
    const { cite, status } = await req.json();
    if (cite && ["unread", "read", "skipped"].includes(status) && state.status[cite] !== undefined) {
      state.status[cite] = status as SectionStatus;
      scheduleSave();
    }
    return jsonResp({ ok: true });
  }

  if (url.pathname === "/section") {
    const cite = url.searchParams.get("cite");
    if (!cite || state.status[cite] === undefined) return new Response("Not found", { status: 404 });
    const text = await getSectionText(cite);
    prefetchNext(cite);
    return htmlResp(readerPage(cite, text));
  }

  if (url.pathname === "/index") {
    return new Response(Bun.file("public/index.html"));
  }

  if (url.pathname === "/") {
    const cite = nextUnread();
    if (!cite) return htmlResp(donePage());
    const text = await getSectionText(cite);
    prefetchNext(cite);
    return htmlResp(readerPage(cite, text));
  }

  return new Response("Not found", { status: 404 });
}

await loadState();
await buildIndex();

Bun.serve({ port: PORT, fetch: handle });
console.log(`Listening on http://localhost:${PORT}`);
