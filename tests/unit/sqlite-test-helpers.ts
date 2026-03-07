import type {
  DatabaseSync,
  SupportedValueType,
} from "../../libs/shared/src/effect/storage/sqlite/database.ts";

type SqliteParameters = readonly SupportedValueType[];

export const sqliteGet = <TRow extends Record<string, unknown>>(
  database: DatabaseSync,
  sql: string,
  ...parameters: SqliteParameters
): TRow | undefined =>
  database.prepare(sql).get(...parameters) as TRow | undefined;

export const sqliteAll = <TRow extends Record<string, unknown>>(
  database: DatabaseSync,
  sql: string,
  ...parameters: SqliteParameters
): readonly TRow[] =>
  database.prepare(sql).all(...parameters) as readonly TRow[];
