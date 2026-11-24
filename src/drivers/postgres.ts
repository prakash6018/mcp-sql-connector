// PostgreSQL via the `pg` package (optional dependency: npm install pg).
// Reads run inside a READ ONLY transaction with a statement timeout, so a
// slow or unexpected query is stopped by the database itself.
import type { Driver, QueryResult } from "./types.ts";

export class PostgresDriver implements Driver {
  readonly style = "dollar" as const;
  private pool: any;
  private connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  private async getPool() {
    if (!this.pool) {
      // Optional dependency, loaded only when --postgres is used.
      const mod = "pg";
      const { default: pg } = await import(mod);
      this.pool = new pg.Pool({ connectionString: this.connectionString, max: 4 });
    }
    return this.pool;
  }

  async run(sql: string, values: unknown[], opts: { maxRows: number; write: boolean; timeoutMs: number }): Promise<QueryResult> {
    const client = await (await this.getPool()).connect();
    try {
      await client.query(opts.write ? "BEGIN" : "BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`);
      // Fetch one extra row to know whether the result was cut off.
      const wrapped = opts.write ? sql : `SELECT * FROM (${sql}) AS q LIMIT ${opts.maxRows + 1}`;
      const res = await client.query(wrapped, values);
      await client.query("COMMIT");
      if (opts.write) return { columns: ["changes"], rows: [{ changes: res.rowCount }], truncated: false };
      const truncated = res.rows.length > opts.maxRows;
      return {
        columns: res.fields.map((f: { name: string }) => f.name),
        rows: res.rows.slice(0, opts.maxRows),
        truncated,
      };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
