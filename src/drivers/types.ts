export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export interface Driver {
  /** Placeholder syntax the database expects. */
  readonly style: "question" | "dollar";
  run(sql: string, values: unknown[], opts: { maxRows: number; write: boolean; timeoutMs: number }): Promise<QueryResult>;
  close(): Promise<void>;
}
