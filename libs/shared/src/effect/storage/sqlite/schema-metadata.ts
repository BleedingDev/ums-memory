export interface SqliteTableMetadata<TableName extends string = string> {
  readonly name: TableName;
  readonly ddl: string;
  readonly dependencies: readonly TableName[];
}

export interface SqliteIndexMetadata<
  IndexName extends string = string,
  TableName extends string = string,
> {
  readonly name: IndexName;
  readonly table: TableName;
  readonly unique: boolean;
  readonly ddl: string;
}

export interface SqliteSchemaMetadata<
  TableName extends string = string,
  IndexName extends string = string,
> {
  readonly tables: readonly SqliteTableMetadata<TableName>[];
  readonly indexes: readonly SqliteIndexMetadata<IndexName, TableName>[];
  readonly statements: readonly string[];
  readonly sql: string;
}
