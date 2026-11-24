import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { SqlMcpServer } from "../src/server.ts";
import { SqliteDriver } from "../src/drivers/sqlite.ts";
import type { QuerySpec } from "../src/catalog.ts";

const root = new URL("..", import.meta.url).pathname;
const queries = JSON.parse(readFileSync(root + "examples/queries.json", "utf8")) as QuerySpec[];

function makeServer(allowWrites = false) {
  const driver = new SqliteDriver(":memory:", true);
  driver.exec(readFileSync(root + "examples/seed.sql", "utf8"));
  const audit: Record<string, unknown>[] = [];
  const server = new SqlMcpServer({ driver, queries, allowWrites, audit: (e) => audit.push(e) });
  let id = 0;
  const call = (method: string, params?: unknown) => server.handle({ jsonrpc: "2.0", id: ++id, method, params });
  const tool = async (name: string, args: unknown) => (await call("tools/call", { name, arguments: args }))!.result;
  return { call, tool, audit };
}

test("initialize advertises tools", async () => {
  const { call } = makeServer();
  const r = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(r!.result.serverInfo.name, "mcp-sql-connector");
  assert.ok(r!.result.capabilities.tools);
});

test("write tools are hidden unless writes are allowed", async () => {
  const ro = (await makeServer().call("tools/list"))!.result.tools.map((t: any) => t.name);
  assert.ok(!ro.includes("add_support_note"));
  const rw = (await makeServer(true).call("tools/list"))!.result.tools.map((t: any) => t.name);
  assert.ok(rw.includes("add_support_note"));
});

test("runs a query and returns rows", async () => {
  const r = await makeServer().tool("revenue_by_city", { from: "2026-03-01", to: "2026-04-30" });
  assert.equal(r.isError, false);
  const data = JSON.parse(r.content[0].text);
  assert.deepEqual(data.columns, ["city", "orders", "revenue_inr"]);
  assert.deepEqual(data.rows[0], { city: "Hyderabad", orders: 4, revenue_inr: 4896 });
});

test("bad arguments come back as a tool error the model can read", async () => {
  const r = await makeServer().tool("orders_by_status", { status: "paid; DROP TABLE orders" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /must be one of/);
});

test("row cap truncates", async () => {
  const small = queries.map((q) => (q.name === "orders_by_status" ? { ...q, maxRows: 2 } : q));
  const { SqlMcpServer: S } = await import("../src/server.ts");
  const driver = new SqliteDriver(":memory:", true);
  driver.exec(readFileSync(root + "examples/seed.sql", "utf8"));
  const server = new S({ driver, queries: small });
  const r = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "orders_by_status", arguments: { status: "paid" } } }))!.result;
  const data = JSON.parse(r.content[0].text.split("\n")[0]);
  assert.equal(data.rows.length, 2);
  assert.equal(data.truncated, true);
});

test("writes are refused when disabled, allowed when enabled", async () => {
  const ro = await makeServer().tool("add_support_note", { order_id: 101, note: "hi" });
  assert.equal(ro.isError, true);
  const rw = makeServer(true);
  const r = await rw.tool("add_support_note", { order_id: 101, note: "Gift wrap requested" });
  assert.equal(r.isError, false);
  assert.deepEqual(JSON.parse(r.content[0].text).rows, [{ changes: 1 }]);
});

test("audit log masks PII parameters", async () => {
  const s = makeServer();
  await s.tool("customer_orders", { email: "asha@example.com" });
  assert.equal(s.audit.length, 1);
  assert.deepEqual(s.audit[0].args, { email: "***" });
  assert.equal(s.audit[0].rows, 2);
});

test("JSON-RPC errors", async () => {
  const { call } = makeServer();
  assert.equal((await call("nope"))!.error.code, -32601);
  assert.equal((await call("tools/call", { name: 5 }))!.error.code, -32602);
});

test("end to end over stdio", async () => {
  const child = spawn(process.execPath, [root + "src/server.ts", "--catalog", root + "examples/queries.json", "--sqlite", ":memory:"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: any[] = [];
  child.stdout.setEncoding("utf8");
  let buf = "";
  const got = new Promise<void>((resolve) => {
    child.stdout.on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (lines.length === 2) resolve();
      }
    });
  });
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await got;
  child.stdin.end();
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].result.tools.length, 4);
});
