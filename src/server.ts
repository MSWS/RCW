import { RcwDatabase, type SectionRow, sectionNumToId, idToSectionNum } from "./database";
import { execSync } from "child_process";

const GIT_BRANCH = (() => {
  try { return execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "unknown"; }
})();

const GIT_HASH = (() => {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "unknown"; }
})();

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level: "INFO" | "WARN" | "FAIL", event: string, detail: string, req?: Request): void {
  const ts = new Date().toISOString();
  const ip = (req?.headers.get("X-Forwarded-For")?.split(",")[0] ?? req?.headers.get("X-Real-IP") ?? "unknown").trim();
  console.log(`${ts} [${level}] ${event} ip=${ip} ${detail}`);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const RATE_MAX_FAILS = 10;       // exported for tests

interface RateEntry { count: number; windowStart: number; }

function makeRateLimiter() {
  const map = new Map<string, RateEntry>();

  function key(req: Request): string {
    return (req.headers.get("X-Forwarded-For")?.split(",")[0] ?? req.headers.get("X-Real-IP") ?? "unknown").trim();
  }
  return {
    isLimited(req: Request): boolean {
      const entry = map.get(key(req));
      if (!entry || Date.now() - entry.windowStart > RATE_WINDOW_MS) return false;
      return entry.count >= RATE_MAX_FAILS;
    },
    recordFail(req: Request): void {
      const k = key(req);
      const now = Date.now();
      const entry = map.get(k);
      if (!entry || now - entry.windowStart > RATE_WINDOW_MS) map.set(k, { count: 1, windowStart: now });
      else entry.count++;
    },
    clear(req: Request): void { map.delete(key(req)); },
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────────

interface Session { userId: number; username: string; }

function makeSessions() {
  const map = new Map<string, Session>();

  function tokenFrom(req: Request): string | null {
    const match = (req.headers.get("Cookie") ?? "").match(/(?:^|;\s*)session=([^;]+)/);
    return match?.[1] ?? null;
  }
  return {
    get(req: Request): Session | null { const t = tokenFrom(req); return t ? (map.get(t) ?? null) : null; },
    create(userId: number, username: string): string {
      const token = crypto.randomUUID();
      map.set(token, { userId, username });
      return token;
    },
    update(req: Request, data: Partial<Session>): void {
      const t = tokenFrom(req);
      if (t) { const s = map.get(t); if (s) map.set(t, { ...s, ...data }); }
    },
    delete(req: Request): void { const t = tokenFrom(req); if (t) map.delete(t); },
  };
}

// ── Handler factory ───────────────────────────────────────────────────────────

export function createHandler(db: RcwDatabase) {
  const sessions = makeSessions();
  const rate = makeRateLimiter();

  // ── HTML helpers ───────────────────────────────────────────────────────────

const baseStyle = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scrollbar-gutter: stable; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f4f0; color: #1c1c1a; font-size: 14px; line-height: 1.5; display: flex; flex-direction: column; min-height: 100vh; }
  .nav { background: #1e4080; padding: 0 1.5rem; display: flex; align-items: center; height: 48px; min-height: 48px; gap: 1.5rem; position: sticky; top: 0; z-index: 100; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
  .nav-brand { font-weight: 700; font-size: 0.95rem; color: white; letter-spacing: 0.02em; }
  .nav a { color: rgba(255,255,255,0.7); text-decoration: none; font-size: 0.85rem; font-weight: 500; padding: 0.3rem 0; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; }
  .nav a:hover { color: white; }
  .nav a.active { color: white; border-bottom-color: rgba(255,255,255,0.7); }
  .nav .nav-spacer { flex: 1; }
  .nav .nav-user { color: rgba(255,255,255,0.8); font-size: 0.85rem; border-bottom: none; }
  .nav .nav-user:hover { color: white; text-decoration: underline; }
  .page { max-width: 960px; width: 100%; margin: 0 auto; padding: 2rem 1.25rem; flex: 1; }
  button { padding: 0.4rem 1rem; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer; font-size: 0.9rem; font-family: inherit; }
  button.primary { background: #1e4080; color: #fff; border-color: #1e4080; }
  button:hover { filter: brightness(0.93); }
  progress { width: 100%; height: 6px; margin-bottom: 1rem; }
  .meta { font-size: 0.8rem; color: #888; margin-bottom: 1.5rem; }
  footer { border-top: 1px solid #e0dbd2; padding: 1.25rem 1rem; display: flex; justify-content: center; gap: 2rem; font-size: 0.82rem; flex-wrap: wrap; margin-top: auto; }
  footer a { color: #6b6b65; text-decoration: none; }
  footer a:hover { color: #1e4080; text-decoration: underline; }
  .footer-sep { display: none; }
`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function navBar(username: string | null, active?: string): string {
  const auth = username
    ? `<a href="/account" class="nav-user">${esc(username)}</a><a href="/logout">Log out</a>`
    : `<a href="/login"${active === "login" ? ' class="active"' : ""}>Log in</a><a href="/signup"${active === "signup" ? ' class="active"' : ""}>Sign up</a>`;
  return `<nav class="nav"><span class="nav-brand">RCW</span><a href="/"${active === "reader" ? ' class="active"' : ""}>Reader</a><a href="/index"${active === "index" ? ' class="active"' : ""}>Index</a><span class="nav-spacer"></span>${auth}</nav>`;
}

/**
 * Given an escaped section body, replace "RCW XX.YY.ZZZ" patterns with
 * hyperlinks. Looks up each cite in the DB to get its heading for the tooltip.
 */
function linkifyCites(escapedText: string, selfId: string): string {
  return escapedText.replace(
    /\bRCW\s+(\d+[A-Z]?\.\d+[A-Z]?\.\d+[A-Z]?)\b/g,
    (_match, num: string) => {
      const id = sectionNumToId(num);
      if (id === selfId) return `RCW ${num}`;
      const linked = db.getSection(id);
      const tooltip = linked?.heading ? ` data-tooltip="${esc(linked.heading)}"` : "";
      return `RCW <a class="rcw-ref" href="/section?cite=${num}"${tooltip}>${num}</a>`;
    }
  );
}

function readerPage(section: SectionRow, username: string | null, userId: number | null): string {
  const s = db.getStats(userId);
  const pct = s.total > 0 ? ((s.read / s.total) * 100).toFixed(1) : "0.0";
  const cite = section.id;
  const sectionNum = idToSectionNum(cite);
  const isGuest = userId === null;

  const canonicalUrl = `/section?cite=${sectionNum}`;
  const ogDescription = section.text.slice(0, 300).replace(/\s+/g, " ").trim();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RCW ${esc(sectionNum)} — ${esc(section.heading)}</title>
<meta name="description" content="${esc(ogDescription)}">
<meta property="og:type" content="article">
<meta property="og:title" content="RCW ${esc(sectionNum)} — ${esc(section.heading)}">
<meta property="og:description" content="${esc(ogDescription)}">
<meta property="og:url" content="${esc(canonicalUrl)}">
<link rel="canonical" href="${esc(canonicalUrl)}">
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
  .header-text h1 { font-size: 0.85rem; color: #6b6b65; margin-bottom: 0.25rem; letter-spacing: 0.01em; }
  .header-text h1 a { color: inherit; text-decoration: none; border-radius: 3px; padding: 0 2px; margin: 0 -2px; transition: background 0.15s, color 0.15s; }
  .header-text h1 a:hover { color: #1e4080; background: #edf1f9; }
  .header-text h2 { font-size: 1.1rem; color: #1c1c1a; font-weight: 600; }
  .actions { display: flex; gap: 0.5rem; align-items: center; flex-shrink: 0; }
  pre { white-space: pre-wrap; font-family: Georgia, serif; line-height: 1.7; font-size: 1rem; background: #fff; border: 1px solid #e0dbd2; border-radius: 8px; padding: 1.5rem; }
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
  #copy-toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%) translateY(0.5rem); background: #1a1a1a; color: #fff; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.8rem; opacity: 0; transition: opacity 0.2s, transform 0.2s; pointer-events: none; z-index: 50; }
  #copy-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
${navBar(username, "reader")}
<div id="copy-toast">Link copied</div>
<div class="page">
<header>
  <div class="header-text">
    <h1><a href="${esc(canonicalUrl)}" id="cite-link" title="Copy link to this section">RCW ${esc(sectionNum)}</a></h1>
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
  await fetch('/api/sections/' + encodeURIComponent(CITE), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: action === 'read' ? 'read' : 'skipped' })
  });
  window.location.href = '/';
}

// Canonical URL for this section — used for copying regardless of what
// history.replaceState does to the address bar below.
var CANONICAL = ${JSON.stringify(canonicalUrl)};

// Copy-link on cite click
document.getElementById('cite-link').addEventListener('click', function (e) {
  e.preventDefault();
  var full = location.origin + CANONICAL;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(full).then(showCopyToast);
  } else {
    var ta = document.createElement('textarea');
    ta.value = full;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showCopyToast();
  }
});

function showCopyToast() {
  var t = document.getElementById('copy-toast');
  t.classList.add('show');
  setTimeout(function () { t.classList.remove('show'); }, 1800);
}

// Clean up ?after= from URL bar without reloading
if (location.search) history.replaceState(null, '', '/');

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
</div>
${siteFooter()}
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
  const switchText = isSignup ? "Already have an account? <a href='/login' id='switch-link'>Log in</a>" : "No account? <a href='/signup' id='switch-link'>Sign up</a>";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — RCW</title>
<style>
  ${baseStyle}
  .auth-wrap { display: flex; justify-content: center; padding: 4rem 1rem; }
  .auth-card { width: 100%; max-width: 380px; background: #fff; border: 1px solid #e0dbd2; border-radius: 10px; padding: 2rem; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .auth-card h1 { font-size: 1.25rem; font-weight: 700; color: #1c1c1a; margin-bottom: 1.75rem; }
  .field { margin-bottom: 1.1rem; }
  .field label { display: block; font-size: 0.8rem; font-weight: 600; color: #6b6b65; margin-bottom: 0.35rem; letter-spacing: 0.02em; text-transform: uppercase; }
  .field input { width: 100%; padding: 0.55rem 0.75rem; border: 1px solid #d0ccc4; border-radius: 6px; font-size: 0.95rem; font-family: inherit; background: #faf9f7; color: #1c1c1a; }
  .field input:focus { outline: none; border-color: #1e4080; box-shadow: 0 0 0 3px rgba(30,64,128,0.12); background: #fff; }
  .error { background: #fff5f5; border: 1px solid #fca5a5; color: #b91c1c; font-size: 0.85rem; padding: 0.6rem 0.75rem; border-radius: 6px; margin-bottom: 1.1rem; }
  .auth-submit { width: 100%; padding: 0.6rem; font-size: 0.95rem; margin-top: 0.5rem; border-radius: 6px; }
  .auth-footer { margin-top: 1.25rem; font-size: 0.85rem; color: #6b6b65; text-align: center; }
  .auth-footer a { color: #1e4080; text-decoration: none; font-weight: 500; }
  .auth-footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
${navBar(null, isSignup ? "signup" : "login")}
<div class="auth-wrap">
  <div class="auth-card">
    <h1>${esc(title)}</h1>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    <form method="POST" action="${action}">
      <div class="field">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="${isSignup ? "new-password" : "current-password"}" required>
      </div>
      <button class="primary auth-submit" type="submit">${esc(title)}</button>
    </form>
    <p class="auth-footer">${switchText}</p>
  </div>
</div>
<script>
// Pre-fill fields from sessionStorage if coming from the other auth page
(function() {
  var u = sessionStorage.getItem('auth_u');
  var p = sessionStorage.getItem('auth_p');
  if (u) { document.getElementById('username').value = u; sessionStorage.removeItem('auth_u'); }
  if (p) { document.getElementById('password').value = p; sessionStorage.removeItem('auth_p'); }
  document.getElementById('switch-link').addEventListener('click', function() {
    sessionStorage.setItem('auth_u', document.getElementById('username').value);
    sessionStorage.setItem('auth_p', document.getElementById('password').value);
  });
})();
</script>
</body>
</html>`;
}

function siteFooter(): string {
  return `<footer>
  <a href="/about">About</a>
  <a href="https://msws.xyz/s/donate">Donate</a>
  <a href="https://git.msws.xyz/MS/RCW">Source</a>
  <span style="color:#9c9c96;font-size:0.75rem">${esc(GIT_BRANCH)} @ ${esc(GIT_HASH)}</span>
</footer>`;
}

function aboutPage(username: string | null): string {
  const a = db.getAboutStats();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About — RCW Reader</title>
<style>
  ${baseStyle}
  .page h1 { font-size: 1.4rem; font-weight: 700; color: #1c1c1a; margin-bottom: 0.4rem; }
  .page .subtitle { font-size: 0.9rem; color: #6b6b65; margin-bottom: 2rem; }
  .about-card { background: #fff; border: 1px solid #e0dbd2; border-radius: 10px; padding: 1.5rem 1.75rem; margin-bottom: 1.25rem; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .about-card h2 { font-size: 0.95rem; font-weight: 700; color: #1e4080; margin-bottom: 0.75rem; }
  .about-card p { font-size: 0.9rem; color: #3a3a38; line-height: 1.7; margin-bottom: 0.6rem; }
  .about-card p:last-child { margin-bottom: 0; }
  .about-card a { color: #1e4080; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin-top: 0.75rem; }
  .stat-box { background: #f5f4f0; border-radius: 8px; padding: 0.75rem 1rem; }
  .stat-box .val { font-size: 1.25rem; font-weight: 700; color: #1e4080; display: block; }
  .stat-box .lbl { font-size: 0.75rem; color: #6b6b65; margin-top: 0.1rem; display: block; }
</style>
</head>
<body>
${navBar(username)}
<div class="page">
  <h1>RCW Reader</h1>
  <p class="subtitle">A personal reading tracker for the Revised Code of Washington</p>

  <div class="about-card">
    <h2>What is this?</h2>
    <p>RCW Reader is a tool for reading through the <strong>Revised Code of Washington</strong> — the body of state law that governs Washington State. The RCW contains thousands of individual statutes organized into titles and chapters.</p>
    <p>This site lets you read through every section at your own pace, tracking what you've read, skipping sections you don't need, and picking up right where you left off.</p>
    <div class="stat-grid">
      <div class="stat-box"><span class="val">${a.titles.toLocaleString()}</span><span class="lbl">titles</span></div>
      <div class="stat-box"><span class="val">${a.chapters.toLocaleString()}</span><span class="lbl">chapters</span></div>
      <div class="stat-box"><span class="val">${a.sections.toLocaleString()}</span><span class="lbl">sections</span></div>
      <div class="stat-box"><span class="val">${(a.words / 1_000_000).toFixed(1)}M</span><span class="lbl">words</span></div>
    </div>
  </div>

  <div class="about-card">
    <h2>How does it work?</h2>
    <p>The reader presents one section at a time. After reading, you can mark it <strong>Read</strong> to advance to the next section, or <strong>Skip</strong> to set it aside and move on. Your progress is tracked so you can always resume where you left off.</p>
    <p>The <strong>Index</strong> gives a full overview of all titles and chapters, with filters to find unread, read, or skipped sections. You can also search by keyword or section number (e.g. <em>69.50.401</em>).</p>
  </div>

  <div class="about-card">
    <h2>Accounts &amp; guest access</h2>
    <p>You can read without signing in — progress is saved locally in your browser. Create an account to sync your progress across devices and keep a permanent record.</p>
  </div>

  <div class="about-card">
    <h2>Source &amp; attribution</h2>
    <p>RCW text is sourced from the <a href="https://app.leg.wa.gov/rcw/" target="_blank" rel="noopener">Washington State Legislature</a>. This site is an independent project and is not affiliated with the state.</p>
    <p>The source code is available at <a href="https://git.msws.xyz/MS/RCW" target="_blank" rel="noopener">git.msws.xyz/MS/RCW</a>. If you find it useful, consider <a href="https://msws.xyz/s/donate">donating</a>.</p>
  </div>
</div>
${siteFooter()}
</body>
</html>`;
}

function accountPage(username: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Account — RCW</title>
<style>
  ${baseStyle}
  .account-wrap { max-width: 480px; }
  .account-wrap h1 { font-size: 1.2rem; font-weight: 700; color: #1c1c1a; margin-bottom: 0.25rem; }
  .account-wrap .subhead { font-size: 0.85rem; color: #6b6b65; margin-bottom: 1.75rem; }
  .pass-card { background: #fff; border: 1px solid #e0dbd2; border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
  .pass-card label { display: block; font-size: 0.8rem; font-weight: 600; color: #6b6b65; margin-bottom: 0.35rem; letter-spacing: 0.02em; text-transform: uppercase; }
  .pass-card input[type=password] { width: 100%; padding: 0.55rem 0.75rem; border: 1px solid #d0ccc4; border-radius: 6px; font-size: 0.95rem; font-family: inherit; background: #faf9f7; color: #1c1c1a; }
  .pass-card input[type=password]:focus { outline: none; border-color: #1e4080; box-shadow: 0 0 0 3px rgba(30,64,128,0.12); background: #fff; }
  .section-card { background: #fff; border: 1px solid #e0dbd2; border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
  .section-card h2 { font-size: 0.9rem; font-weight: 700; color: #1c1c1a; margin-bottom: 1rem; }
  .section-card p { font-size: 0.85rem; color: #6b6b65; margin-bottom: 0.9rem; line-height: 1.6; }
  .field { margin-bottom: 0.9rem; }
  .field label { display: block; font-size: 0.8rem; font-weight: 600; color: #6b6b65; margin-bottom: 0.35rem; letter-spacing: 0.02em; text-transform: uppercase; }
  .field input { width: 100%; padding: 0.55rem 0.75rem; border: 1px solid #d0ccc4; border-radius: 6px; font-size: 0.95rem; font-family: inherit; background: #faf9f7; color: #1c1c1a; }
  .field input:focus { outline: none; border-color: #1e4080; box-shadow: 0 0 0 3px rgba(30,64,128,0.12); background: #fff; }
  .notice { background: #f0fdf4; border: 1px solid #86efac; color: #166534; font-size: 0.85rem; padding: 0.6rem 0.75rem; border-radius: 6px; margin-bottom: 1.25rem; }
  .error { background: #fff5f5; border: 1px solid #fca5a5; color: #b91c1c; font-size: 0.85rem; padding: 0.6rem 0.75rem; border-radius: 6px; margin-bottom: 1.25rem; }
  .danger-btn { background: #fff; color: #b91c1c; border-color: #fca5a5; }
  .danger-btn:hover { background: #fff5f5; filter: none; }
  .reset-confirm { display: none; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #e0dbd2; }
</style>
</head>
<body>
${navBar(username)}
<div class="page">
<div class="account-wrap">
  <h1>Account</h1>
  <p class="subhead">Signed in as <strong>${esc(username)}</strong></p>
  <div id="msg" style="display:none;margin-bottom:1.25rem"></div>

  <div class="pass-card">
    <label for="current-password">Current password</label>
    <input type="password" id="current-password" autocomplete="current-password" placeholder="Required for all changes">
  </div>

  <div class="section-card">
    <h2>Change username</h2>
    <div class="field">
      <label for="new-username">New username</label>
      <input type="text" id="new-username" autocomplete="username" value="${esc(username)}">
    </div>
    <button class="primary" onclick="submitPatch('/account/username', {new_username: document.getElementById('new-username').value})">Update username</button>
  </div>

  <div class="section-card">
    <h2>Change password</h2>
    <div class="field">
      <label for="new-pass">New password</label>
      <input type="password" id="new-pass" autocomplete="new-password">
    </div>
    <button class="primary" onclick="submitPatch('/account/password', {new_password: document.getElementById('new-pass').value})">Update password</button>
  </div>

  <div class="section-card" id="reset">
    <h2>Reset progress</h2>
    <p>This will permanently delete all your reading progress and cannot be undone.</p>
    <button class="danger-btn" type="button" id="reset-btn" onclick="document.getElementById('reset-confirm').style.display='block';this.style.display='none'">Reset progress…</button>
    <div class="reset-confirm" id="reset-confirm" style="display:none">
      <div style="display:flex;gap:0.5rem;">
        <button class="danger-btn" onclick="submitPost('/account/reset', {})">Yes, reset all progress</button>
        <button type="button" onclick="document.getElementById('reset-confirm').style.display='none';document.getElementById('reset-btn').style.display=''">Cancel</button>
      </div>
    </div>
  </div>
</div>
</div>
${siteFooter()}
<script>
function getPass() { return document.getElementById('current-password').value; }

async function submitPatch(url, extra) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: getPass(), ...extra })
  });
  const data = await res.json();
  if (data.error) { showMsg(data.error, true); } else { showMsg(data.notice); }
}

async function submitPost(url, extra) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: getPass(), ...extra })
  });
  const data = await res.json();
  if (data.error) { showMsg(data.error, true); } else { window.location.href = '/login'; }
}

function showMsg(msg, isError) {
  var el = document.getElementById('msg');
  el.textContent = msg;
  el.className = isError ? 'error' : 'notice';
  el.style.display = 'block';
  window.scrollTo(0, 0);
}
</script>
</body>
</html>`;
}

  // ── Request handler ─────────────────────────────────────────────────────────

  async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const htmlResp = (body: string) =>
    new Response(body, { headers: { "Content-Type": "text/html" } });
  const jsonResp = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

  const session = sessions.get(req);
  const userId = session?.userId ?? null;
  const username = session?.username ?? null;

  const parts = url.pathname.split("/").map(decodeURIComponent);

  // ── Auth ───────────────────────────────────────────────────────────────────

  if (url.pathname === "/login") {
    if (req.method === "POST") {
      if (rate.isLimited(req)) {
        log("WARN", "LOGIN_BLOCKED", "rate limited", req);
        return htmlResp(authPage("Log in", "/login", "Too many failed attempts. Please wait 15 minutes."));
      }
      const form  = new URLSearchParams(await req.text());
      const uname = form.get("username")?.trim() ?? "";
      const pass  = form.get("password") ?? "";
      const user  = db.getUserByUsername(uname);
      if (!user || !(await Bun.password.verify(pass, user.passwordHash))) {
        rate.recordFail(req);
        log("FAIL", "LOGIN_FAIL", `user=${uname}`, req);
        return htmlResp(authPage("Log in", "/login", "Invalid username or password."));
      }
      rate.clear(req);
      log("INFO", "LOGIN_OK", `user=${user.username}`, req);
      const token = sessions.create(user.id, user.username);
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
      if (pass.length < 1)
        return htmlResp(authPage("Sign up", "/signup", "Password is required."));
      if (db.getUserByUsername(uname))
        return htmlResp(authPage("Sign up", "/signup", "Username already taken."));
      const hash   = await Bun.password.hash(pass);
      const uid    = db.createUser(uname, hash);
      log("INFO", "SIGNUP_OK", `user=${uname}`, req);
      const token  = sessions.create(uid, uname);
      return new Response(null, {
        status: 302,
        headers: { "Location": "/", "Set-Cookie": `session=${token}; HttpOnly; SameSite=Strict; Path=/` },
      });
    }
    return htmlResp(authPage("Sign up", "/signup"));
  }

  if (url.pathname === "/logout") {
    log("INFO", "LOGOUT", `user=${username ?? "unknown"}`, req);
    sessions.delete(req);
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
  if (req.method === "GET" && parts[1] === "api" && parts[2] === "toc") {
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
  // PATCH /api/sections/:cite  body: { state: "read"|"skipped"|"unread" }
  if (req.method === "PATCH" && parts[1] === "api" && parts[2] === "sections" && parts[3]) {
    if (!userId) return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
    const cite = decodeURIComponent(parts[3]);
    const { state } = await req.json() as { state?: string };
    if (cite && ["unread", "read", "skipped"].includes(state ?? "")) {
      db.setState(cite, state as "unread" | "read" | "skipped", userId);
    }
    return jsonResp({ ok: true });
  }

  // PATCH /api/toc/:title         body: { state: "skipped"|"unread" }
  // PATCH /api/toc/:title/:chapter  body: { state: "skipped"|"unread" }
  // Bulk-skip (or un-skip) all unread sections in a title or chapter.
  // Already-read sections are never affected.
  if (req.method === "PATCH" && parts[1] === "api" && parts[2] === "toc" && parts[3]) {
    if (!userId) return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
    const { state } = await req.json() as { state?: string };
    if (!["unread", "skipped"].includes(state ?? "")) return jsonResp({ ok: true });
    const s = state as "unread" | "skipped";
    if (parts[4]) {
      // Title + chapter
      const chapter = decodeURIComponent(parts[4]);
      db.setChapterState(chapter, s, userId);
    } else {
      // Title only
      const rcwTitle = decodeURIComponent(parts[3]);
      db.setTitleState(rcwTitle, s, userId);
    }
    return jsonResp({ ok: true });
  }

  // ── About ──────────────────────────────────────────────────────────────────

  if (url.pathname === "/about") {
    return htmlResp(aboutPage(username));
  }

  // ── Account ────────────────────────────────────────────────────────────────

  if (url.pathname === "/account") {
    if (!userId || !username) return new Response(null, { status: 302, headers: { "Location": "/login" } });
    return htmlResp(accountPage(username));
  }

  if (url.pathname === "/account/username" && req.method === "PATCH") {
    if (!userId || !username) return jsonResp({ error: "unauthenticated" });
    const { password, new_username } = await req.json() as { password?: string; new_username?: string };
    const newUsername = new_username?.trim() ?? "";
    const user = db.getUserById(userId)!;
    if (!(await Bun.password.verify(password ?? "", user.passwordHash))) {
      log("FAIL", "ACCOUNT_USERNAME_FAIL", `user=${username}`, req);
      return jsonResp({ error: "Incorrect password." });
    }
    if (newUsername.length < 1) return jsonResp({ error: "Username is required." });
    if (newUsername !== username && db.getUserByUsername(newUsername))
      return jsonResp({ error: "Username already taken." });
    db.updateUsername(userId, newUsername);
    log("INFO", "ACCOUNT_USERNAME_OK", `user=${username} new=${newUsername}`, req);
    sessions.update(req, { username: newUsername });
    return jsonResp({ notice: "Username updated." });
  }

  if (url.pathname === "/account/password" && req.method === "PATCH") {
    if (!userId || !username) return jsonResp({ error: "unauthenticated" });
    const { password, new_password } = await req.json() as { password?: string; new_password?: string };
    const user = db.getUserById(userId)!;
    if (!(await Bun.password.verify(password ?? "", user.passwordHash))) {
      log("FAIL", "ACCOUNT_PASSWORD_FAIL", `user=${username}`, req);
      return jsonResp({ error: "Incorrect current password." });
    }
    if (!new_password?.length) return jsonResp({ error: "New password is required." });
    db.updatePassword(userId, await Bun.password.hash(new_password));
    log("INFO", "ACCOUNT_PASSWORD_OK", `user=${username}`, req);
    return jsonResp({ notice: "Password updated." });
  }

  if (url.pathname === "/account/reset" && req.method === "POST") {
    if (!userId || !username) return jsonResp({ error: "unauthenticated" });
    const { password } = await req.json() as { password?: string };
    const user = db.getUserById(userId)!;
    if (!(await Bun.password.verify(password ?? "", user.passwordHash))) {
      log("FAIL", "ACCOUNT_RESET_FAIL", `user=${username}`, req);
      return jsonResp({ error: "Incorrect password — progress not reset." });
    }
    db.resetProgress(userId);
    log("INFO", "ACCOUNT_RESET_OK", `user=${username}`, req);
    sessions.delete(req);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" },
    });
  }

  // ── Reader ─────────────────────────────────────────────────────────────────
  if (url.pathname === "/section") {
    const raw = url.searchParams.get("cite");
    if (!raw) return new Response("Not found", { status: 404 });
    // Accept both short form "1.04.013" and legacy full form "1/1.04/1.04.013"
    const cite = raw.includes("/") ? raw : sectionNumToId(raw);
    const section = db.getSection(cite, userId);
    if (!section) return new Response("Not found", { status: 404 });
    db.nextUnread(cite, userId); // warm next
    return htmlResp(readerPage(section, username, userId));
  }

  if (url.pathname === "/index") {
    // Inject auth bootstrap so #nav-auth renders synchronously, preventing layout shift.
    const html = await Bun.file(import.meta.dir + "/public/index.html").text();
    const navHtml = username
      ? `<a href="/account" style="color:rgba(255,255,255,0.8);font-size:0.85rem;text-decoration:none">${esc(username)}</a><a href="/logout">Log out</a>`
      : `<a href="/login">Log in</a><a href="/signup">Sign up</a>`;
    const authScript = `<script>IS_GUEST=${!username};(function(){` +
      `var n=document.getElementById('nav-auth');if(n)n.innerHTML=${JSON.stringify(navHtml)};` +
      `var v=document.getElementById('version');if(v)v.textContent=${JSON.stringify(`${GIT_BRANCH} @ ${GIT_HASH}`)};` +
      `}());</script>`;
    return htmlResp(html.replace("<body>", `<body>${authScript}`));
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

  return handle;
}

if (import.meta.main) {
  const RCW_DIR    = process.env.RCW_DIR    ?? "/rcw";
  const STATE_FILE = process.env.STATE_FILE ?? "/data/rcw_reader_state.json";
  const DB_FILE    = process.env.DB_FILE    ?? "/data/rcw.db";
  const PORT       = Number(process.env.PORT ?? 3000);

  const db = new RcwDatabase(DB_FILE);
  db.migrateFromJson(STATE_FILE);
  db.index(RCW_DIR);

  Bun.serve({ port: PORT, fetch: createHandler(db) });
  console.log(`Listening on http://localhost:${PORT}`);
}
