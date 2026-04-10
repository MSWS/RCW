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
    }

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

    /**
     * Full-text search across heading and body text.
     * Returns up to `limit` results ordered by FTS rank.
     * Silently returns [] on invalid FTS5 query syntax.
     */
    search(query: string, filter = "all", limit = 100): SearchResult[] {
        try {
            const clauses: string[] = ["sections_fts MATCH ?"];
            const params: any[] = [query];
            if (filter !== "all") {
                clauses.push("s.state = ?");
                params.push(filter);
            }
            const rows = this.db.prepare(`
        SELECT
          s.id,
          s.rcw_title,
          s.chapter,
          s.heading,
          s.state,
          snippet(sections_fts, 2, '<mark>', '</mark>', '…', 24) AS snippet
        FROM sections_fts
        JOIN sections s ON s.rowid = sections_fts.rowid
        WHERE ${clauses.join(" AND ")}
        ORDER BY rank
        LIMIT ?
      `).all(...params, limit) as any[];

            return rows.map((r) => ({
                id: r.id,
                rcwTitle: r.rcw_title,
                chapter: r.chapter,
                heading: r.heading,
                snippet: r.snippet,
                state: r.state as ReadState,
            }));
        } catch {
            return [];
        }
    }

    getSection(cite: string): SectionRow | null {
        const row = this.db
            .prepare("SELECT id, rcw_title, chapter, heading, text, state FROM sections WHERE id = ?")
            .get(cite) as any;
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

    setState(cite: string, state: ReadState): void {
        this.db.prepare("UPDATE sections SET state = ? WHERE id = ?").run(state, cite);
    }

    getStats(): { total: number; read: number; skipped: number; unread: number } {
        const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state = 'read'    THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN state = 'skipped' THEN 1 ELSE 0 END) as skipped
      FROM sections
    `).get() as any;
        return {
            total: row.total,
            read: row.read,
            skipped: row.skipped,
            unread: row.total - row.read - row.skipped,
        };
    }

    getTitleStats(filter: string, search: string): TitleStats[] {
        const clauses: string[] = [];
        const params: any[] = [];
        if (filter !== "all") { clauses.push("state = ?"); params.push(filter); }
        if (search) { clauses.push("(id LIKE ? OR heading LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
        const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";

        const rows = this.db.prepare(`
      SELECT
        rcw_title,
        SUM(CASE WHEN state = 'read'    THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN state = 'skipped' THEN 1 ELSE 0 END) as skipped,
        COUNT(*) as total
      FROM sections ${where}
      GROUP BY rcw_title
    `).all(...params) as any[];

        return rows
            .map((r) => ({
                rcwTitle: r.rcw_title,
                read: r.read,
                skipped: r.skipped,
                total: r.total,
                unread: r.total - r.read - r.skipped,
            }))
            .sort((a, b) => naturalSort(a.rcwTitle, b.rcwTitle));
    }

    getChapterStats(rcwTitle: string, filter: string, search: string): ChapterStats[] {
        const clauses: string[] = ["rcw_title = ?"];
        const params: any[] = [rcwTitle];
        if (filter !== "all") { clauses.push("state = ?"); params.push(filter); }
        if (search) { clauses.push("(id LIKE ? OR heading LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }

        const rows = this.db.prepare(`
      SELECT
        chapter,
        SUM(CASE WHEN state = 'read'    THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN state = 'skipped' THEN 1 ELSE 0 END) as skipped,
        COUNT(*) as total
      FROM sections
      WHERE ${clauses.join(" AND ")}
      GROUP BY chapter
    `).all(...params) as any[];

        return rows
            .map((r) => ({
                chapter: r.chapter,
                read: r.read,
                skipped: r.skipped,
                total: r.total,
                unread: r.total - r.read - r.skipped,
            }))
            .sort((a, b) => naturalSort(a.chapter, b.chapter));
    }

    getSectionList(rcwTitle: string, chapter: string, filter: string, search: string): SectionInfo[] {
        const clauses: string[] = ["rcw_title = ?", "chapter = ?"];
        const params: any[] = [rcwTitle, chapter];
        if (filter !== "all") { clauses.push("state = ?"); params.push(filter); }
        if (search) { clauses.push("(id LIKE ? OR heading LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }

        const rows = this.db.prepare(`
      SELECT id, heading, state FROM sections
      WHERE ${clauses.join(" AND ")}
      ORDER BY sort_order
    `).all(...params) as any[];

        return rows.map((r) => ({
            id: r.id,
            heading: r.heading,
            state: r.state as ReadState,
        }));
    }

    /** First unread section in traversal order, optionally after a given cite. */
    nextUnread(afterCite?: string): string | null {
        if (afterCite) {
            const cur = this.db
                .prepare("SELECT sort_order FROM sections WHERE id = ?")
                .get(afterCite) as any;
            if (cur) {
                const next = this.db.prepare(
                    "SELECT id FROM sections WHERE state = 'unread' AND sort_order > ? ORDER BY sort_order LIMIT 1"
                ).get(cur.sort_order) as any;
                if (next) return next.id;
            }
        }
        const row = this.db
            .prepare("SELECT id FROM sections WHERE state = 'unread' ORDER BY sort_order LIMIT 1")
            .get() as any;
        return row?.id ?? null;
    }

    close(): void {
        this.db.close();
    }
}