// SQLite through Node's built-in node:sqlite module (Node 22.5+), so the
// server and its tests run with zero dependencies.
import { DatabaseSync } from "node:sqlite";
import type { Driver, QueryResult } from "./types.ts";

export class SqliteDriver implements Driver {
  readonly style = "question" as const;
  private db: DatabaseSync;

  constructor(path: string, allowWrites = false) {
    // Opened read-only unless writes are allowed, so even a bug in the catalogue
    // checks can't modify the database.
    this.db = new DatabaseSync(path, { readOnly: !allowWrites && path !== ":memory:" });
  }

  /** For tests and seeding. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  async run(sql: string, values: unknown[], opts: { maxRows: number; write: boolean }): Promise<QueryResult> {
    const stmt = this.db.prepare(sql);
    if (opts.write) {
      const r = stmt.run(...(values as never[]));
      return { columns: ["changes"], rows: [{ changes: Number(r.changes) }], truncated: false };
    }
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    for (const row of stmt.iterate(...(values as never[]))) {
      if (rows.length === opts.maxRows) {
        truncated = true;
        break;
      }
      rows.push({ ...(row as Record<string, unknown>) });
    }
    const columns = stmt.columns().map((c) => c.name);
    return { columns, rows, truncated };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
