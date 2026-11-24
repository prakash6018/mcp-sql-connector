// The query catalogue: the only SQL this server will ever run.
//
// An LLM never writes SQL here. It picks a named query and supplies parameter
// values; the values are validated against the declared schema and bound as
// positional parameters, so they can't change the statement.

export type ParamType = "string" | "integer" | "number" | "boolean" | "date";

export interface ParamSpec {
  type: ParamType;
  description?: string;
  required?: boolean;
  enum?: (string | number)[];
  min?: number;
  max?: number;
  maxLength?: number;
  /** Personal data: the value is masked in the audit log. */
  pii?: boolean;
}

export interface QuerySpec {
  name: string;
  description: string;
  sql: string;
  params?: Record<string, ParamSpec>;
  /** Writes are refused unless the query is marked and the server allows writes. */
  write?: boolean;
  maxRows?: number;
}

export interface CompiledQuery {
  sql: string;
  values: unknown[];
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g;
const WRITE_RE = /^\s*(insert|update|delete|merge|upsert|replace|create|alter|drop|truncate|grant|revoke|copy|call|do)\b/i;

export class CatalogError extends Error {}
export class ParamError extends Error {}

/** Remove string literals and comments so keyword checks only see real SQL. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

export function validateCatalog(queries: QuerySpec[]): QuerySpec[] {
  const seen = new Set<string>();
  for (const q of queries) {
    if (!NAME_RE.test(q.name)) throw new CatalogError(`bad query name: ${q.name}`);
    if (seen.has(q.name)) throw new CatalogError(`duplicate query name: ${q.name}`);
    seen.add(q.name);
    const bare = stripLiteralsAndComments(q.sql).trim().replace(/;\s*$/, "");
    if (bare.includes(";")) throw new CatalogError(`${q.name}: one statement per query`);
    const isWrite = WRITE_RE.test(bare) || /\bwith\b[\s\S]*\b(insert|update|delete)\b/i.test(bare);
    if (isWrite && !q.write) throw new CatalogError(`${q.name}: looks like a write but is not marked write: true`);
    const used = new Set([...bare.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
    const declared = new Set(Object.keys(q.params ?? {}));
    for (const p of used) if (!declared.has(p)) throw new CatalogError(`${q.name}: :${p} is not declared`);
    for (const p of declared) if (!used.has(p)) throw new CatalogError(`${q.name}: param ${p} is never used`);
  }
  return queries;
}

function checkValue(name: string, spec: ParamSpec, raw: unknown): unknown {
  const fail = (msg: string) => new ParamError(`${name}: ${msg}`);
  let v: unknown = raw;
  switch (spec.type) {
    case "string":
      if (typeof v !== "string") throw fail("expected a string");
      if (spec.maxLength !== undefined && v.length > spec.maxLength) throw fail(`longer than ${spec.maxLength}`);
      break;
    case "integer":
      if (typeof v !== "number" || !Number.isInteger(v)) throw fail("expected an integer");
      break;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) throw fail("expected a number");
      break;
    case "boolean":
      if (typeof v !== "boolean") throw fail("expected true or false");
      v = v ? 1 : 0;
      break;
    case "date":
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))
        throw fail("expected a date as YYYY-MM-DD");
      break;
  }
  if (spec.enum && !spec.enum.includes(raw as string | number)) throw fail(`must be one of ${spec.enum.join(", ")}`);
  if (typeof v === "number" && spec.min !== undefined && v < spec.min) throw fail(`must be >= ${spec.min}`);
  if (typeof v === "number" && spec.max !== undefined && v > spec.max) throw fail(`must be <= ${spec.max}`);
  return v;
}

/**
 * Validate the arguments and turn `:name` placeholders into positional
 * parameters. `style` picks the driver's placeholder syntax.
 */
export function compile(
  q: QuerySpec,
  args: Record<string, unknown>,
  style: "question" | "dollar",
): CompiledQuery {
  const specs = q.params ?? {};
  for (const k of Object.keys(args)) if (!(k in specs)) throw new ParamError(`unknown parameter: ${k}`);
  const checked: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (args[name] === undefined || args[name] === null) {
      if (spec.required !== false) throw new ParamError(`${name}: required`);
      checked[name] = null;
    } else {
      checked[name] = checkValue(name, spec, args[name]);
    }
  }
  const values: unknown[] = [];
  const index = new Map<string, number>();
  const sql = q.sql.trim().replace(/;\s*$/, "").replace(PLACEHOLDER_RE, (_m, name: string) => {
    if (!index.has(name) || style === "question") {
      values.push(checked[name]);
      index.set(name, values.length);
    }
    return style === "dollar" ? `$${index.get(name)}` : "?";
  });
  return { sql, values };
}

/** JSON Schema for a query's parameters, as MCP tools/list expects. */
export function inputSchema(q: QuerySpec) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, s] of Object.entries(q.params ?? {})) {
    const type = s.type === "date" ? "string" : s.type;
    properties[name] = {
      type,
      ...(s.description ? { description: s.description } : {}),
      ...(s.type === "date" ? { format: "date" } : {}),
      ...(s.enum ? { enum: s.enum } : {}),
      ...(s.min !== undefined ? { minimum: s.min } : {}),
      ...(s.max !== undefined ? { maximum: s.max } : {}),
      ...(s.maxLength !== undefined ? { maxLength: s.maxLength } : {}),
    };
    if (s.required !== false) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
