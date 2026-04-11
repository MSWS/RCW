import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export type ReadState = "unread" | "read" | "skipped";

export interface SectionRow {
    id: string;       // full cite: "1/1.04/1.04.013"
    rcwTitle: string; // "1"
    chapter: string;  // "1.04"
    heading: string;  // "Revised Code of Washington enacted."
    text: string;     // cleaned body (trailing metadata stripped)
    state: ReadState;
}

export interface SearchResult {
    id: string;
    rcwTitle: string;
    chapter: string;
    heading: string;
    snippet: string;  // HTML with <mark> highlights
    state: ReadState;
}

export interface TitleStats {
    rcwTitle: string;
    read: number;
    skipped: number;
    total: number;
    unread: number;
    chapters: number;
}

export interface ChapterStats {
    chapter: string;
    read: number;
    skipped: number;
    total: number;
    unread: number;
}

export interface SectionInfo {
    id: string;
    heading: string;
    state: ReadState;
}

export interface UserRow {
    id: number;
    username: string;
    passwordHash: string;
}

// Matches: [ \n 1951 c 5 s 1 \n .] and variants
const TRAILING_METADATA_RE = /\[\s*\n[\s\S]*?\.\s*\]\s*$/;

function parseRawText(raw: string): { heading: string; body: string } {
    const lines = raw.split("\n");
    // Lines 0-2: "PDF", "RCW", "<section id>" — skip
    // Line 3: human-readable title/heading
    const heading = (lines[3] ?? "").trim();
    let body = lines.slice(4).join("\n").trim();
    body = body.replace(TRAILING_METADATA_RE, "").trimEnd();
    return { heading, body };
}

function naturalSort(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export class RcwDatabase {
    private db: Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath, { create: true });
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run("PRAGMA synchronous = NORMAL");
        this.db.run("PRAGMA foreign_keys = ON");
        this.initSchema();
    }

    private initSchema(): void {
        this.db.run(`
      CREATE TABLE IF NOT EXISTS sections (
        id         TEXT PRIMARY KEY,
        rcw_title  TEXT NOT NULL,
        chapter    TEXT NOT NULL,
        heading    TEXT NOT NULL,
        text       TEXT NOT NULL,
        state      TEXT NOT NULL DEFAULT 'unread',
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);
        this.db.run("CREATE INDEX IF NOT EXISTS idx_rcw_title ON sections(rcw_title)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_chapter   ON sections(rcw_title, chapter)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_sort      ON sections(sort_order)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_state     ON sections(state)");

        // FTS5 content table — text is not duplicated on disk; triggers keep it in sync
        this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts
      USING fts5(
        id,
        heading,
        text,
        content=sections,
        content_rowid=rowid
      )
    `);
        this.db.run(`
      CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
        INSERT INTO sections_fts(rowid, id, heading, text)
        VALUES (new.rowid, new.id, new.heading, new.text);
      END
    `);
        this.db.run(`
      CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
        INSERT INTO sections_fts(sections_fts, rowid, id, heading, text)
        VALUES ('delete', old.rowid, old.id, old.heading, old.text);
      END
    `);
        this.db.run(`
      CREATE TRIGGER IF NOT EXISTS sections_au AFTER UPDATE ON sections BEGIN
        INSERT INTO sections_fts(sections_fts, rowid, id, heading, text)
        VALUES ('delete', old.rowid, old.id, old.heading, old.text);
        INSERT INTO sections_fts(rowid, id, heading, text)
        VALUES (new.rowid, new.id, new.heading, new.text);
      END
    `);

        // Users table
        this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

        // Per-user section state — only non-unread rows are stored (absent = unread)
        this.db.run(`
      CREATE TABLE IF NOT EXISTS user_section_state (
        user_id    INTEGER NOT NULL REFERENCES users(id),
        section_id TEXT    NOT NULL REFERENCES sections(id),
        state      TEXT    NOT NULL CHECK(state IN ('read', 'skipped')),
        PRIMARY KEY (user_id, section_id)
      )
    `);
        this.db.run("CREATE INDEX IF NOT EXISTS idx_uss_user ON user_section_state(user_id)");
    }

    // ── Auth ──────────────────────────────────────────────────────────────────

    createUser(username: string, passwordHash: string): number {
        const isFirst = (this.db.prepare("SELECT COUNT(*) as n FROM users").get() as any).n === 0;
        const result = this.db.prepare(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)"
        ).run(username, passwordHash);
        const userId = result.lastInsertRowid as number;

        if (isFirst) {
            // Migrate any legacy JSON-imported state (sections.state) to the first user
            this.db.prepare(`
        INSERT OR IGNORE INTO user_section_state (user_id, section_id, state)
        SELECT ?, id, state FROM sections WHERE state != 'unread'
      `).run(userId);
            console.log("Migrated existing section states to first user.");
        }

        return userId;
    }

    getUserByUsername(username: string): UserRow | null {
        const row = this.db.prepare(
            "SELECT id, username, password_hash FROM users WHERE username = ?"
        ).get(username) as any;
        if (!row) return null;
        return { id: row.id, username: row.username, passwordHash: row.password_hash };
    }

    getUserById(id: number): UserRow | null {
        const row = this.db.prepare(
            "SELECT id, username, password_hash FROM users WHERE id = ?"
        ).get(id) as any;
        if (!row) return null;
        return { id: row.id, username: row.username, passwordHash: row.password_hash };
    }

    updateUsername(userId: number, newUsername: string): void {
        this.db.prepare("UPDATE users SET username = ? WHERE id = ?").run(newUsername, userId);
    }

    updatePassword(userId: number, newHash: string): void {
        this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, userId);
    }

    resetProgress(userId: number): void {
        // Full reset: mark everything unread (clears all read and skipped rows).
        this.db.prepare("DELETE FROM user_section_state WHERE user_id = ?").run(userId);
    }

    // ── Indexing ──────────────────────────────────────────────────────────────

    /**
     * Walk rcwDir and ingest any not-yet-indexed sections.
     * INSERT OR IGNORE makes re-runs safe — existing rows are untouched.
     */
    index(rcwDir: string): void {
        const countBefore = (
            this.db.prepare("SELECT COUNT(*) as n FROM sections").get() as any
        ).n as number;

        const insert = this.db.prepare(`
      INSERT OR IGNORE INTO sections (id, rcw_title, chapter, heading, text, sort_order)
      VALUES ($id, $rcwTitle, $chapter, $heading, $text, $sortOrder)
    `);
        const insertMany = this.db.transaction((rows: any[]) => {
            for (const row of rows) insert.run(row);
        });

        // Start sort_order after whatever is already in the DB
        let order = (
            (this.db.prepare("SELECT MAX(sort_order) as m FROM sections").get() as any).m ?? -1
        ) as number;

        const titleDirs = readdirSync(rcwDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort(naturalSort);

        for (const titleDir of titleDirs) {
            const titlePath = join(rcwDir, titleDir);
            const chapterDirs = readdirSync(titlePath, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name)
                .sort(naturalSort);

            for (const chapterDir of chapterDirs) {
                const chapterPath = join(titlePath, chapterDir);
                const files = readdirSync(chapterPath)
                    .filter((f) => f.endsWith(".txt"))
                    .sort(naturalSort);

                const rows = files.map((file) => {
                    order++;
                    const sectionId = file.replace(/\.txt$/, "");
                    const cite = `${titleDir}/${chapterDir}/${sectionId}`;
                    const raw = readFileSync(join(chapterPath, file), "utf-8");
                    const { heading, body } = parseRawText(raw);
                    return {
                        $id: cite,
                        $rcwTitle: titleDir,
                        $chapter: chapterDir,
                        $heading: heading,
                        $text: body,
                        $sortOrder: order,
                    };
                });

                insertMany(rows);
            }
        }

        const countAfter = (
            this.db.prepare("SELECT COUNT(*) as n FROM sections").get() as any
        ).n as number;
        console.log(`Database: ${countAfter} sections indexed (${countAfter - countBefore} added).`);
    }

    /**
     * One-time import of state from the old JSON state file.
     * The old format is { status: { "1/1.04/1.04.013": "read", ... } }
     * which matches our cite-as-id scheme exactly.
     */
    migrateFromJson(jsonPath: string): void {
        try {
            const raw = readFileSync(jsonPath, "utf-8");
            const { status } = JSON.parse(raw) as { status: Record<string, ReadState> };
            const update = this.db.prepare("UPDATE sections SET state = ? WHERE id = ?");
            const migrate = this.db.transaction(() => {
                for (const [cite, st] of Object.entries(status)) {
                    if (st !== "unread") update.run(st, cite);
                }
            });
            migrate();
            console.log("State migrated from JSON.");
        } catch {
            // No existing JSON — nothing to do
        }
    }

    // ── Queries ───────────────────────────────────────────────────────────────
    //
    // All query methods accept userId: number | null.
    // null = unauthenticated guest — all sections appear as 'unread', setState is a no-op.
    // We use userId ?? -1 as the LEFT JOIN key; -1 never matches a real user so all
    // COALESCE(uss.state, 'unread') values resolve to 'unread' for guests.

    /**
     * Full-text search across heading and body text.
     * Returns up to `limit` results ordered by FTS rank.
     * Silently returns [] on invalid FTS5 query syntax.
     */
    search(query: string, filter = "all", limit = 100, userId: number | null = null): SearchResult[] {
        const uid = userId ?? -1;
        const seen = new Set<string>();
        const results: SearchResult[] = [];

        // ID substring match — only runs when query looks like a cite (e.g. "69.50.401")
        if (/^[\d.]+$/.test(query)) {
            try {
                const idClauses: string[] = ["s.id LIKE ?"];
                const idParams: any[] = [uid, `%${query}%`];
                if (filter !== "all") {
                    idClauses.push("COALESCE(uss.state, 'unread') = ?");
                    idParams.push(filter);
                }
                const idRows = this.db.prepare(`
          SELECT s.id, s.rcw_title, s.chapter, s.heading, s.text,
            COALESCE(uss.state, 'unread') as state
          FROM sections s
          LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
          WHERE ${idClauses.join(" AND ")}
          ORDER BY s.sort_order LIMIT ?
        `).all(...idParams, limit) as any[];
                for (const r of idRows) {
                    seen.add(r.id);
                    results.push({
                        id: r.id,
                        rcwTitle: r.rcw_title,
                        chapter: r.chapter,
                        heading: r.heading,
                        snippet: r.text.slice(0, 200),
                        state: r.state as ReadState,
                    });
                }
            } catch { /* ignore */ }
        }

        // FTS full-text search
        try {
            const clauses: string[] = ["sections_fts MATCH ?"];
            const params: any[] = [uid, query];
            if (filter !== "all") {
                clauses.push("COALESCE(uss.state, 'unread') = ?");
                params.push(filter);
            }
            const rows = this.db.prepare(`
        SELECT
          s.id,
          s.rcw_title,
          s.chapter,
          s.heading,
          COALESCE(uss.state, 'unread') as state,
          snippet(sections_fts, 2, '<mark>', '</mark>', '…', 24) AS snippet
        FROM sections_fts
        JOIN sections s ON s.rowid = sections_fts.rowid
        LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
        WHERE ${clauses.join(" AND ")}
        ORDER BY rank
        LIMIT ?
      `).all(...params, limit) as any[];

            for (const r of rows) {
                if (seen.has(r.id)) continue;
                seen.add(r.id);
                results.push({
                    id: r.id,
                    rcwTitle: r.rcw_title,
                    chapter: r.chapter,
                    heading: r.heading,
                    snippet: r.snippet,
                    state: r.state as ReadState,
                });
            }
        } catch { /* ignore */ }

        return results.slice(0, limit);
    }

    getSection(cite: string, userId: number | null = null): SectionRow | null {
        const uid = userId ?? -1;
        const row = this.db.prepare(`
      SELECT s.id, s.rcw_title, s.chapter, s.heading, s.text,
        COALESCE(uss.state, 'unread') as state
      FROM sections s
      LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
      WHERE s.id = ?
    `).get(uid, cite) as any;
        if (!row) return null;
        return {
            id: row.id,
            rcwTitle: row.rcw_title,
            chapter: row.chapter,
            heading: row.heading,
            text: row.text,
            state: row.state,
        };
    }

    setState(cite: string, state: ReadState, userId: number): void {
        if (state === "unread") {
            this.db.prepare(
                "DELETE FROM user_section_state WHERE user_id = ? AND section_id = ?"
            ).run(userId, cite);
        } else {
            this.db.prepare(
                "INSERT OR REPLACE INTO user_section_state (user_id, section_id, state) VALUES (?, ?, ?)"
            ).run(userId, cite, state);
        }
    }

    /**
     * Skip all currently-unread sections in a title, or un-skip them.
     * Already-read sections are never touched.
     * Un-skipping (state='unread') only removes 'skipped' rows — read rows stay.
     *
     * @param allowMarkRead  When true, state='read' is also accepted (marks all
     *                       unread sections as read). Default: false.
     */
    setTitleState(rcwTitle: string, state: ReadState, userId: number, allowMarkRead = false): void {
        if (state === "read" && !allowMarkRead) return;
        this._setBulkState("rcw_title", rcwTitle, state, userId);
    }

    /**
     * Skip all currently-unread sections in a chapter, or un-skip them.
     * Already-read sections are never touched.
     * Un-skipping (state='unread') only removes 'skipped' rows — read rows stay.
     *
     * @param allowMarkRead  When true, state='read' is also accepted.
     *                       Default: false.
     */
    setChapterState(chapter: string, state: ReadState, userId: number, allowMarkRead = false): void {
        if (state === "read" && !allowMarkRead) return;
        this._setBulkState("chapter", chapter, state, userId);
    }

    private _setBulkState(
        column: "rcw_title" | "chapter",
        value: string,
        state: ReadState,
        userId: number,
    ): void {
        if (state === "unread") {
            // Only clear rows that are currently 'skipped'; leave 'read' rows intact.
            this.db.prepare(`
                DELETE FROM user_section_state
                WHERE user_id = ?
                  AND state = 'skipped'
                  AND section_id IN (SELECT id FROM sections WHERE ${column} = ?)
            `).run(userId, value);
        } else {
            // Insert the new state for every section not yet in user_section_state
            // (i.e. currently 'unread'). INSERT OR IGNORE leaves existing rows alone.
            this.db.prepare(`
                INSERT OR IGNORE INTO user_section_state (user_id, section_id, state)
                SELECT ?, id, ?
                FROM sections
                WHERE ${column} = ?
                  AND id NOT IN (
                    SELECT section_id FROM user_section_state WHERE user_id = ?
                  )
            `).run(userId, state, value, userId);
        }
    }

    getStats(userId: number | null): { total: number; read: number; skipped: number; unread: number } {
        if (userId === null) {
            const row = this.db.prepare("SELECT COUNT(*) as total FROM sections").get() as any;
            return { total: row.total, read: 0, skipped: 0, unread: row.total };
        }
        const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN uss.state = 'read'    THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN uss.state = 'skipped' THEN 1 ELSE 0 END) as skipped
      FROM sections s
      LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
    `).get(userId) as any;
        return {
            total: row.total,
            read: row.read ?? 0,
            skipped: row.skipped ?? 0,
            unread: row.total - (row.read ?? 0) - (row.skipped ?? 0),
        };
    }

    getTitleStats(filter: string, search: string, userId: number | null): TitleStats[] {
        const uid = userId ?? -1;
        const clauses: string[] = [];
        const params: any[] = [uid];
        if (filter !== "all") { clauses.push("COALESCE(uss.state, 'unread') = ?"); params.push(filter); }
        if (search) { clauses.push("(s.id LIKE ? OR s.heading LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
        const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";

        const rows = this.db.prepare(`
      SELECT
        s.rcw_title,
        SUM(CASE WHEN uss.state = 'read'    THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN uss.state = 'skipped' THEN 1 ELSE 0 END) as skipped,
        COUNT(*) as total,
        COUNT(DISTINCT s.chapter) as chapters
      FROM sections s
      LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
      ${where}
      GROUP BY s.rcw_title
    `).all(...params) as any[];

        return rows
            .map((r) => ({
                rcwTitle: r.rcw_title,
                read: r.read ?? 0,
                skipped: r.skipped ?? 0,
                total: r.total,
                unread: r.total - (r.read ?? 0) - (r.skipped ?? 0),
                chapters: r.chapters ?? 0,
            }))
            .sort((a, b) => naturalSort(a.rcwTitle, b.rcwTitle));
    }

    getChapterStats(rcwTitle: string, filter: string, search: string, userId: number | null): ChapterStats[] {
        const uid = userId ?? -1;
        const clauses: string[] = ["s.rcw_title = ?"];
        const params: any[] = [uid, rcwTitle];
        if (filter !== "all") { clauses.push("COALESCE(uss.state, 'unread') = ?"); params.push(filter); }
        if (search) { clauses.push("(s.id LIKE ? OR s.heading LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }

        const rows = this.db.prepare(`
      SELECT
        s.chapter,
        SUM(CASE WHEN uss.state = 'read'    THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN uss.state = 'skipped' THEN 1 ELSE 0 END) as skipped,
        COUNT(*) as total
      FROM sections s
      LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
      WHERE ${clauses.join(" AND ")}
      GROUP BY s.chapter
    `).all(...params) as any[];

        return rows
            .map((r) => ({
                chapter: r.chapter,
                read: r.read ?? 0,
                skipped: r.skipped ?? 0,
                total: r.total,
                unread: r.total - (r.read ?? 0) - (r.skipped ?? 0),
            }))
            .sort((a, b) => naturalSort(a.chapter, b.chapter));
    }

    getSectionList(rcwTitle: string, chapter: string, filter: string, search: string, userId: number | null): SectionInfo[] {
        const uid = userId ?? -1;
        const clauses: string[] = ["s.rcw_title = ?", "s.chapter = ?"];
        const params: any[] = [uid, rcwTitle, chapter];
        if (filter !== "all") { clauses.push("COALESCE(uss.state, 'unread') = ?"); params.push(filter); }
        if (search) { clauses.push("(s.id LIKE ? OR s.heading LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }

        const rows = this.db.prepare(`
      SELECT s.id, s.heading, COALESCE(uss.state, 'unread') as state
      FROM sections s
      LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.sort_order
    `).all(...params) as any[];

        return rows.map((r) => ({
            id: r.id,
            heading: r.heading,
            state: r.state as ReadState,
        }));
    }

    /** First unread section in traversal order, optionally after a given cite. */
    nextUnread(afterCite?: string, userId: number | null = null): string | null {
        const uid = userId ?? -1;
        if (afterCite) {
            const cur = this.db
                .prepare("SELECT sort_order FROM sections WHERE id = ?")
                .get(afterCite) as any;
            if (cur) {
                const next = this.db.prepare(`
          SELECT s.id FROM sections s
          LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
          WHERE COALESCE(uss.state, 'unread') = 'unread' AND s.sort_order > ?
          ORDER BY s.sort_order LIMIT 1
        `).get(uid, cur.sort_order) as any;
                if (next) return next.id;
            }
        }
        const row = this.db.prepare(`
      SELECT s.id FROM sections s
      LEFT JOIN user_section_state uss ON uss.section_id = s.id AND uss.user_id = ?
      WHERE COALESCE(uss.state, 'unread') = 'unread'
      ORDER BY s.sort_order LIMIT 1
    `).get(uid) as any;
        return row?.id ?? null;
    }

    close(): void {
        this.db.close();
    }
}
