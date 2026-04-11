import { RcwDatabase, type SectionRow } from "./database";

const RCW_DIR    = process.env.RCW_DIR    ?? "/rcw";
const STATE_FILE = process.env.STATE_FILE ?? "/data/rcw_reader_state.json"; // only used for one-time migration
const DB_FILE    = process.env.DB_FILE    ?? "/data/rcw.db";
const PORT       = Number(process.env.PORT ?? 3000);

const db = new RcwDatabase(DB_FILE);

// ── Startup ──────────────────────────────────────────────────────────────────

db.migrateFromJson(STATE_FILE); // no-op if already migrated or file absent
db.index(RCW_DIR);

// ── Sessions ──────────────────────────────────────────────────────────────────

interface Session { userId: number; username: string; }
const sessions = new Map<string, Session>();

function getSession(req: Request): Session | null {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match?.[1]) return null;
  return sessions.get(match[1]) ?? null;
}

function createSession(userId: number, username: string): string {
  const token = crypto.randomUUID();
  sessions.set(token, { userId, username });
  return token;
}

function deleteSession(req: Request): void {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (match?.[1]) sessions.delete(match[1]);
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

const baseStyle = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, serif; max-width: 960px; margin: 0 auto; padding: 2rem 1rem; color: #1a1a1a; }
  nav { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
  nav a { color: #226; text-decoration: none; }
  nav a:hover { text-decoration: underline; }
  nav .spacer { flex: 1; }
  nav .nav-user { color: #555; font-size: 0.85rem; }
  button { padding: 0.4rem 1rem; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer; font-size: 0.9rem; }
  button.primary { background: #2a5; color: #fff; border-color: #2a5; }
  button:hover { filter: brightness(0.93); }
  progress { width: 100%; height: 6px; margin-bottom: 1rem; }
  .meta { font-size: 0.8rem; color: #888; margin-bottom: 1.5rem; }
`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function navBar(username: string | null): string {
  const auth = username
    ? `<span class="nav-user">${esc(username)}</span><a href="/logout">Log out</a>`
    : `<a href="/login">Log in</a><a href="/signup">Sign up</a>`;
  return `<nav><a href="/">Reader</a><a href="/index">Index</a><span class="spacer"></span>${auth}</nav>`;
}

/**
 * Given an escaped section body, replace "RCW XX.YY.ZZZ" patterns with
 * hyperlinks. Looks up each cite in the DB to get its heading for the tooltip.
 */
function linkifyCites(escapedText: string, selfId: string): string {
  return escapedText.replace(
    /\bRCW\s+(\d+[A-Z]?\.\d+[A-Z]?\.\d+[A-Z]?)\b/g,
    (_match, cite: string) => {
      const parts = cite.split(".");
      const id = `${parts[0]}/${parts[0]}.${parts[1]}/${cite}`;
      if (id === selfId) return `RCW ${cite}`;
      const linked = db.getSection(id);
      const tooltip = linked?.heading ? ` data-tooltip="${esc(linked.heading)}"` : "";
      return `RCW <a class="rcw-ref" href="/section?cite=${encodeURIComponent(id)}"${tooltip}>${cite}</a>`;
    }
  );
}

function readerPage(section: SectionRow, username: string | null, userId: number | null): string {
  const s = db.getStats(userId);
  const pct = s.total > 0 ? ((s.read / s.total) * 100).toFixed(1) : "0.0";
  const cite = section.id;
  const name = cite.split("/").pop()!;
  const isGuest = userId === null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RCW ${esc(name)}</title>
<script>
// Resume guest position before any content renders (avoids flash)
if (${isGuest} && !location.search.includes('after=')) {
  var _last = localStorage.getItem('rcw_guest_last');
  if (_last) { window.location.replace('/?after=' + encodeURIComponent(_last)); }
}
</script>
<style>
  ${baseStyle}
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
  .header-text h1 { font-size: 1rem; color: #555; margin-bottom: 0.25rem; }
  .header-text h2 { font-size: 1.15rem; color: #1a1a1a; font-weight: 600; }
  .actions { display: flex; gap: 0.5rem; align-items: center; flex-shrink: 0; }
  pre { white-space: pre-wrap; font-family: Georgia, serif; line-height: 1.7; font-size: 1rem; }
  a.rcw-ref { color: #226; text-decoration: underline dotted; position: relative; }
  a.rcw-ref[data-tooltip]:hover::after {
    content: attr(data-tooltip);
    position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%);
    background: #1a1a1a; color: #fff;
    padding: 0.3rem 0.6rem; border-radius: 4px;
    font-size: 0.78rem; line-height: 1.4;
    white-space: normal; max-width: 280px; min-width: 120px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    pointer-events: none; z-index: 10;
  }
</style>
</head>
<body>
${navBar(username)}
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
<progress id="prog" value="${s.read}" max="${s.total}"></progress>
<p class="meta" id="meta">${s.read} read · ${s.skipped > 0 ? `${s.skipped} skipped · ` : ""}${s.unread} remaining · ${pct}% complete</p>
<pre>${linkifyCites(esc(section.text), cite)}</pre>
<script>
var IS_GUEST = ${isGuest};
var CITE = ${JSON.stringify(cite)};

function guestGetState() {
  try { return JSON.parse(localStorage.getItem('rcw_guest_state') || '{}'); } catch { return {}; }
}

async function act(action) {
  if (IS_GUEST) {
    var gs = guestGetState();
    gs[CITE] = action === 'read' ? 'read' : 'skipped';
    localStorage.setItem('rcw_guest_state', JSON.stringify(gs));
    localStorage.setItem('rcw_guest_last', CITE);
    window.location.href = '/?after=' + encodeURIComponent(CITE);
    return;
  }
  await fetch('/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cite: CITE })
  });
  window.location.href = '/';
}

// Update progress display for guests using localStorage
if (IS_GUEST) {
  var gs = guestGetState();
  var vals = Object.values(gs);
  var gRead = vals.filter(function(v) { return v === 'read'; }).length;
  var gSkipped = vals.filter(function(v) { return v === 'skipped'; }).length;
  var total = ${s.total};
  var gUnread = total - gRead - gSkipped;
  var gPct = total > 0 ? (gRead / total * 100).toFixed(1) : '0.0';
  document.getElementById('prog').value = gRead;
  document.getElementById('meta').textContent =
    gRead + ' read\u00B7 ' +
    (gSkipped > 0 ? gSkipped + ' skipped \u00B7 ' : '') +
    gUnread + ' remaining \u00B7 ' + gPct + '% complete';
}
</script>
</body>
</html>`;
}

function donePage(_username: string | null): string {
  const s = db.getStats(null);
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:4rem auto;text-align:center">
<h1>You've read the entire RCW.</h1>
<p style="margin-top:1rem;color:#555">${s.read} sections read · ${s.skipped} skipped</p>
<p style="margin-top:1rem"><a href="/index">View Index</a></p>
</body></html>`;
}

function authPage(title: string, action: string, error?: string): string {
  const isSignup = action === "/signup";
  const switchLink = isSignup
    ? `Already have an account? <a href="/login">Log in</a>`
    : `No account? <a href="/signup">Sign up</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — RCW</title>
<style>
  ${baseStyle}
  .auth-card { max-width: 360px; margin: 4rem auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 2rem; box-shadow: 0 2px 8px rgba(0,0,0,0.07); }
  .auth-card h1 { font-size: 1.3rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: 0.85rem; color: #555; margin-bottom: 0.25rem; }
  input[type=text], input[type=password] { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95rem; font-family: sans-serif; margin-bottom: 1rem; }
  input:focus { outline: none; border-color: #226; box-shadow: 0 0 0 3px rgba(34,34,102,0.1); }
  .error { color: #c00; font-size: 0.85rem; margin-bottom: 1rem; }
  .auth-footer { margin-top: 1rem; font-size: 0.85rem; color: #555; text-align: center; }
  button.full { width: 100%; padding: 0.55rem; font-size: 0.95rem; }
</style>
</head>
<body>
${navBar(null)}
<div class="auth-card">
  <h1>${esc(title)}</h1>
  ${error ? `<p class="error">${esc(error)}</p>` : ""}
  <form method="POST" action="${action}">
    <label for="username">Username</label>
    <input type="text" id="username" name="username" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="${isSignup ? "new-password" : "current-password"}" required>
    <button class="primary full" type="submit">${esc(title)}</button>
  </form>
  <p class="auth-footer">${switchLink}</p>
</div>
</body>
</html>`;
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const htmlResp = (body: string) =>
    new Response(body, { headers: { "Content-Type": "text/html" } });
  const jsonResp = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

  const session = getSession(req);
  const userId = session?.userId ?? null;
  const username = session?.username ?? null;

  const parts = url.pathname.split("/").map(decodeURIComponent);

  // ── Auth ───────────────────────────────────────────────────────────────────

  if (url.pathname === "/login") {
    if (req.method === "POST") {
      const form  = new URLSearchParams(await req.text());
      const uname = form.get("username")?.trim() ?? "";
      const pass  = form.get("password") ?? "";
      const user  = db.getUserByUsername(uname);
      if (!user || !(await Bun.password.verify(pass, user.passwordHash))) {
        return htmlResp(authPage("Log in", "/login", "Invalid username or password."));
      }
      const token = createSession(user.id, user.username);
      return new Response(null, {
        status: 302,
        headers: { "Location": "/", "Set-Cookie": `session=${token}; HttpOnly; SameSite=Strict; Path=/` },
      });
    }
    return htmlResp(authPage("Log in", "/login"));
  }

  if (url.pathname === "/signup") {
    if (req.method === "POST") {
      const form  = new URLSearchParams(await req.text());
      const uname = form.get("username")?.trim() ?? "";
      const pass  = form.get("password") ?? "";
      if (uname.length < 1)
        return htmlResp(authPage("Sign up", "/signup", "Username is required."));
      if (pass.length < 8)
        return htmlResp(authPage("Sign up", "/signup", "Password must be at least 8 characters."));
      if (db.getUserByUsername(uname))
        return htmlResp(authPage("Sign up", "/signup", "Username already taken."));
      const hash   = await Bun.password.hash(pass);
      const uid    = db.createUser(uname, hash);
      const token  = createSession(uid, uname);
      return new Response(null, {
        status: 302,
        headers: { "Location": "/", "Set-Cookie": `session=${token}; HttpOnly; SameSite=Strict; Path=/` },
      });
    }
    return htmlResp(authPage("Sign up", "/signup"));
  }

  if (url.pathname === "/logout") {
    deleteSession(req);
    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/login",
        "Set-Cookie": "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      },
    });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  if (url.pathname === "/api/stats") {
    return jsonResp(db.getStats(userId));
  }

  if (url.pathname === "/api/me") {
    if (!session) return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
    return jsonResp({ username: session.username });
  }

  // ── Full-text search ───────────────────────────────────────────────────────
  // GET /api/search?q=<query>[&filter=all|read|unread|skipped]
  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const filter = url.searchParams.get("filter") ?? "all";
    if (!q) return jsonResp([]);
    return jsonResp(db.search(q, filter, 100, userId));
  }

  // ── TOC ────────────────────────────────────────────────────────────────────
  // /api/toc                      → title list with stats
  // /api/toc/:title               → chapter list with stats
  // /api/toc/:title/:chapter      → section list with heading + state
  if (parts[1] === "api" && parts[2] === "toc") {
    const filter = url.searchParams.get("filter") ?? "all";
    const search = url.searchParams.get("search") ?? "";

    if (parts.length === 3) {
      return jsonResp(db.getTitleStats(filter, search, userId));
    }
    if (parts.length === 4) {
      return jsonResp(db.getChapterStats(parts[3]!, filter, search, userId));
    }
    if (parts.length === 5) {
      return jsonResp(db.getSectionList(parts[3]!, parts[4]!, filter, search, userId));
    }
  }

  // ── Status mutations ───────────────────────────────────────────────────────
  if (req.method === "POST" && (url.pathname === "/read" || url.pathname === "/skip")) {
    if (!userId) return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
    const { cite } = await req.json() as { cite?: string };
    if (cite) db.setState(cite, url.pathname === "/read" ? "read" : "skipped", userId);
    return jsonResp({ ok: true });
  }

  if (req.method === "POST" && url.pathname === "/set-status") {
    if (!userId) return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
    const { cite, status } = await req.json() as { cite?: string; status?: string };
    if (cite && ["unread", "read", "skipped"].includes(status ?? "")) {
      db.setState(cite, status as "unread" | "read" | "skipped", userId);
    }
    return jsonResp({ ok: true });
  }

  // ── Reader ─────────────────────────────────────────────────────────────────
  if (url.pathname === "/section") {
    const cite = url.searchParams.get("cite");
    if (!cite) return new Response("Not found", { status: 404 });
    const section = db.getSection(cite, userId);
    if (!section) return new Response("Not found", { status: 404 });
    db.nextUnread(cite, userId); // warm next
    return htmlResp(readerPage(section, username, userId));
  }

  if (url.pathname === "/index") {
    return new Response(Bun.file(import.meta.dir + "/public/index.html"));
  }

  if (url.pathname === "/") {
    // ?after= is used by guest readers to resume position or advance past a section
    const after = url.searchParams.get("after") ?? undefined;
    const cite = db.nextUnread(after, userId);
    if (!cite) return htmlResp(donePage(username));
    const section = db.getSection(cite, userId)!;
    db.nextUnread(cite, userId); // warm next
    return htmlResp(readerPage(section, username, userId));
  }

  return new Response("Not found", { status: 404 });
}

Bun.serve({ port: PORT, fetch: handle });
console.log(`Listening on http://localhost:${PORT}`);
