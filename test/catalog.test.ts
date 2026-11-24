import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, inputSchema, validateCatalog, CatalogError, ParamError, type QuerySpec } from "../src/catalog.ts";

const q = (over: Partial<QuerySpec>): QuerySpec => ({ name: "q", description: "d", sql: "SELECT 1", ...over });

test("rejects multiple statements", () => {
  assert.throws(() => validateCatalog([q({ sql: "SELECT 1; DROP TABLE users" })]), CatalogError);
});

test("a semicolon inside a string literal is fine", () => {
  validateCatalog([q({ sql: "SELECT 'a;b' AS x" })]);
});

test("writes must be marked", () => {
  assert.throws(() => validateCatalog([q({ sql: "DELETE FROM orders" })]), /not marked write/);
  assert.throws(() => validateCatalog([q({ sql: "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x" })]), /not marked write/);
  validateCatalog([q({ sql: "DELETE FROM orders", write: true })]);
});

test("placeholders and declared params must match", () => {
  assert.throws(() => validateCatalog([q({ sql: "SELECT :a" })]), /not declared/);
  assert.throws(() => validateCatalog([q({ sql: "SELECT 1", params: { a: { type: "string" } } })]), /never used/);
});

test("postgres casts are not placeholders", () => {
  validateCatalog([q({ sql: "SELECT :d::date", params: { d: { type: "date" } } })]);
});

test("duplicate and bad names", () => {
  assert.throws(() => validateCatalog([q({}), q({})]), /duplicate/);
  assert.throws(() => validateCatalog([q({ name: "Drop Table" })]), /bad query name/);
});

const byStatus = q({
  sql: "SELECT * FROM o WHERE status = :s AND total > :min OR status = :s",
  params: { s: { type: "string", enum: ["paid", "shipped"] }, min: { type: "integer", min: 0 } },
});

test("compiles to ? placeholders for sqlite", () => {
  const c = compile(byStatus, { s: "paid", min: 5 }, "question");
  assert.equal(c.sql, "SELECT * FROM o WHERE status = ? AND total > ? OR status = ?");
  assert.deepEqual(c.values, ["paid", 5, "paid"]);
});

test("compiles to $n placeholders for postgres, reusing repeated names", () => {
  const c = compile(byStatus, { s: "paid", min: 5 }, "dollar");
  assert.equal(c.sql, "SELECT * FROM o WHERE status = $1 AND total > $2 OR status = $1");
  assert.deepEqual(c.values, ["paid", 5]);
});

test("injection attempts are just values", () => {
  const c = compile(q({ sql: "SELECT * FROM c WHERE email = :e", params: { e: { type: "string" } } }), { e: "x' OR '1'='1" }, "question");
  assert.equal(c.sql, "SELECT * FROM c WHERE email = ?");
  assert.deepEqual(c.values, ["x' OR '1'='1"]);
});

test("argument validation", () => {
  assert.throws(() => compile(byStatus, { s: "lost", min: 1 }, "question"), ParamError);
  assert.throws(() => compile(byStatus, { s: "paid", min: -1 }, "question"), />= 0/);
  assert.throws(() => compile(byStatus, { s: "paid", min: 1.5 }, "question"), /integer/);
  assert.throws(() => compile(byStatus, { s: "paid" }, "question"), /required/);
  assert.throws(() => compile(byStatus, { s: "paid", min: 1, extra: 1 }, "question"), /unknown parameter/);
  const d = q({ sql: "SELECT :d", params: { d: { type: "date" } } });
  assert.throws(() => compile(d, { d: "23/11/2026" }, "question"), /YYYY-MM-DD/);
});

test("input schema", () => {
  const s = inputSchema(q({ sql: "SELECT :d, :n", params: { d: { type: "date" }, n: { type: "integer", required: false, max: 9 } } }));
  assert.deepEqual(s, {
    type: "object",
    properties: { d: { type: "string", format: "date" }, n: { type: "integer", maximum: 9 } },
    required: ["d"],
    additionalProperties: false,
  });
});
