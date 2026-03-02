import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const sqliteStorageSnapshotFormat = "ums-memory/sqlite-storage-snapshot/v1";
export const sqliteStorageSnapshotSignatureAlgorithm = "hmac-sha256";

export const sqliteStorageSnapshotTableNames = Object.freeze([
  "tenants",
  "users",
  "projects",
  "roles",
  "project_memberships",
  "user_role_assignments",
  "scopes",
  "memory_items",
  "evidence",
  "memory_evidence_links",
  "feedback",
  "audit_events",
  "storage_idempotency_ledger",
] as const);

export type SqliteStorageSnapshotTableName = (typeof sqliteStorageSnapshotTableNames)[number];

const sqliteStorageSnapshotTableNameSet: ReadonlySet<string> = new Set(
  sqliteStorageSnapshotTableNames,
);

export type SqliteStorageSnapshotCellValue = string | number | null;
export type SqliteStorageSnapshotRow = readonly SqliteStorageSnapshotCellValue[];

export interface SqliteStorageSnapshotTable {
  readonly name: SqliteStorageSnapshotTableName;
  readonly columns: readonly string[];
  readonly rows: readonly SqliteStorageSnapshotRow[];
}

export interface SqliteStorageSnapshotData {
  readonly format: typeof sqliteStorageSnapshotFormat;
  readonly userVersion: number;
  readonly tables: readonly SqliteStorageSnapshotTable[];
}

type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

interface SqliteTableColumnMetadata {
  readonly name: string;
  readonly cid: number;
  readonly pkOrder: number;
}

interface SelfReferenceOrderingOptions {
  readonly tableName: string;
  readonly partitionColumnName: string;
  readonly keyColumnName: string;
  readonly parentColumnName: string;
}

const compareStringsAscending = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const isPlainRecordObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const toNonNegativeSafeInteger = (value: unknown, label: string): number => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer. Received: ${value}.`);
    }
    return value;
  }

  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(
        `${label} must be a non-negative safe integer. Received: ${value.toString()}.`,
      );
    }
    return Number(value);
  }

  throw new TypeError(`${label} must be a non-negative SQLite integer value.`);
};

const toSafeInteger = (value: unknown, label: string): number => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must be a safe integer. Received: ${value}.`);
    }
    return value;
  }

  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${label} must be a safe integer. Received: ${value.toString()}.`);
    }
    return Number(value);
  }

  throw new TypeError(`${label} must be a SQLite integer value.`);
};

const normalizeCanonicalJsonValue = (value: unknown, path: string): CanonicalJsonValue => {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must be a finite safe integer.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeCanonicalJsonValue(entry, `${path}[${index}]`));
  }
  if (typeof value !== "object" || !isPlainRecordObject(value)) {
    throw new TypeError(`${path} must contain only plain JSON object values.`);
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort((left, right) =>
    compareStringsAscending(left, right),
  );
  const normalizedEntries = sortedKeys.map((key) => {
    const childValue = record[key];
    if (childValue === undefined) {
      throw new TypeError(`${path}.${key} must be defined.`);
    }
    return [key, normalizeCanonicalJsonValue(childValue, `${path}.${key}`)] as const;
  });
  return Object.fromEntries(normalizedEntries);
};

const toCanonicalJsonString = (value: unknown): string =>
  JSON.stringify(normalizeCanonicalJsonValue(value, "snapshot"));

const readRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object record.`);
  }
  if (!isPlainRecordObject(value)) {
    throw new TypeError(`${label} must be a plain object record.`);
  }
  return value as Record<string, unknown>;
};

const readNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string value.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${label} must be a non-empty string value.`);
  }
  return trimmed;
};

const readSnapshotCellValueFromSqlite = (
  value: unknown,
  label: string,
): SqliteStorageSnapshotCellValue => {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return toSafeInteger(value, label);
  }

  throw new TypeError(`${label} must be null, string, or integer.`);
};

const readSnapshotCellValueFromJson = (
  value: unknown,
  label: string,
): SqliteStorageSnapshotCellValue => {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${label} must be a finite safe integer number.`);
    }
    return value;
  }

  throw new TypeError(`${label} must be null, string, or integer.`);
};

const readPragmaUserVersion = (database: DatabaseSync): number => {
  const pragmaRow = readRecord(
    database.prepare("PRAGMA user_version;").get(),
    "PRAGMA user_version row",
  );
  if (!Object.hasOwn(pragmaRow, "user_version")) {
    throw new TypeError("PRAGMA user_version row did not include user_version.");
  }
  return toNonNegativeSafeInteger(pragmaRow["user_version"], "PRAGMA user_version");
};

const readTableColumnMetadata = (
  database: DatabaseSync,
  tableName: SqliteStorageSnapshotTableName,
): readonly SqliteTableColumnMetadata[] => {
  const pragmaSql = `PRAGMA table_info(${quoteIdentifier(tableName)});`;
  const pragmaRows = database.prepare(pragmaSql).all() as readonly unknown[];
  if (pragmaRows.length === 0) {
    throw new Error(`PRAGMA table_info returned no columns for table ${tableName}.`);
  }

  const metadata = pragmaRows.map((row, index) => {
    const rowRecord = readRecord(row, `${tableName}.table_info[${index}]`);
    const name = readNonEmptyString(rowRecord["name"], `${tableName}.table_info[${index}].name`);
    const cid = toNonNegativeSafeInteger(rowRecord["cid"], `${tableName}.table_info[${index}].cid`);
    const pkOrder = toNonNegativeSafeInteger(
      rowRecord["pk"],
      `${tableName}.table_info[${index}].pk`,
    );

    return Object.freeze({
      name,
      cid,
      pkOrder,
    });
  });

  return Object.freeze([...metadata].sort((left, right) => left.cid - right.cid));
};

const readTableColumns = (
  database: DatabaseSync,
  tableName: SqliteStorageSnapshotTableName,
): readonly string[] =>
  Object.freeze(readTableColumnMetadata(database, tableName).map((column) => column.name));

const readTablePrimaryKeyColumns = (
  database: DatabaseSync,
  tableName: SqliteStorageSnapshotTableName,
): readonly string[] => {
  const columns = readTableColumnMetadata(database, tableName)
    .filter((column) => column.pkOrder > 0)
    .sort((left, right) => left.pkOrder - right.pkOrder)
    .map((column) => column.name);
  return Object.freeze(columns);
};

const readColumnValue = (
  row: Record<string, unknown>,
  columnName: string,
  label: string,
): unknown => {
  if (!Object.hasOwn(row, columnName)) {
    throw new Error(`${label} is missing required column ${columnName}.`);
  }
  return row[columnName];
};

const findColumnIndex = (
  tableName: string,
  columns: readonly string[],
  columnName: string,
): number => {
  const columnIndex = columns.indexOf(columnName);
  if (columnIndex === -1) {
    throw new Error(`${tableName} snapshot is missing required column ${columnName}.`);
  }
  return columnIndex;
};

const sortRowsBySelfReference = (
  rows: readonly SqliteStorageSnapshotRow[],
  columns: readonly string[],
  options: SelfReferenceOrderingOptions,
): readonly SqliteStorageSnapshotRow[] => {
  if (rows.length === 0) {
    return rows;
  }

  const partitionColumnIndex = findColumnIndex(
    options.tableName,
    columns,
    options.partitionColumnName,
  );
  const keyColumnIndex = findColumnIndex(options.tableName, columns, options.keyColumnName);
  const parentColumnIndex = findColumnIndex(options.tableName, columns, options.parentColumnName);

  const nodesByPartition = new Map<
    string,
    Map<
      string,
      {
        readonly row: SqliteStorageSnapshotRow;
        readonly parent: string | null;
      }
    >
  >();

  for (const row of rows) {
    const partitionValue = row[partitionColumnIndex];
    if (typeof partitionValue !== "string" || partitionValue.length === 0) {
      throw new TypeError(
        `${options.tableName}.${options.partitionColumnName} must be a non-empty string.`,
      );
    }
    const keyValue = row[keyColumnIndex];
    if (typeof keyValue !== "string" || keyValue.length === 0) {
      throw new TypeError(
        `${options.tableName}.${options.keyColumnName} must be a non-empty string.`,
      );
    }
    const parentValue = row[parentColumnIndex];
    if (parentValue !== null && (typeof parentValue !== "string" || parentValue.length === 0)) {
      throw new TypeError(
        `${options.tableName}.${options.parentColumnName} must be a string or null.`,
      );
    }

    let partitionNodes = nodesByPartition.get(partitionValue);
    if (partitionNodes === undefined) {
      partitionNodes = new Map();
      nodesByPartition.set(partitionValue, partitionNodes);
    }
    if (partitionNodes.has(keyValue)) {
      throw new Error(
        `${options.tableName} contains duplicate key ${keyValue} in partition ${partitionValue}.`,
      );
    }
    partitionNodes.set(keyValue, {
      row,
      parent: parentValue,
    });
  }

  const orderedRows: SqliteStorageSnapshotRow[] = [];
  const orderedPartitions = [...nodesByPartition.keys()].sort((left, right) =>
    compareStringsAscending(left, right),
  );
  for (const partition of orderedPartitions) {
    const partitionNodes = nodesByPartition.get(partition);
    if (partitionNodes === undefined) {
      continue;
    }
    const orderedKeys = [...partitionNodes.keys()].sort((left, right) =>
      compareStringsAscending(left, right),
    );
    const visitState = new Map<string, 0 | 1 | 2>();
    const visit = (key: string): void => {
      const state = visitState.get(key) ?? 0;
      if (state === 2) {
        return;
      }
      if (state === 1) {
        throw new Error(
          `${options.tableName} contains a cycle for partition ${partition} at key ${key}.`,
        );
      }
      const node = partitionNodes.get(key);
      if (node === undefined) {
        throw new Error(
          `${options.tableName} references missing key ${key} in partition ${partition}.`,
        );
      }
      visitState.set(key, 1);
      if (node.parent !== null) {
        if (!partitionNodes.has(node.parent)) {
          throw new Error(
            `${options.tableName} key ${key} references missing parent ${node.parent} in partition ${partition}.`,
          );
        }
        visit(node.parent);
      }
      visitState.set(key, 2);
      orderedRows.push(node.row);
    };

    for (const key of orderedKeys) {
      visit(key);
    }
  }

  return Object.freeze(orderedRows);
};

const orderRowsForImport = (
  table: SqliteStorageSnapshotTable,
): readonly SqliteStorageSnapshotRow[] => {
  if (table.name === "scopes") {
    return sortRowsBySelfReference(table.rows, table.columns, {
      tableName: table.name,
      partitionColumnName: "tenant_id",
      keyColumnName: "scope_id",
      parentColumnName: "parent_scope_id",
    });
  }
  if (table.name === "memory_items") {
    return sortRowsBySelfReference(table.rows, table.columns, {
      tableName: table.name,
      partitionColumnName: "tenant_id",
      keyColumnName: "memory_id",
      parentColumnName: "supersedes_memory_id",
    });
  }
  return table.rows;
};

const parseSqliteStorageSnapshotTable = (
  value: unknown,
  tableIndex: number,
): SqliteStorageSnapshotTable => {
  const tableRecord = readRecord(value, `snapshot.tables[${tableIndex}]`);
  const name = readNonEmptyString(tableRecord["name"], `snapshot.tables[${tableIndex}].name`);
  if (!sqliteStorageSnapshotTableNameSet.has(name)) {
    throw new RangeError(`snapshot.tables[${tableIndex}].name contains unknown table ${name}.`);
  }

  const columnsValue = tableRecord["columns"];
  if (!Array.isArray(columnsValue) || columnsValue.length === 0) {
    throw new TypeError(`snapshot.tables[${tableIndex}].columns must be a non-empty array.`);
  }
  const columns = columnsValue.map((columnValue, columnIndex) =>
    readNonEmptyString(columnValue, `snapshot.tables[${tableIndex}].columns[${columnIndex}]`),
  );
  if (new Set(columns).size !== columns.length) {
    throw new TypeError(`snapshot.tables[${tableIndex}].columns must not contain duplicates.`);
  }

  const rowsValue = tableRecord["rows"];
  if (!Array.isArray(rowsValue)) {
    throw new TypeError(`snapshot.tables[${tableIndex}].rows must be an array.`);
  }
  const rows = rowsValue.map((rowValue, rowIndex) => {
    if (!Array.isArray(rowValue)) {
      throw new TypeError(`snapshot.tables[${tableIndex}].rows[${rowIndex}] must be an array.`);
    }
    if (rowValue.length !== columns.length) {
      throw new RangeError(
        `snapshot.tables[${tableIndex}].rows[${rowIndex}] must contain ${columns.length} values.`,
      );
    }
    return Object.freeze(
      rowValue.map((cellValue, cellIndex) =>
        readSnapshotCellValueFromJson(
          cellValue,
          `snapshot.tables[${tableIndex}].rows[${rowIndex}][${cellIndex}]`,
        ),
      ),
    );
  });

  return Object.freeze({
    name: name as SqliteStorageSnapshotTableName,
    columns: Object.freeze(columns),
    rows: Object.freeze(rows),
  });
};

export const exportSqliteStorageSnapshotData = (
  database: DatabaseSync,
): SqliteStorageSnapshotData => {
  const tables = sqliteStorageSnapshotTableNames.map((tableName) => {
    const columns = readTableColumns(database, tableName);
    const primaryKeyColumns = readTablePrimaryKeyColumns(database, tableName);
    const orderByColumns = primaryKeyColumns.length > 0 ? primaryKeyColumns : columns;
    if (orderByColumns.length === 0) {
      throw new Error(`Cannot export table ${tableName} because it has no columns.`);
    }

    const selectSql = [
      `SELECT ${columns.map((column) => quoteIdentifier(column)).join(", ")}`,
      `FROM ${quoteIdentifier(tableName)}`,
      `ORDER BY ${orderByColumns.map((column) => `${quoteIdentifier(column)} ASC`).join(", ")};`,
    ].join("\n");
    const rowRecords = database.prepare(selectSql).all() as readonly unknown[];
    const rows = rowRecords.map((rowRecord, rowIndex) => {
      const record = readRecord(rowRecord, `${tableName}.rows[${rowIndex}]`);
      const row = columns.map((columnName, columnIndex) =>
        readSnapshotCellValueFromSqlite(
          readColumnValue(record, columnName, `${tableName}.rows[${rowIndex}]`),
          `${tableName}.rows[${rowIndex}][${columnIndex}]`,
        ),
      );
      return Object.freeze(row);
    });

    return Object.freeze({
      name: tableName,
      columns,
      rows: Object.freeze(rows),
    });
  });

  return Object.freeze({
    format: sqliteStorageSnapshotFormat,
    userVersion: readPragmaUserVersion(database),
    tables: Object.freeze(tables),
  });
};

export const parseSqliteStorageSnapshotPayload = (payload: string): SqliteStorageSnapshotData => {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payload);
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : String(cause);
    throw new TypeError(`Snapshot payload must be valid JSON: ${details}`);
  }

  const snapshotRecord = readRecord(parsedPayload, "snapshot");
  const format = readNonEmptyString(snapshotRecord["format"], "snapshot.format");
  if (format !== sqliteStorageSnapshotFormat) {
    throw new RangeError(
      `snapshot.format must equal ${sqliteStorageSnapshotFormat}; received ${format}.`,
    );
  }
  const userVersion = toNonNegativeSafeInteger(
    snapshotRecord["userVersion"],
    "snapshot.userVersion",
  );

  const tablesValue = snapshotRecord["tables"];
  if (!Array.isArray(tablesValue)) {
    throw new TypeError("snapshot.tables must be an array.");
  }
  if (tablesValue.length !== sqliteStorageSnapshotTableNames.length) {
    throw new RangeError(
      `snapshot.tables must contain ${sqliteStorageSnapshotTableNames.length} tables in deterministic order.`,
    );
  }

  const tables = tablesValue.map((tableValue, tableIndex) => {
    const parsedTable = parseSqliteStorageSnapshotTable(tableValue, tableIndex);
    const expectedTableName = sqliteStorageSnapshotTableNames[tableIndex];
    if (parsedTable.name !== expectedTableName) {
      throw new RangeError(
        `snapshot.tables[${tableIndex}].name must be ${expectedTableName}; received ${parsedTable.name}.`,
      );
    }
    return parsedTable;
  });

  return Object.freeze({
    format: sqliteStorageSnapshotFormat,
    userVersion,
    tables: Object.freeze(tables),
  });
};

export const serializeSqliteStorageSnapshotData = (
  snapshotData: SqliteStorageSnapshotData,
): string => toCanonicalJsonString(snapshotData);

export const countSqliteStorageSnapshotRows = (snapshotData: SqliteStorageSnapshotData): number =>
  snapshotData.tables.reduce((total, table) => total + table.rows.length, 0);

export const assertSqliteStorageSnapshotSchemaCompatibility = (
  database: DatabaseSync,
  snapshotData: SqliteStorageSnapshotData,
): void => {
  if (snapshotData.format !== sqliteStorageSnapshotFormat) {
    throw new RangeError(
      `snapshot.format must equal ${sqliteStorageSnapshotFormat}; received ${snapshotData.format}.`,
    );
  }

  const currentUserVersion = readPragmaUserVersion(database);
  if (snapshotData.userVersion !== currentUserVersion) {
    throw new RangeError(
      `snapshot.userVersion ${snapshotData.userVersion} does not match database user_version ${currentUserVersion}.`,
    );
  }

  for (const [tableIndex, table] of snapshotData.tables.entries()) {
    const expectedTableName = sqliteStorageSnapshotTableNames[tableIndex];
    if (table.name !== expectedTableName) {
      throw new RangeError(
        `snapshot.tables[${tableIndex}].name must be ${expectedTableName}; received ${table.name}.`,
      );
    }

    const expectedColumns = readTableColumns(database, expectedTableName);
    if (table.columns.length !== expectedColumns.length) {
      throw new RangeError(
        `snapshot table ${table.name} column length mismatch: expected ${expectedColumns.length}, received ${table.columns.length}.`,
      );
    }
    for (const [columnIndex, expectedColumn] of expectedColumns.entries()) {
      const receivedColumn = table.columns[columnIndex];
      if (receivedColumn !== expectedColumn) {
        throw new RangeError(
          `snapshot table ${table.name} column ${columnIndex} mismatch: expected ${expectedColumn}, received ${receivedColumn}.`,
        );
      }
    }
  }
};

export const applySqliteStorageSnapshotData = (
  database: DatabaseSync,
  snapshotData: SqliteStorageSnapshotData,
): void => {
  assertSqliteStorageSnapshotSchemaCompatibility(database, snapshotData);

  const deleteOrder = [...sqliteStorageSnapshotTableNames].reverse();
  for (const tableName of deleteOrder) {
    database.exec(`DELETE FROM ${quoteIdentifier(tableName)};`);
  }

  for (const table of snapshotData.tables) {
    if (table.rows.length === 0) {
      continue;
    }

    const orderedRows = orderRowsForImport(table);
    const insertSql = [
      `INSERT INTO ${quoteIdentifier(table.name)} (${table.columns
        .map((column) => quoteIdentifier(column))
        .join(", ")})`,
      `VALUES (${table.columns.map(() => "?").join(", ")});`,
    ].join("\n");
    const insertStatement = database.prepare(insertSql);
    for (const row of orderedRows) {
      insertStatement.run(...row);
    }
  }
};

export const createSqliteStorageSnapshotSignature = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

export const verifySqliteStorageSnapshotSignature = (
  payload: string,
  signatureHex: string,
  secret: string,
): boolean => {
  const normalizedSignature = signatureHex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedSignature)) {
    return false;
  }

  const expectedSignature = createSqliteStorageSnapshotSignature(payload, secret);
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const receivedBuffer = Buffer.from(normalizedSignature, "hex");
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
};
