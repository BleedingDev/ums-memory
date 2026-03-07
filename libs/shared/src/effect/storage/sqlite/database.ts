import { Database } from "bun:sqlite";

export type SupportedValueType =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | ArrayBuffer
  | null;

export interface DatabaseSyncOptions {
  readonly readBigInts?: boolean;
}

export interface StatementSync {
  readonly get: (
    ...params: readonly SupportedValueType[]
  ) => unknown | undefined;
  readonly all: (...params: readonly SupportedValueType[]) => unknown[];
  readonly run: (...params: readonly SupportedValueType[]) => {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  };
}

export class DatabaseSync {
  readonly database: Database;

  constructor(path: string, options?: DatabaseSyncOptions) {
    this.database = options?.readBigInts
      ? new Database(path, { safeIntegers: true })
      : new Database(path);
  }

  prepare(sql: string): StatementSync {
    const statement = this.database.prepare(sql);
    const getStatement = statement.get.bind(statement) as (
      ...params: readonly SupportedValueType[]
    ) => unknown;
    const allStatement = statement.all.bind(statement) as (
      ...params: readonly SupportedValueType[]
    ) => unknown[];
    const runStatement = statement.run.bind(statement) as (
      ...params: readonly SupportedValueType[]
    ) => {
      readonly changes: number;
      readonly lastInsertRowid: number | bigint;
    };

    return {
      get: (...params) => {
        const row = getStatement(...params);
        return row === null ? undefined : row;
      },
      all: (...params) => allStatement(...params),
      run: (...params) => runStatement(...params),
    } satisfies StatementSync;
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }
}
