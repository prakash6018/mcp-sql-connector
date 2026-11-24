// A Model Context Protocol (MCP) server that exposes a catalogue of named SQL
// queries as tools. Transport: JSON-RPC 2.0 over stdio, one message per line.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { compile, inputSchema, ParamError, validateCatalog, type QuerySpec } from "./catalog.ts";
import type { Driver } from "./drivers/types.ts";

export const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_MAX_ROWS = 100;

export interface ServerOptions {
  driver: Driver;
  queries: QuerySpec[];
  allowWrites?: boolean;
  timeoutMs?: number;
  audit?: (entry: Record<string, unknown>) => void;
}

type Json = Record<string, any>;

export class SqlMcpServer {
  private byName: Map<string, QuerySpec>;
  private opts: ServerOptions;

  constructor(opts: ServerOptions) {
    this.opts = opts;
    this.byName = new Map(validateCatalog(opts.queries).map((q) => [q.name, q]));
  }

  private tools() {
    return [...this.byName.values()]
      .filter((q) => !q.write || this.opts.allowWrites)
      .map((q) => ({
        name: q.name,
        description: q.description + (q.write ? " (writes data)" : " (read-only)"),
        inputSchema: inputSchema(q),
        annotations: { readOnlyHint: !q.write, destructiveHint: !!q.write },
      }));
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    const q = this.byName.get(name);
    const started = Date.now();
    const auditArgs = Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, q?.params?.[k]?.pii ? "***" : v]),
    );
    const done = (isError: boolean, text: string, extra: Json = {}) => {
      this.opts.audit?.({ tool: name, args: auditArgs, ok: !isError, ms: Date.now() - started, ...extra });
      return { content: [{ type: "text", text }], isError };
    };
    if (!q) return done(true, `Unknown tool: ${name}`);
    if (q.write && !this.opts.allowWrites) return done(true, "Writes are disabled on this server.");
    try {
      const { sql, values } = compile(q, args, this.opts.driver.style);
      const maxRows = Math.min(q.maxRows ?? DEFAULT_MAX_ROWS, 1000);
      const res = await this.opts.driver.run(sql, values, {
        maxRows,
        write: !!q.write,
        timeoutMs: this.opts.timeoutMs ?? 5000,
      });
      const note = res.truncated ? `\n(Only the first ${maxRows} rows are shown.)` : "";
      return done(false, JSON.stringify({ columns: res.columns, rows: res.rows, truncated: res.truncated }) + note, {
        rows: res.rows.length,
        truncated: res.truncated,
      });
    } catch (e) {
      // Parameter problems are explained so the model can retry; database
      // errors are summarised without echoing SQL or internals.
      const msg = e instanceof ParamError ? `Invalid arguments: ${e.message}` : "The query failed. Check the arguments or try another query.";
      return done(true, msg, { error: (e as Error).message });
    }
  }

  /** Handle one JSON-RPC message. Returns the response, or null for notifications. */
  async handle(msg: Json): Promise<Json | null> {
    const reply = (result: Json) => ({ jsonrpc: "2.0", id: msg.id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(-32600, "Invalid Request");
    const isNotification = msg.id === undefined;
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mcp-sql-connector", version: "0.1.0" },
          instructions: "Each tool runs one fixed, reviewed SQL query. Pass parameter values only.",
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: this.tools() });
      case "tools/call": {
        const { name, arguments: args = {} } = msg.params ?? {};
        if (typeof name !== "string" || typeof args !== "object" || Array.isArray(args))
          return error(-32602, "Invalid params");
        return reply(await this.callTool(name, args));
      }
      default:
        return isNotification ? null : error(-32601, `Method not found: ${msg.method}`);
    }
  }

  /** Serve over stdin/stdout. Logs go to stderr so they never corrupt the protocol stream. */
  serveStdio(): void {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        return;
      }
      const res = await this.handle(msg);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    });
    rl.on("close", () => this.opts.driver.close());
  }
}

// CLI:  node src/server.ts --catalog examples/queries.json --sqlite examples/shop.db
//       node src/server.ts --catalog queries.json --postgres $DATABASE_URL
async function main() {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const catalog = arg("--catalog");
  if (!catalog) throw new Error("--catalog <queries.json> is required");
  const allowWrites = process.argv.includes("--allow-writes");
  let driver: Driver;
  if (arg("--postgres")) {
    const { PostgresDriver } = await import("./drivers/postgres.ts");
    driver = new PostgresDriver(arg("--postgres")!);
  } else {
    const { SqliteDriver } = await import("./drivers/sqlite.ts");
    driver = new SqliteDriver(arg("--sqlite") ?? ":memory:", allowWrites);
  }
  const queries = JSON.parse(readFileSync(catalog, "utf8")) as QuerySpec[];
  new SqlMcpServer({
    driver,
    queries,
    allowWrites,
    timeoutMs: Number(arg("--timeout-ms") ?? 5000),
    audit: (e) => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n"),
  }).serveStdio();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`mcp-sql-connector: ${e.message}\n`);
    process.exit(1);
  });
}
