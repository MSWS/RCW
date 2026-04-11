import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { RcwDatabase } from "./database";
import { createHandler, RATE_MAX_FAILS } from "./server";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function sectionFile(heading: string, body: string): string {
  return `PDF\nRCW\nid\n${heading}\n${body}\n`;
}

function createFixture(): string {
  const dir = join(tmpdir(), `rcw_server_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "1", "1.04"), { recursive: true });
  writeFileSync(join(dir, "1", "1.04", "1.04.013.txt"), sectionFile("RCW enacted.", "Body of 1.04.013."));
  writeFileSync(join(dir, "1", "1.04", "1.04.016.txt"), sectionFile("Courts.", "Body of 1.04.016."));
  mkdirSync(join(dir, "2", "2.04"), { recursive: true });
  writeFileSync(join(dir, "2", "2.04", "2.04.010.txt"), sectionFile("Title 2 section.", "Body of 2.04.010."));
  return dir;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let db: RcwDatabase;
let fixture: string;
let handle: (req: Request) => Promise<Response>;

function req(method: string, path: string, opts: { body?: string; cookie?: string; json?: unknown } = {}): Request {
  const headers = new Headers({ "X-Real-IP": "127.0.0.1" });
  if (opts.cookie) headers.set("Cookie", `session=${opts.cookie}`);
  if (opts.json != null) {
    headers.set("Content-Type", "application/json");
    return new Request(`http://localhost${path}`, { method, headers, body: JSON.stringify(opts.json) });
  }
  if (opts.body) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    return new Request(`http://localhost${path}`, { method, headers, body: opts.body });
  }
  return new Request(`http://localhost${path}`, { method, headers });
}

async function signup(username: string, password: string): Promise<string> {
  const res = await handle(req("POST", "/signup", { body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}` }));
  const cookie = res.headers.get("Set-Cookie") ?? "";
  return cookie.match(/session=([^;]+)/)?.[1] ?? "";
}

beforeEach(() => {
  db = new RcwDatabase(":memory:");
  fixture = createFixture();
  db.index(fixture);
  handle = createHandler(db);
});

afterEach(() => {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
});

// ── Static pages ──────────────────────────────────────────────────────────────

describe("static pages", () => {
  test("GET / returns HTML reader", async () => {
    const res = await handle(req("GET", "/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("RCW");
  });

  test("GET /about returns HTML", async () => {
    const res = await handle(req("GET", "/about"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("About");
  });

  test("GET /login returns HTML", async () => {
    const res = await handle(req("GET", "/login"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Log in");
  });

  test("GET /signup returns HTML", async () => {
    const res = await handle(req("GET", "/signup"));
    expect(res.status).toBe(200);
  });

  test("GET /unknown returns 404", async () => {
    const res = await handle(req("GET", "/does-not-exist"));
    expect(res.status).toBe(404);
  });
});

// ── Signup / Login / Logout ───────────────────────────────────────────────────

describe("auth", () => {
  test("signup creates account and redirects", async () => {
    const res = await handle(req("POST", "/signup", { body: "username=alice&password=secret" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toContain("session=");
  });

  test("signup rejects duplicate username", async () => {
    await signup("alice", "pass1");
    const res = await handle(req("POST", "/signup", { body: "username=alice&password=pass2" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("already taken");
  });

  test("signup rejects empty username", async () => {
    const res = await handle(req("POST", "/signup", { body: "username=&password=pass" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("required");
  });

  test("login succeeds with correct credentials", async () => {
    await signup("alice", "secret");
    const res = await handle(req("POST", "/login", { body: "username=alice&password=secret" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toContain("session=");
  });

  test("login fails with wrong password", async () => {
    await signup("alice", "secret");
    const res = await handle(req("POST", "/login", { body: "username=alice&password=wrong" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Invalid username or password");
  });

  test("login is case-insensitive for username", async () => {
    await signup("Alice", "secret");
    const res = await handle(req("POST", "/login", { body: "username=alice&password=secret" }));
    expect(res.status).toBe(302);
  });

  test("logout clears session and redirects to login", async () => {
    const token = await signup("alice", "secret");
    const res = await handle(req("POST", "/logout", { cookie: token }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    // Session should be gone — subsequent request is unauthenticated
    const me = await handle(req("GET", "/api/me", { cookie: token }));
    expect(me.status).toBe(401);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe("rate limiting", () => {
  test("blocks after RATE_MAX_FAILS failed login attempts", async () => {
    await signup("alice", "secret");
    for (let i = 0; i < RATE_MAX_FAILS; i++) {
      await handle(req("POST", "/login", { body: "username=alice&password=wrong" }));
    }
    const res = await handle(req("POST", "/login", { body: "username=alice&password=wrong" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Too many failed attempts");
  });

  test("successful login clears rate limit counter", async () => {
    await signup("alice", "secret");
    for (let i = 0; i < RATE_MAX_FAILS - 1; i++) {
      await handle(req("POST", "/login", { body: "username=alice&password=wrong" }));
    }
    // Successful login resets counter
    await handle(req("POST", "/login", { body: "username=alice&password=secret" }));
    // Should be able to fail again without being blocked
    const res = await handle(req("POST", "/login", { body: "username=alice&password=wrong" }));
    const text = await res.text();
    expect(text).not.toContain("Too many failed attempts");
  });
});

// ── /api/me ───────────────────────────────────────────────────────────────────

describe("/api/me", () => {
  test("returns 401 for guest", async () => {
    const res = await handle(req("GET", "/api/me"));
    expect(res.status).toBe(401);
  });

  test("returns username for authenticated user", async () => {
    const token = await signup("alice", "secret");
    const res = await handle(req("GET", "/api/me", { cookie: token }));
    expect(res.status).toBe(200);
    const data = await res.json() as { username: string };
    expect(data.username).toBe("alice");
  });
});

// ── /api/stats ────────────────────────────────────────────────────────────────

describe("/api/stats", () => {
  test("returns total section count", async () => {
    const res = await handle(req("GET", "/api/stats"));
    expect(res.status).toBe(200);
    const data = await res.json() as { total: number };
    expect(data.total).toBe(3);
  });
});

// ── /api/search ───────────────────────────────────────────────────────────────

describe("/api/search", () => {
  test("returns results for matching query", async () => {
    const res = await handle(req("GET", "/api/search?q=enacted"));
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string }[];
    expect(data.some(r => r.id === "1/1.04/1.04.013")).toBe(true);
  });

  test("returns empty array for blank query", async () => {
    const res = await handle(req("GET", "/api/search?q="));
    const data = await res.json() as unknown[];
    expect(data).toEqual([]);
  });

  test("finds by section ID", async () => {
    const res = await handle(req("GET", "/api/search?q=1.04.013"));
    const data = await res.json() as { id: string }[];
    expect(data.some(r => r.id === "1/1.04/1.04.013")).toBe(true);
  });
});

// ── PATCH /api/sections/:cite ─────────────────────────────────────────────────

describe("PATCH /api/sections/:cite", () => {
  test("returns 401 for guest", async () => {
    const res = await handle(req("PATCH", "/api/sections/1%2F1.04%2F1.04.013", { json: { state: "read" } }));
    expect(res.status).toBe(401);
  });

  test("sets section state for authenticated user", async () => {
    const token = await signup("alice", "secret");
    const res = await handle(req("PATCH", "/api/sections/1%2F1.04%2F1.04.013", { json: { state: "read" }, cookie: token }));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
    // Verify state was saved
    const uid = db.getUserByUsername("alice")!.id;
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("read");
  });

  test("can mark as skipped", async () => {
    const token = await signup("alice", "secret");
    await handle(req("PATCH", "/api/sections/1%2F1.04%2F1.04.013", { json: { state: "skipped" }, cookie: token }));
    const uid = db.getUserByUsername("alice")!.id;
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("skipped");
  });

  test("can reset to unread", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    db.setState("1/1.04/1.04.013", "read", uid);
    await handle(req("PATCH", "/api/sections/1%2F1.04%2F1.04.013", { json: { state: "unread" }, cookie: token }));
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("unread");
  });
});

// ── Account ───────────────────────────────────────────────────────────────────

describe("account", () => {
  test("GET /account redirects to login when unauthenticated", async () => {
    const res = await handle(req("GET", "/account"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  test("GET /account returns page when authenticated", async () => {
    const token = await signup("alice", "secret");
    const res = await handle(req("GET", "/account", { cookie: token }));
    expect(res.status).toBe(200);
  });

  test("PATCH /account/username updates username with correct password", async () => {
    const token = await signup("alice", "secret");
    const res = await handle(req("PATCH", "/account/username", { json: { password: "secret", new_username: "alice2" }, cookie: token }));
    expect(res.status).toBe(200);
    const data = await res.json() as { notice?: string };
    expect(data.notice).toBe("Username updated.");
    expect(db.getUserByUsername("alice2")).not.toBeNull();
  });

  test("PATCH /account/username rejects wrong password", async () => {
    const token = await signup("alice", "secret");
    const res = await handle(req("PATCH", "/account/username", { json: { password: "wrong", new_username: "alice2" }, cookie: token }));
    const data = await res.json() as { error?: string };
    expect(data.error).toContain("Incorrect password");
  });

  test("PATCH /account/password updates password", async () => {
    const token = await signup("alice", "secret");
    const res = await handle(req("PATCH", "/account/password", { json: { password: "secret", new_password: "newsecret" }, cookie: token }));
    const data = await res.json() as { notice?: string };
    expect(data.notice).toBe("Password updated.");
    // Old password no longer works
    const login = await handle(req("POST", "/login", { body: "username=alice&password=secret" }));
    expect(login.status).toBe(200); // not a redirect = failed
  });

  test("POST /account/reset resets progress and logs out", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    db.setState("1/1.04/1.04.013", "read", uid);
    expect(db.getStats(uid).read).toBe(1);
    const res = await handle(req("POST", "/account/reset", { json: { password: "secret" }, cookie: token }));
    expect(res.status).toBe(200);
    expect(db.getStats(uid).read).toBe(0);
    // Session should be invalidated
    const me = await handle(req("GET", "/api/me", { cookie: token }));
    expect(me.status).toBe(401);
  });

  test("POST /account/reset rejects wrong password", async () => {
    const token = await signup("alice", "secret");
    const res = await handle(req("POST", "/account/reset", { json: { password: "wrong" }, cookie: token }));
    const data = await res.json() as { error?: string };
    expect(data.error).toContain("Incorrect password");
  });
});

// ── /api/toc (GET) ────────────────────────────────────────────────────────────

describe("/api/toc", () => {
  test("returns title list", async () => {
    const res = await handle(req("GET", "/api/toc"));
    expect(res.status).toBe(200);
    const data = await res.json() as { rcwTitle: string }[];
    expect(data.map(t => t.rcwTitle)).toEqual(["1", "2"]);
  });

  test("returns chapter list for a title", async () => {
    const res = await handle(req("GET", "/api/toc/1"));
    expect(res.status).toBe(200);
    const data = await res.json() as { chapter: string }[];
    expect(data[0]?.chapter).toBe("1.04");
  });

  test("returns section list for a chapter", async () => {
    const res = await handle(req("GET", "/api/toc/1/1.04"));
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string }[];
    expect(data.length).toBe(2);
  });
});

// ── PATCH /api/toc/:title and /api/toc/:title/:chapter ────────────────────────

describe("PATCH /api/toc — bulk skip", () => {
  test("returns 401 for unauthenticated request", async () => {
    const res = await handle(req("PATCH", "/api/toc/1", { json: { state: "skipped" } }));
    expect(res.status).toBe(401);
  });

  test("skips all unread sections in a title", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    const res = await handle(req("PATCH", "/api/toc/1", { json: { state: "skipped" }, cookie: token }));
    expect(res.status).toBe(200);
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("skipped");
    expect(db.getSection("1/1.04/1.04.016", uid)!.state).toBe("skipped");
    // Title 2 unaffected
    expect(db.getSection("2/2.04/2.04.010", uid)!.state).toBe("unread");
  });

  test("does not overwrite read sections when skipping a title", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    db.setState("1/1.04/1.04.013", "read", uid);
    await handle(req("PATCH", "/api/toc/1", { json: { state: "skipped" }, cookie: token }));
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("read");   // unchanged
    expect(db.getSection("1/1.04/1.04.016", uid)!.state).toBe("skipped");
  });

  test("un-skipping a title only clears skipped sections", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    db.setState("1/1.04/1.04.013", "read", uid);
    db.setState("1/1.04/1.04.016", "skipped", uid);
    await handle(req("PATCH", "/api/toc/1", { json: { state: "unread" }, cookie: token }));
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("read");   // read stays read
    expect(db.getSection("1/1.04/1.04.016", uid)!.state).toBe("unread"); // skipped cleared
  });

  test("state=read is rejected (skip-only mode)", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    await handle(req("PATCH", "/api/toc/1", { json: { state: "read" }, cookie: token }));
    // All sections should still be unread
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("unread");
    expect(db.getSection("1/1.04/1.04.016", uid)!.state).toBe("unread");
  });

  test("skips all unread sections in a chapter", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    const res = await handle(req("PATCH", "/api/toc/1/1.04", { json: { state: "skipped" }, cookie: token }));
    expect(res.status).toBe(200);
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("skipped");
    expect(db.getSection("1/1.04/1.04.016", uid)!.state).toBe("skipped");
    expect(db.getSection("2/2.04/2.04.010", uid)!.state).toBe("unread");
  });

  test("does not overwrite read sections when skipping a chapter", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    db.setState("1/1.04/1.04.013", "read", uid);
    await handle(req("PATCH", "/api/toc/1/1.04", { json: { state: "skipped" }, cookie: token }));
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("read");
    expect(db.getSection("1/1.04/1.04.016", uid)!.state).toBe("skipped");
  });

  test("un-skipping a chapter only clears skipped sections", async () => {
    const token = await signup("alice", "secret");
    const uid = db.getUserByUsername("alice")!.id;
    db.setState("1/1.04/1.04.013", "read", uid);
    db.setState("1/1.04/1.04.016", "skipped", uid);
    await handle(req("PATCH", "/api/toc/1/1.04", { json: { state: "unread" }, cookie: token }));
    expect(db.getSection("1/1.04/1.04.013", uid)!.state).toBe("read");
    expect(db.getSection("1/1.04/1.04.016", uid)!.state).toBe("unread");
  });
});
