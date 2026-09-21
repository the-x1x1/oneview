/**
 * Declaration shim for `@duckdb/node-api` — used ONLY when the real package is not
 * installed (tools/dev/typecheck.mjs maps it in and records that in evidence).
 * It declares the minimal surface `packages/history-store/src/duckdb-backend.ts` uses,
 * matching the documented API of @duckdb/node-api ≥ 1.2:
 *
 *   DuckDBInstance.create(path, options?) → instance.connect() → connection.run(sql)
 *   connection.runAndReadAll(sql) → reader.getRows() / reader.getRowObjects() / reader.columnNames()
 */
export type DuckDBValue = null | boolean | number | bigint | string | Uint8Array | DuckDBValue[] | { [key: string]: DuckDBValue } | object;

export declare class DuckDBMaterializedResult {
  get rowCount(): number;
  columnNames(): string[];
  getRows(): DuckDBValue[][];
  getRowObjects(): Record<string, DuckDBValue>[];
}

export declare class DuckDBResultReader {
  get rowCount(): number;
  columnNames(): string[];
  getRows(): DuckDBValue[][];
  getRowObjects(): Record<string, DuckDBValue>[];
}

export declare class DuckDBConnection {
  run(sql: string): Promise<DuckDBMaterializedResult>;
  runAndReadAll(sql: string): Promise<DuckDBResultReader>;
  closeSync(): void;
}

export declare class DuckDBInstance {
  static create(path?: string, options?: Record<string, string>): Promise<DuckDBInstance>;
  connect(): Promise<DuckDBConnection>;
  closeSync(): void;
}
