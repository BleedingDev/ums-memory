export interface PostgresTableMetadata<TableName extends string = string> {
  readonly name: TableName;
  readonly ddl: string;
  readonly dependencies: readonly TableName[];
  readonly migrationVersion: number;
}

export interface PostgresIndexMetadata<
  IndexName extends string = string,
  TableName extends string = string,
> {
  readonly name: IndexName;
  readonly table: TableName;
  readonly unique: boolean;
  readonly ddl: string;
  readonly migrationVersion: number;
}

export interface PostgresTriggerMetadata<
  TriggerName extends string = string,
  TableName extends string = string,
> {
  readonly name: TriggerName;
  readonly table: TableName;
  readonly ddl: string;
  readonly migrationVersion: number;
}

export interface PostgresSchemaMetadata<
  TableName extends string = string,
  IndexName extends string = string,
  TriggerName extends string = string,
> {
  readonly version: number;
  readonly tables: readonly PostgresTableMetadata<TableName>[];
  readonly triggers: readonly PostgresTriggerMetadata<TriggerName, TableName>[];
  readonly indexes: readonly PostgresIndexMetadata<IndexName, TableName>[];
  readonly statements: readonly string[];
  readonly sql: string;
}

const toSqlStringLiteralList = (values: readonly string[]): string =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");

const createTableDdl = (
  tableName: string,
  definitions: readonly string[]
): string =>
  [
    `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    ...definitions.map((definition, index) => {
      const suffix = index === definitions.length - 1 ? "" : ",";
      return `  ${definition}${suffix}`;
    }),
    ");",
  ].join("\n");

export const enterprisePostgresScopeLevels = Object.freeze([
  "common",
  "project",
  "job_role",
  "user",
] as const);
export const enterprisePostgresUserStatuses = Object.freeze([
  "active",
  "disabled",
  "pending",
] as const);
export const enterprisePostgresProjectStatuses = Object.freeze([
  "active",
  "archived",
] as const);
export const enterprisePostgresRoleTypes = Object.freeze([
  "system",
  "project",
  "custom",
] as const);
export const enterprisePostgresIdentityIssuerKinds = Object.freeze([
  "oidc",
  "saml",
  "scim",
] as const);
export const enterprisePostgresIdentitySubjectSources = Object.freeze([
  "sso",
  "scim",
  "manual",
] as const);
export const enterprisePostgresIdentitySyncChannels = Object.freeze([
  "scim_users",
  "scim_groups",
  "sso_jit",
] as const);
export const enterprisePostgresMemoryLayers = Object.freeze([
  "episodic",
  "working",
  "procedural",
] as const);
export const enterprisePostgresMemoryKinds = Object.freeze([
  "note",
  "decision",
  "rule",
  "anti_pattern",
  "summary",
] as const);
export const enterprisePostgresMemoryStatuses = Object.freeze([
  "active",
  "superseded",
  "tombstoned",
] as const);
export const enterprisePostgresEvidenceSourceKinds = Object.freeze([
  "event",
  "artifact",
  "feedback",
  "external_document",
  "test_result",
] as const);
export const enterprisePostgresEvidenceRelationKinds = Object.freeze([
  "supports",
  "contradicts",
  "supersedes",
] as const);
export const enterprisePostgresFeedbackKinds = Object.freeze([
  "helpful",
  "harmful",
  "correction",
  "question",
  "policy_flag",
] as const);
export const enterprisePostgresFeedbackStatuses = Object.freeze([
  "open",
  "resolved",
  "dismissed",
] as const);
export const enterprisePostgresAuditEventOperations = Object.freeze([
  "upsert",
  "delete",
] as const);
export const enterprisePostgresAuditEventOutcomes = Object.freeze([
  "accepted",
  "denied",
  "not_found",
] as const);
export const enterprisePostgresAuditEventReasons = Object.freeze([
  "inserted",
  "updated",
  "stale_replay",
  "equal_replay",
  "deleted",
  "cross_tenant_reference",
  "cross_tenant_delete_probe",
  "memory_not_found",
] as const);
export const enterprisePostgresAuditEventReferenceKinds = Object.freeze([
  "scope",
  "project",
  "role",
  "user",
  "supersedes_memory",
  "memory",
] as const);

export const enterprisePostgresTableNames = Object.freeze([
  "tenants",
  "users",
  "projects",
  "roles",
  "project_memberships",
  "user_role_assignments",
  "identity_issuer_bindings",
  "user_external_subjects",
  "identity_sync_checkpoints",
  "scopes",
  "memory_items",
  "memory_items_fts",
  "evidence",
  "provenance_envelopes",
  "memory_evidence_links",
  "memory_provenance_links",
  "evidence_provenance_links",
  "feedback",
  "audit_events",
  "audit_event_provenance_links",
  "storage_idempotency_ledger",
] as const);

export type EnterprisePostgresTableName =
  (typeof enterprisePostgresTableNames)[number];

type PostgresTableDefinition = {
  readonly name: EnterprisePostgresTableName;
  readonly definitions: readonly string[];
  readonly dependencies: readonly EnterprisePostgresTableName[];
  readonly migrationVersion: number;
};

const postgresTableDefinitions = Object.freeze([
  {
    name: "tenants",
    migrationVersion: 1,
    dependencies: [] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "tenant_slug TEXT NOT NULL",
      "display_name TEXT NOT NULL",
      "created_at_ms BIGINT NOT NULL",
      "updated_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id)",
      "UNIQUE (tenant_slug)",
      "CHECK (btrim(tenant_id) <> '')",
      "CHECK (btrim(tenant_slug) <> '')",
      "CHECK (btrim(display_name) <> '')",
      "CHECK (created_at_ms >= 0)",
      "CHECK (updated_at_ms >= created_at_ms)",
    ],
  },
  {
    name: "users",
    migrationVersion: 1,
    dependencies: ["tenants"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "email TEXT NOT NULL",
      "display_name TEXT NOT NULL",
      "status TEXT NOT NULL",
      "created_at_ms BIGINT NOT NULL",
      "updated_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, user_id)",
      "UNIQUE (tenant_id, email)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (btrim(user_id) <> '')",
      "CHECK (length(email) > 3)",
      "CHECK (position('@' in email) > 1)",
      "CHECK (btrim(display_name) <> '')",
      `CHECK (status IN (${toSqlStringLiteralList(enterprisePostgresUserStatuses)}))`,
      "CHECK (created_at_ms >= 0)",
      "CHECK (updated_at_ms >= created_at_ms)",
    ],
  },
  {
    name: "projects",
    migrationVersion: 1,
    dependencies: ["tenants"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "project_id TEXT NOT NULL",
      "project_key TEXT NOT NULL",
      "display_name TEXT NOT NULL",
      "status TEXT NOT NULL",
      "created_at_ms BIGINT NOT NULL",
      "archived_at_ms BIGINT",
      "PRIMARY KEY (tenant_id, project_id)",
      "UNIQUE (tenant_id, project_key)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (btrim(project_id) <> '')",
      "CHECK (btrim(project_key) <> '')",
      "CHECK (btrim(display_name) <> '')",
      `CHECK (status IN (${toSqlStringLiteralList(enterprisePostgresProjectStatuses)}))`,
      "CHECK (created_at_ms >= 0)",
      "CHECK (archived_at_ms IS NULL OR archived_at_ms >= created_at_ms)",
      [
        "CHECK ((",
        "  status = 'active' AND archived_at_ms IS NULL",
        ") OR (",
        "  status = 'archived' AND archived_at_ms IS NOT NULL AND archived_at_ms >= created_at_ms",
        "))",
      ].join(" "),
    ],
  },
  {
    name: "roles",
    migrationVersion: 1,
    dependencies: ["tenants"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "role_id TEXT NOT NULL",
      "role_code TEXT NOT NULL",
      "display_name TEXT NOT NULL",
      "role_type TEXT NOT NULL",
      "created_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, role_id)",
      "UNIQUE (tenant_id, role_code)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (btrim(role_id) <> '')",
      "CHECK (btrim(role_code) <> '')",
      "CHECK (btrim(display_name) <> '')",
      `CHECK (role_type IN (${toSqlStringLiteralList(enterprisePostgresRoleTypes)}))`,
      "CHECK (created_at_ms >= 0)",
    ],
  },
  {
    name: "project_memberships",
    migrationVersion: 1,
    dependencies: ["tenants", "projects", "users", "roles"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "project_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "role_id TEXT",
      "assigned_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, project_id, user_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, role_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (assigned_at_ms >= 0)",
    ],
  },
  {
    name: "user_role_assignments",
    migrationVersion: 1,
    dependencies: ["tenants", "users", "roles"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "role_id TEXT NOT NULL",
      "assigned_at_ms BIGINT NOT NULL",
      "assigned_by_user_id TEXT",
      "PRIMARY KEY (tenant_id, user_id, role_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, role_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, assigned_by_user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (assigned_at_ms >= 0)",
    ],
  },
  {
    name: "identity_issuer_bindings",
    migrationVersion: 5,
    dependencies: ["tenants"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "issuer_binding_id TEXT NOT NULL",
      "issuer TEXT NOT NULL",
      "issuer_kind TEXT NOT NULL",
      "is_primary BOOLEAN NOT NULL DEFAULT FALSE",
      "created_at_ms BIGINT NOT NULL",
      "updated_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, issuer_binding_id)",
      "UNIQUE (tenant_id, issuer)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (btrim(issuer_binding_id) <> '')",
      "CHECK (issuer_binding_id = btrim(issuer_binding_id))",
      "CHECK (btrim(issuer) <> '')",
      "CHECK (issuer = btrim(issuer))",
      "CHECK (issuer = lower(issuer))",
      `CHECK (issuer_kind IN (${toSqlStringLiteralList(enterprisePostgresIdentityIssuerKinds)}))`,
      "CHECK (created_at_ms >= 0)",
      "CHECK (updated_at_ms >= created_at_ms)",
    ],
  },
  {
    name: "user_external_subjects",
    migrationVersion: 5,
    dependencies: ["identity_issuer_bindings", "users"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "issuer_binding_id TEXT NOT NULL",
      "external_subject_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "subject_hash_sha256 TEXT NOT NULL",
      "subject_source TEXT NOT NULL",
      "first_seen_at_ms BIGINT NOT NULL",
      "last_seen_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, issuer_binding_id, external_subject_id)",
      "UNIQUE (tenant_id, issuer_binding_id, subject_hash_sha256)",
      "FOREIGN KEY (tenant_id, issuer_binding_id) REFERENCES identity_issuer_bindings (tenant_id, issuer_binding_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (btrim(external_subject_id) <> '')",
      "CHECK (external_subject_id = btrim(external_subject_id))",
      "CHECK (subject_hash_sha256 ~ '^[0-9A-Fa-f]{64}$')",
      `CHECK (subject_source IN (${toSqlStringLiteralList(enterprisePostgresIdentitySubjectSources)}))`,
      "CHECK (first_seen_at_ms >= 0)",
      "CHECK (last_seen_at_ms >= first_seen_at_ms)",
    ],
  },
  {
    name: "identity_sync_checkpoints",
    migrationVersion: 5,
    dependencies: ["identity_issuer_bindings"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "issuer_binding_id TEXT NOT NULL",
      "sync_channel TEXT NOT NULL",
      "checkpoint_cursor TEXT NOT NULL",
      "cursor_hash_sha256 TEXT NOT NULL",
      "cursor_sequence BIGINT NOT NULL",
      "checkpointed_at_ms BIGINT NOT NULL",
      "updated_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, issuer_binding_id, sync_channel)",
      "FOREIGN KEY (tenant_id, issuer_binding_id) REFERENCES identity_issuer_bindings (tenant_id, issuer_binding_id) ON DELETE CASCADE ON UPDATE CASCADE",
      `CHECK (sync_channel IN (${toSqlStringLiteralList(enterprisePostgresIdentitySyncChannels)}))`,
      "CHECK (btrim(checkpoint_cursor) <> '')",
      "CHECK (cursor_hash_sha256 ~ '^[0-9A-Fa-f]{64}$')",
      "CHECK (cursor_sequence >= 0)",
      "CHECK (checkpointed_at_ms >= 0)",
      "CHECK (updated_at_ms >= checkpointed_at_ms)",
    ],
  },
  {
    name: "scopes",
    migrationVersion: 1,
    dependencies: ["tenants", "projects", "roles", "users"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "scope_id TEXT NOT NULL",
      "scope_level TEXT NOT NULL",
      "project_id TEXT",
      "role_id TEXT",
      "user_id TEXT",
      "parent_scope_id TEXT",
      "created_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, scope_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, role_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, parent_scope_id) REFERENCES scopes (tenant_id, scope_id) ON DELETE CASCADE ON UPDATE CASCADE",
      `CHECK (scope_level IN (${toSqlStringLiteralList(enterprisePostgresScopeLevels)}))`,
      [
        "CHECK ((",
        "  scope_level = 'common' AND project_id IS NULL AND role_id IS NULL AND user_id IS NULL",
        ") OR (",
        "  scope_level = 'project' AND project_id IS NOT NULL AND role_id IS NULL AND user_id IS NULL",
        ") OR (",
        "  scope_level = 'job_role' AND project_id IS NULL AND role_id IS NOT NULL AND user_id IS NULL",
        ") OR (",
        "  scope_level = 'user' AND project_id IS NULL AND role_id IS NULL AND user_id IS NOT NULL",
        "))",
      ].join(" "),
      "CHECK ((scope_level = 'common' AND parent_scope_id IS NULL) OR (scope_level <> 'common' AND parent_scope_id IS NOT NULL))",
      "CHECK (btrim(scope_id) <> '')",
      "CHECK (parent_scope_id IS NULL OR parent_scope_id <> scope_id)",
      "CHECK (created_at_ms >= 0)",
    ],
  },
  {
    name: "memory_items",
    migrationVersion: 1,
    dependencies: ["tenants", "scopes", "users"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "memory_id TEXT NOT NULL",
      "scope_id TEXT NOT NULL",
      "memory_layer TEXT NOT NULL",
      "memory_kind TEXT NOT NULL",
      "status TEXT NOT NULL",
      "title TEXT NOT NULL",
      "payload_json JSONB NOT NULL",
      "created_by_user_id TEXT",
      "supersedes_memory_id TEXT",
      "created_at_ms BIGINT NOT NULL",
      "updated_at_ms BIGINT NOT NULL",
      "expires_at_ms BIGINT",
      "tombstoned_at_ms BIGINT",
      "PRIMARY KEY (tenant_id, memory_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, scope_id) REFERENCES scopes (tenant_id, scope_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, supersedes_memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
      `CHECK (memory_layer IN (${toSqlStringLiteralList(enterprisePostgresMemoryLayers)}))`,
      `CHECK (memory_kind IN (${toSqlStringLiteralList(enterprisePostgresMemoryKinds)}))`,
      `CHECK (status IN (${toSqlStringLiteralList(enterprisePostgresMemoryStatuses)}))`,
      "CHECK (btrim(memory_id) <> '')",
      "CHECK (btrim(scope_id) <> '')",
      "CHECK (btrim(title) <> '')",
      "CHECK (created_at_ms >= 0)",
      "CHECK (updated_at_ms >= created_at_ms)",
      "CHECK (expires_at_ms IS NULL OR expires_at_ms >= created_at_ms)",
      [
        "CHECK ((",
        "  status = 'tombstoned' AND tombstoned_at_ms IS NOT NULL AND tombstoned_at_ms >= created_at_ms AND updated_at_ms >= tombstoned_at_ms",
        ") OR (",
        "  status <> 'tombstoned' AND tombstoned_at_ms IS NULL",
        "))",
      ].join(" "),
      "CHECK (supersedes_memory_id IS NULL OR supersedes_memory_id <> memory_id)",
    ],
  },
  {
    name: "memory_items_fts",
    migrationVersion: 2,
    dependencies: ["memory_items"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "memory_id TEXT NOT NULL",
      "title TEXT NOT NULL",
      "payload_text TEXT NOT NULL",
      [
        "document TSVECTOR GENERATED ALWAYS AS (",
        "  to_tsvector(",
        "    'simple',",
        "    coalesce(title, '') || ' ' || coalesce(payload_text, '')",
        "  )",
        ") STORED",
      ].join("\n"),
      "PRIMARY KEY (tenant_id, memory_id)",
      "FOREIGN KEY (tenant_id, memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (btrim(memory_id) <> '')",
    ],
  },
  {
    name: "evidence",
    migrationVersion: 1,
    dependencies: ["tenants"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "evidence_id TEXT NOT NULL",
      "source_kind TEXT NOT NULL",
      "source_ref TEXT NOT NULL",
      "digest_sha256 TEXT NOT NULL",
      "payload_json JSONB NOT NULL",
      "observed_at_ms BIGINT NOT NULL",
      "created_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, evidence_id)",
      "UNIQUE (tenant_id, source_kind, source_ref, digest_sha256)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      `CHECK (source_kind IN (${toSqlStringLiteralList(enterprisePostgresEvidenceSourceKinds)}))`,
      "CHECK (btrim(evidence_id) <> '')",
      "CHECK (btrim(source_ref) <> '')",
      "CHECK (digest_sha256 ~ '^[0-9A-Fa-f]{64}$')",
      "CHECK (observed_at_ms >= 0)",
      "CHECK (created_at_ms >= observed_at_ms)",
    ],
  },
  {
    name: "provenance_envelopes",
    migrationVersion: 6,
    dependencies: ["tenants", "projects", "roles", "users"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "provenance_id TEXT NOT NULL",
      "project_id TEXT",
      "role_id TEXT",
      "user_id TEXT",
      "agent_id TEXT",
      "conversation_id TEXT",
      "message_id TEXT",
      "source_id TEXT",
      "batch_id TEXT",
      "observed_at_ms BIGINT NOT NULL",
      "created_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, provenance_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, role_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (btrim(provenance_id) <> '')",
      "CHECK (project_id IS NULL OR btrim(project_id) <> '')",
      "CHECK (role_id IS NULL OR btrim(role_id) <> '')",
      "CHECK (user_id IS NULL OR btrim(user_id) <> '')",
      "CHECK (agent_id IS NULL OR btrim(agent_id) <> '')",
      "CHECK (conversation_id IS NULL OR btrim(conversation_id) <> '')",
      "CHECK (message_id IS NULL OR btrim(message_id) <> '')",
      "CHECK (source_id IS NULL OR btrim(source_id) <> '')",
      "CHECK (batch_id IS NULL OR btrim(batch_id) <> '')",
      "CHECK (observed_at_ms >= 0)",
      "CHECK (created_at_ms >= observed_at_ms)",
      [
        "CHECK (",
        "  project_id IS NOT NULL OR role_id IS NOT NULL OR user_id IS NOT NULL OR agent_id IS NOT NULL OR",
        "  conversation_id IS NOT NULL OR message_id IS NOT NULL OR source_id IS NOT NULL OR batch_id IS NOT NULL",
        ")",
      ].join(" "),
    ],
  },
  {
    name: "memory_evidence_links",
    migrationVersion: 1,
    dependencies: ["tenants", "memory_items", "evidence"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "memory_id TEXT NOT NULL",
      "evidence_id TEXT NOT NULL",
      "relation_kind TEXT NOT NULL",
      "created_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, memory_id, evidence_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence (tenant_id, evidence_id) ON DELETE CASCADE ON UPDATE CASCADE",
      `CHECK (relation_kind IN (${toSqlStringLiteralList(enterprisePostgresEvidenceRelationKinds)}))`,
      "CHECK (created_at_ms >= 0)",
    ],
  },
  {
    name: "memory_provenance_links",
    migrationVersion: 6,
    dependencies: ["tenants", "memory_items", "provenance_envelopes"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "memory_id TEXT NOT NULL",
      "provenance_id TEXT NOT NULL",
      "linked_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, memory_id, provenance_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, provenance_id) REFERENCES provenance_envelopes (tenant_id, provenance_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (linked_at_ms >= 0)",
    ],
  },
  {
    name: "evidence_provenance_links",
    migrationVersion: 6,
    dependencies: ["tenants", "evidence", "provenance_envelopes"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "evidence_id TEXT NOT NULL",
      "provenance_id TEXT NOT NULL",
      "linked_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, evidence_id, provenance_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence (tenant_id, evidence_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, provenance_id) REFERENCES provenance_envelopes (tenant_id, provenance_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (linked_at_ms >= 0)",
    ],
  },
  {
    name: "feedback",
    migrationVersion: 1,
    dependencies: ["tenants", "memory_items", "evidence", "users"] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "feedback_id TEXT NOT NULL",
      "memory_id TEXT NOT NULL",
      "evidence_id TEXT",
      "actor_user_id TEXT",
      "feedback_kind TEXT NOT NULL",
      "status TEXT NOT NULL",
      "severity INTEGER NOT NULL",
      "comment TEXT",
      "created_at_ms BIGINT NOT NULL",
      "resolved_at_ms BIGINT",
      "PRIMARY KEY (tenant_id, feedback_id)",
      "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence (tenant_id, evidence_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
      `CHECK (feedback_kind IN (${toSqlStringLiteralList(enterprisePostgresFeedbackKinds)}))`,
      `CHECK (status IN (${toSqlStringLiteralList(enterprisePostgresFeedbackStatuses)}))`,
      "CHECK (btrim(feedback_id) <> '')",
      "CHECK (severity BETWEEN 0 AND 100)",
      "CHECK (comment IS NULL OR btrim(comment) <> '')",
      "CHECK (created_at_ms >= 0)",
      [
        "CHECK ((",
        "  status = 'open' AND resolved_at_ms IS NULL",
        ") OR (",
        "  status IN ('resolved', 'dismissed') AND resolved_at_ms IS NOT NULL AND resolved_at_ms >= created_at_ms",
        "))",
      ].join(" "),
    ],
  },
  {
    name: "audit_events",
    migrationVersion: 3,
    dependencies: [] as const,
    definitions: [
      "event_id TEXT NOT NULL",
      "tenant_id TEXT NOT NULL",
      "memory_id TEXT NOT NULL",
      "operation TEXT NOT NULL",
      "outcome TEXT NOT NULL",
      "reason TEXT NOT NULL",
      "details TEXT NOT NULL",
      "reference_kind TEXT",
      "reference_id TEXT",
      "owner_tenant_id TEXT",
      "recorded_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (event_id)",
      "CHECK (btrim(event_id) <> '')",
      "CHECK (btrim(tenant_id) <> '')",
      "CHECK (btrim(memory_id) <> '')",
      `CHECK (operation IN (${toSqlStringLiteralList(enterprisePostgresAuditEventOperations)}))`,
      `CHECK (outcome IN (${toSqlStringLiteralList(enterprisePostgresAuditEventOutcomes)}))`,
      `CHECK (reason IN (${toSqlStringLiteralList(enterprisePostgresAuditEventReasons)}))`,
      "CHECK (btrim(details) <> '')",
      `CHECK (reference_kind IS NULL OR reference_kind IN (${toSqlStringLiteralList(enterprisePostgresAuditEventReferenceKinds)}))`,
      "CHECK (reference_id IS NULL OR btrim(reference_id) <> '')",
      "CHECK (owner_tenant_id IS NULL OR btrim(owner_tenant_id) <> '')",
      "CHECK (recorded_at_ms >= 0)",
      [
        "CHECK ((",
        "  owner_tenant_id IS NULL AND reference_kind IS NULL AND reference_id IS NULL",
        ") OR (",
        "  owner_tenant_id IS NOT NULL AND reference_kind IS NOT NULL AND reference_id IS NOT NULL",
        "))",
      ].join(" "),
      [
        "CHECK ((",
        "  reason IN ('cross_tenant_reference', 'cross_tenant_delete_probe') AND owner_tenant_id IS NOT NULL",
        ") OR (",
        "  reason NOT IN ('cross_tenant_reference', 'cross_tenant_delete_probe') AND owner_tenant_id IS NULL",
        "))",
      ].join(" "),
    ],
  },
  {
    name: "audit_event_provenance_links",
    migrationVersion: 6,
    dependencies: ["audit_events", "provenance_envelopes"] as const,
    definitions: [
      "event_id TEXT NOT NULL",
      "tenant_id TEXT NOT NULL",
      "provenance_id TEXT NOT NULL",
      "linked_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (event_id, provenance_id)",
      "FOREIGN KEY (event_id) REFERENCES audit_events (event_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "FOREIGN KEY (tenant_id, provenance_id) REFERENCES provenance_envelopes (tenant_id, provenance_id) ON DELETE CASCADE ON UPDATE CASCADE",
      "CHECK (btrim(event_id) <> '')",
      "CHECK (linked_at_ms >= 0)",
    ],
  },
  {
    name: "storage_idempotency_ledger",
    migrationVersion: 4,
    dependencies: [] as const,
    definitions: [
      "tenant_id TEXT NOT NULL",
      "operation TEXT NOT NULL",
      "idempotency_key TEXT NOT NULL",
      "request_hash_sha256 TEXT NOT NULL",
      "response_json JSONB NOT NULL",
      "created_at_ms BIGINT NOT NULL",
      "PRIMARY KEY (tenant_id, operation, idempotency_key)",
      "CHECK (btrim(tenant_id) <> '')",
      `CHECK (operation IN (${toSqlStringLiteralList(enterprisePostgresAuditEventOperations)}))`,
      "CHECK (btrim(idempotency_key) <> '')",
      "CHECK (request_hash_sha256 ~ '^[0-9A-Fa-f]{64}$')",
      "CHECK (created_at_ms >= 0)",
    ],
  },
] as const satisfies readonly PostgresTableDefinition[]);

export const enterprisePostgresTables = Object.freeze(
  postgresTableDefinitions.map((table) =>
    Object.freeze({
      name: table.name,
      ddl: createTableDdl(table.name, table.definitions),
      dependencies: table.dependencies,
      migrationVersion: table.migrationVersion,
    })
  )
) as readonly PostgresTableMetadata<EnterprisePostgresTableName>[];

const createTriggerDdl = (
  functionName: string,
  functionSql: readonly string[],
  triggerSql: readonly string[]
): string => [...functionSql, "", ...triggerSql].join("\n");

const scopesParentLevelGuardFunctionSql = [
  "CREATE OR REPLACE FUNCTION trg_scopes_parent_level_guard_fn()",
  "RETURNS trigger",
  "LANGUAGE plpgsql",
  "AS $$",
  "BEGIN",
  "  IF NEW.parent_scope_id IS NOT NULL THEN",
  "    IF NEW.scope_level = 'project' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level = 'common'",
  "    ) THEN",
  "      RAISE EXCEPTION 'SCOPE_PARENT_LEVEL_INVALID';",
  "    END IF;",
  "    IF NEW.scope_level = 'job_role' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level = 'common'",
  "    ) THEN",
  "      RAISE EXCEPTION 'SCOPE_PARENT_LEVEL_INVALID';",
  "    END IF;",
  "    IF NEW.scope_level = 'user' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level IN ('common', 'project', 'job_role')",
  "    ) THEN",
  "      RAISE EXCEPTION 'SCOPE_PARENT_LEVEL_INVALID';",
  "    END IF;",
  "  END IF;",
  "  RETURN NEW;",
  "END;",
  "$$;",
];

const scopesScopeLevelImmutableFunctionSql = [
  "CREATE OR REPLACE FUNCTION trg_scopes_scope_level_immutable_fn()",
  "RETURNS trigger",
  "LANGUAGE plpgsql",
  "AS $$",
  "BEGIN",
  "  IF NEW.scope_level IS DISTINCT FROM OLD.scope_level THEN",
  "    RAISE EXCEPTION 'SCOPE_LEVEL_IMMUTABLE';",
  "  END IF;",
  "  RETURN NEW;",
  "END;",
  "$$;",
];

const scopesAnchorImmutableFunctionSql = [
  "CREATE OR REPLACE FUNCTION trg_scopes_anchor_immutable_fn()",
  "RETURNS trigger",
  "LANGUAGE plpgsql",
  "AS $$",
  "BEGIN",
  "  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id",
  "    OR NEW.parent_scope_id IS DISTINCT FROM OLD.parent_scope_id",
  "    OR NEW.project_id IS DISTINCT FROM OLD.project_id",
  "    OR NEW.role_id IS DISTINCT FROM OLD.role_id",
  "    OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN",
  "    RAISE EXCEPTION 'SCOPE_ANCHOR_IMMUTABLE';",
  "  END IF;",
  "  RETURN NEW;",
  "END;",
  "$$;",
];

const scopesNoCycleFunctionSql = [
  "CREATE OR REPLACE FUNCTION trg_scopes_no_cycle_fn()",
  "RETURNS trigger",
  "LANGUAGE plpgsql",
  "AS $$",
  "BEGIN",
  "  IF NEW.parent_scope_id IS NOT NULL AND EXISTS (",
  "    WITH RECURSIVE ancestry(scope_id, parent_scope_id) AS (",
  "      SELECT scope_id, parent_scope_id",
  "      FROM scopes",
  "      WHERE tenant_id = NEW.tenant_id AND scope_id = NEW.parent_scope_id",
  "      UNION ALL",
  "      SELECT child.scope_id, child.parent_scope_id",
  "      FROM scopes child",
  "      JOIN ancestry parent",
  "        ON child.tenant_id = NEW.tenant_id",
  "       AND child.scope_id = parent.parent_scope_id",
  "      WHERE parent.parent_scope_id IS NOT NULL",
  "    )",
  "    SELECT 1 FROM ancestry WHERE scope_id = NEW.scope_id",
  "  ) THEN",
  "    RAISE EXCEPTION 'SCOPE_CYCLE_DETECTED';",
  "  END IF;",
  "  RETURN NEW;",
  "END;",
  "$$;",
];

const memoryNoSupersedesCycleFunctionSql = [
  "CREATE OR REPLACE FUNCTION trg_memory_items_no_supersedes_cycle_fn()",
  "RETURNS trigger",
  "LANGUAGE plpgsql",
  "AS $$",
  "BEGIN",
  "  IF NEW.supersedes_memory_id IS NOT NULL AND EXISTS (",
  "    WITH RECURSIVE ancestry(memory_id, supersedes_memory_id) AS (",
  "      SELECT memory_id, supersedes_memory_id",
  "      FROM memory_items",
  "      WHERE tenant_id = NEW.tenant_id AND memory_id = NEW.supersedes_memory_id",
  "      UNION ALL",
  "      SELECT predecessor.memory_id, predecessor.supersedes_memory_id",
  "      FROM memory_items predecessor",
  "      JOIN ancestry current",
  "        ON predecessor.tenant_id = NEW.tenant_id",
  "       AND predecessor.memory_id = current.supersedes_memory_id",
  "      WHERE current.supersedes_memory_id IS NOT NULL",
  "    )",
  "    SELECT 1 FROM ancestry WHERE memory_id = NEW.memory_id",
  "  ) THEN",
  "    RAISE EXCEPTION 'MEMORY_SUPERSEDES_CYCLE_DETECTED';",
  "  END IF;",
  "  RETURN NEW;",
  "END;",
  "$$;",
];

const memoryItemsFtsSyncFunctionSql = [
  "CREATE OR REPLACE FUNCTION trg_memory_items_fts_sync_fn()",
  "RETURNS trigger",
  "LANGUAGE plpgsql",
  "AS $$",
  "BEGIN",
  "  IF TG_OP = 'DELETE' THEN",
  "    DELETE FROM memory_items_fts",
  "    WHERE tenant_id = OLD.tenant_id AND memory_id = OLD.memory_id;",
  "    RETURN OLD;",
  "  END IF;",
  "",
  "  INSERT INTO memory_items_fts (tenant_id, memory_id, title, payload_text)",
  "  VALUES (NEW.tenant_id, NEW.memory_id, NEW.title, NEW.payload_json::text)",
  "  ON CONFLICT (tenant_id, memory_id) DO UPDATE SET",
  "    title = EXCLUDED.title,",
  "    payload_text = EXCLUDED.payload_text;",
  "  RETURN NEW;",
  "END;",
  "$$;",
];

const auditEventsAppendOnlyFunctionSql = [
  "CREATE OR REPLACE FUNCTION trg_audit_events_append_only_fn()",
  "RETURNS trigger",
  "LANGUAGE plpgsql",
  "AS $$",
  "BEGIN",
  "  RAISE EXCEPTION 'AUDIT_EVENTS_APPEND_ONLY';",
  "END;",
  "$$;",
];

export const enterprisePostgresTriggerNames = Object.freeze([
  "trg_scopes_scope_level_immutable",
  "trg_scopes_anchor_immutable",
  "trg_scopes_parent_level_guard_insert",
  "trg_scopes_parent_level_guard_update",
  "trg_scopes_no_cycle_insert",
  "trg_scopes_no_cycle_update",
  "trg_memory_items_no_supersedes_cycle_insert",
  "trg_memory_items_no_supersedes_cycle_update",
  "trg_memory_items_fts_insert",
  "trg_memory_items_fts_delete",
  "trg_memory_items_fts_update",
  "trg_audit_events_append_only_update",
  "trg_audit_events_append_only_delete",
] as const);

export type EnterprisePostgresTriggerName =
  (typeof enterprisePostgresTriggerNames)[number];

type PostgresTriggerDefinition = {
  readonly name: EnterprisePostgresTriggerName;
  readonly table: EnterprisePostgresTableName;
  readonly ddl: string;
  readonly migrationVersion: number;
};

const postgresTriggerDefinitions = Object.freeze([
  {
    name: "trg_scopes_scope_level_immutable",
    table: "scopes",
    migrationVersion: 1,
    ddl: createTriggerDdl(
      "trg_scopes_scope_level_immutable_fn",
      scopesScopeLevelImmutableFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_scopes_scope_level_immutable ON scopes;",
        "CREATE TRIGGER trg_scopes_scope_level_immutable",
        "BEFORE UPDATE OF scope_level ON scopes",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_scopes_scope_level_immutable_fn();",
      ]
    ),
  },
  {
    name: "trg_scopes_anchor_immutable",
    table: "scopes",
    migrationVersion: 1,
    ddl: createTriggerDdl(
      "trg_scopes_anchor_immutable_fn",
      scopesAnchorImmutableFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_scopes_anchor_immutable ON scopes;",
        "CREATE TRIGGER trg_scopes_anchor_immutable",
        "BEFORE UPDATE OF tenant_id, parent_scope_id, project_id, role_id, user_id ON scopes",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_scopes_anchor_immutable_fn();",
      ]
    ),
  },
  {
    name: "trg_scopes_parent_level_guard_insert",
    table: "scopes",
    migrationVersion: 1,
    ddl: createTriggerDdl(
      "trg_scopes_parent_level_guard_fn",
      scopesParentLevelGuardFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_scopes_parent_level_guard_insert ON scopes;",
        "CREATE TRIGGER trg_scopes_parent_level_guard_insert",
        "BEFORE INSERT ON scopes",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_scopes_parent_level_guard_fn();",
      ]
    ),
  },
  {
    name: "trg_scopes_parent_level_guard_update",
    table: "scopes",
    migrationVersion: 1,
    ddl: createTriggerDdl(
      "trg_scopes_parent_level_guard_fn",
      scopesParentLevelGuardFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_scopes_parent_level_guard_update ON scopes;",
        "CREATE TRIGGER trg_scopes_parent_level_guard_update",
        "BEFORE UPDATE OF tenant_id, parent_scope_id, scope_level ON scopes",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_scopes_parent_level_guard_fn();",
      ]
    ),
  },
  {
    name: "trg_scopes_no_cycle_insert",
    table: "scopes",
    migrationVersion: 1,
    ddl: createTriggerDdl("trg_scopes_no_cycle_fn", scopesNoCycleFunctionSql, [
      "DROP TRIGGER IF EXISTS trg_scopes_no_cycle_insert ON scopes;",
      "CREATE TRIGGER trg_scopes_no_cycle_insert",
      "BEFORE INSERT ON scopes",
      "FOR EACH ROW",
      "EXECUTE FUNCTION trg_scopes_no_cycle_fn();",
    ]),
  },
  {
    name: "trg_scopes_no_cycle_update",
    table: "scopes",
    migrationVersion: 1,
    ddl: createTriggerDdl("trg_scopes_no_cycle_fn", scopesNoCycleFunctionSql, [
      "DROP TRIGGER IF EXISTS trg_scopes_no_cycle_update ON scopes;",
      "CREATE TRIGGER trg_scopes_no_cycle_update",
      "BEFORE UPDATE OF tenant_id, parent_scope_id ON scopes",
      "FOR EACH ROW",
      "EXECUTE FUNCTION trg_scopes_no_cycle_fn();",
    ]),
  },
  {
    name: "trg_memory_items_no_supersedes_cycle_insert",
    table: "memory_items",
    migrationVersion: 1,
    ddl: createTriggerDdl(
      "trg_memory_items_no_supersedes_cycle_fn",
      memoryNoSupersedesCycleFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_memory_items_no_supersedes_cycle_insert ON memory_items;",
        "CREATE TRIGGER trg_memory_items_no_supersedes_cycle_insert",
        "BEFORE INSERT ON memory_items",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_memory_items_no_supersedes_cycle_fn();",
      ]
    ),
  },
  {
    name: "trg_memory_items_no_supersedes_cycle_update",
    table: "memory_items",
    migrationVersion: 1,
    ddl: createTriggerDdl(
      "trg_memory_items_no_supersedes_cycle_fn",
      memoryNoSupersedesCycleFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_memory_items_no_supersedes_cycle_update ON memory_items;",
        "CREATE TRIGGER trg_memory_items_no_supersedes_cycle_update",
        "BEFORE UPDATE OF tenant_id, supersedes_memory_id ON memory_items",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_memory_items_no_supersedes_cycle_fn();",
      ]
    ),
  },
  {
    name: "trg_memory_items_fts_insert",
    table: "memory_items",
    migrationVersion: 2,
    ddl: createTriggerDdl(
      "trg_memory_items_fts_sync_fn",
      memoryItemsFtsSyncFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_memory_items_fts_insert ON memory_items;",
        "CREATE TRIGGER trg_memory_items_fts_insert",
        "AFTER INSERT ON memory_items",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_memory_items_fts_sync_fn();",
      ]
    ),
  },
  {
    name: "trg_memory_items_fts_delete",
    table: "memory_items",
    migrationVersion: 2,
    ddl: createTriggerDdl(
      "trg_memory_items_fts_sync_fn",
      memoryItemsFtsSyncFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_memory_items_fts_delete ON memory_items;",
        "CREATE TRIGGER trg_memory_items_fts_delete",
        "AFTER DELETE ON memory_items",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_memory_items_fts_sync_fn();",
      ]
    ),
  },
  {
    name: "trg_memory_items_fts_update",
    table: "memory_items",
    migrationVersion: 2,
    ddl: createTriggerDdl(
      "trg_memory_items_fts_sync_fn",
      memoryItemsFtsSyncFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_memory_items_fts_update ON memory_items;",
        "CREATE TRIGGER trg_memory_items_fts_update",
        "AFTER UPDATE ON memory_items",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_memory_items_fts_sync_fn();",
      ]
    ),
  },
  {
    name: "trg_audit_events_append_only_update",
    table: "audit_events",
    migrationVersion: 3,
    ddl: createTriggerDdl(
      "trg_audit_events_append_only_fn",
      auditEventsAppendOnlyFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_audit_events_append_only_update ON audit_events;",
        "CREATE TRIGGER trg_audit_events_append_only_update",
        "BEFORE UPDATE ON audit_events",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_audit_events_append_only_fn();",
      ]
    ),
  },
  {
    name: "trg_audit_events_append_only_delete",
    table: "audit_events",
    migrationVersion: 3,
    ddl: createTriggerDdl(
      "trg_audit_events_append_only_fn",
      auditEventsAppendOnlyFunctionSql,
      [
        "DROP TRIGGER IF EXISTS trg_audit_events_append_only_delete ON audit_events;",
        "CREATE TRIGGER trg_audit_events_append_only_delete",
        "BEFORE DELETE ON audit_events",
        "FOR EACH ROW",
        "EXECUTE FUNCTION trg_audit_events_append_only_fn();",
      ]
    ),
  },
] as const satisfies readonly PostgresTriggerDefinition[]);

export const enterprisePostgresTriggers = Object.freeze(
  postgresTriggerDefinitions.map((trigger) => Object.freeze(trigger))
) as readonly PostgresTriggerMetadata<
  EnterprisePostgresTriggerName,
  EnterprisePostgresTableName
>[];

const idxUsersTenantStatusDdl =
  "CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON users (tenant_id, status, user_id);";
const idxProjectsTenantStatusDdl =
  "CREATE INDEX IF NOT EXISTS idx_projects_tenant_status ON projects (tenant_id, status, project_id);";
const idxProjectMembershipsUserDdl =
  "CREATE INDEX IF NOT EXISTS idx_project_memberships_user ON project_memberships (tenant_id, user_id, project_id);";
const idxUserRoleAssignmentsRoleDdl =
  "CREATE INDEX IF NOT EXISTS idx_user_role_assignments_role ON user_role_assignments (tenant_id, role_id, user_id);";
const idxIdentityIssuerBindingsKindDdl = [
  "CREATE INDEX IF NOT EXISTS idx_identity_issuer_bindings_kind ON identity_issuer_bindings",
  "(tenant_id, issuer_kind, issuer_binding_id);",
].join("\n");
const uqIdentityIssuerBindingsPrimaryDdl = [
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_issuer_bindings_primary ON identity_issuer_bindings (tenant_id)",
  "WHERE is_primary = TRUE;",
].join("\n");
const idxUserExternalSubjectsUserDdl = [
  "CREATE INDEX IF NOT EXISTS idx_user_external_subjects_user ON user_external_subjects",
  "(tenant_id, user_id, issuer_binding_id, external_subject_id);",
].join("\n");
const idxUserExternalSubjectsSubjectHashDdl = [
  "CREATE INDEX IF NOT EXISTS idx_user_external_subjects_subject_hash ON user_external_subjects",
  "(tenant_id, issuer_binding_id, subject_hash_sha256);",
].join("\n");
const idxIdentitySyncCheckpointsUpdatedDdl = [
  "CREATE INDEX IF NOT EXISTS idx_identity_sync_checkpoints_updated ON identity_sync_checkpoints",
  "(tenant_id, issuer_binding_id, sync_channel, updated_at_ms DESC);",
].join("\n");
const uqScopesCommonSingletonDdl = [
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_scopes_common_singleton ON scopes (tenant_id)",
  "WHERE scope_level = 'common';",
].join("\n");
const uqScopesProjectAnchorDdl = [
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_scopes_project_anchor ON scopes (tenant_id, project_id)",
  "WHERE scope_level = 'project';",
].join("\n");
const uqScopesRoleAnchorDdl = [
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_scopes_role_anchor ON scopes (tenant_id, role_id)",
  "WHERE scope_level = 'job_role';",
].join("\n");
const uqScopesUserAnchorDdl = [
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_scopes_user_anchor ON scopes (tenant_id, user_id)",
  "WHERE scope_level = 'user';",
].join("\n");
const idxScopesParentDdl = [
  "CREATE INDEX IF NOT EXISTS idx_scopes_parent ON scopes (tenant_id, parent_scope_id)",
  "WHERE parent_scope_id IS NOT NULL;",
].join("\n");
const idxMemoryItemsScopeStatusDdl = [
  "CREATE INDEX IF NOT EXISTS idx_memory_items_scope_status ON memory_items",
  "(tenant_id, scope_id, status, updated_at_ms DESC);",
].join("\n");
const idxMemoryItemsSupersedesDdl = [
  "CREATE INDEX IF NOT EXISTS idx_memory_items_supersedes ON memory_items (tenant_id, supersedes_memory_id)",
  "WHERE supersedes_memory_id IS NOT NULL;",
].join("\n");
const idxEvidenceSourceObservedDdl = [
  "CREATE INDEX IF NOT EXISTS idx_evidence_source_observed ON evidence",
  "(tenant_id, source_kind, observed_at_ms DESC);",
].join("\n");
const idxProvenanceEnvelopesLookupDdl = [
  "CREATE INDEX IF NOT EXISTS idx_provenance_envelopes_lookup ON provenance_envelopes",
  "(tenant_id, source_id, conversation_id, message_id, created_at_ms DESC);",
].join("\n");
const idxMemoryEvidenceLinksMemoryDdl = [
  "CREATE INDEX IF NOT EXISTS idx_memory_evidence_links_memory ON memory_evidence_links",
  "(tenant_id, memory_id, relation_kind, evidence_id);",
].join("\n");
const idxMemoryProvenanceLinksMemoryDdl = [
  "CREATE INDEX IF NOT EXISTS idx_memory_provenance_links_memory ON memory_provenance_links",
  "(tenant_id, memory_id, linked_at_ms DESC, provenance_id);",
].join("\n");
const idxMemoryProvenanceLinksProvenanceDdl = [
  "CREATE INDEX IF NOT EXISTS idx_memory_provenance_links_provenance ON memory_provenance_links",
  "(tenant_id, provenance_id, memory_id);",
].join("\n");
const idxEvidenceProvenanceLinksEvidenceDdl = [
  "CREATE INDEX IF NOT EXISTS idx_evidence_provenance_links_evidence ON evidence_provenance_links",
  "(tenant_id, evidence_id, linked_at_ms DESC, provenance_id);",
].join("\n");
const idxEvidenceProvenanceLinksProvenanceDdl = [
  "CREATE INDEX IF NOT EXISTS idx_evidence_provenance_links_provenance ON evidence_provenance_links",
  "(tenant_id, provenance_id, evidence_id);",
].join("\n");
const idxFeedbackMemoryStatusDdl = [
  "CREATE INDEX IF NOT EXISTS idx_feedback_memory_status ON feedback",
  "(tenant_id, memory_id, status, created_at_ms DESC);",
].join("\n");
const idxFeedbackActorCreatedDdl = [
  "CREATE INDEX IF NOT EXISTS idx_feedback_actor_created ON feedback",
  "(tenant_id, actor_user_id, created_at_ms DESC)",
  "WHERE actor_user_id IS NOT NULL;",
].join("\n");
const idxAuditEventsTenantOperationDdl = [
  "CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_operation ON audit_events",
  "(tenant_id, operation, outcome, reason, memory_id, recorded_at_ms, event_id);",
].join("\n");
const idxAuditEventsOwnerReferenceDdl = [
  "CREATE INDEX IF NOT EXISTS idx_audit_events_owner_reference ON audit_events",
  "(owner_tenant_id, reference_kind, reference_id, tenant_id, recorded_at_ms, event_id)",
  "WHERE owner_tenant_id IS NOT NULL;",
].join("\n");
const idxAuditEventProvenanceLinksEventDdl = [
  "CREATE INDEX IF NOT EXISTS idx_audit_event_provenance_links_event ON audit_event_provenance_links",
  "(event_id, linked_at_ms DESC, provenance_id);",
].join("\n");
const idxAuditEventProvenanceLinksTenantProvenanceDdl = [
  "CREATE INDEX IF NOT EXISTS idx_audit_event_provenance_links_tenant_provenance ON audit_event_provenance_links",
  "(tenant_id, provenance_id, event_id);",
].join("\n");
const idxStorageIdempotencyLedgerCreatedDdl = [
  "CREATE INDEX IF NOT EXISTS idx_storage_idempotency_ledger_created ON storage_idempotency_ledger",
  "(tenant_id, operation, created_at_ms DESC, idempotency_key);",
].join("\n");
const idxStorageIdempotencyLedgerRequestHashDdl = [
  "CREATE INDEX IF NOT EXISTS idx_storage_idempotency_ledger_request_hash ON storage_idempotency_ledger",
  "(tenant_id, operation, request_hash_sha256, created_at_ms DESC);",
].join("\n");

export const enterprisePostgresIndexNames = Object.freeze([
  "idx_users_tenant_status",
  "idx_projects_tenant_status",
  "idx_project_memberships_user",
  "idx_user_role_assignments_role",
  "idx_identity_issuer_bindings_kind",
  "uq_identity_issuer_bindings_primary",
  "idx_user_external_subjects_user",
  "idx_user_external_subjects_subject_hash",
  "idx_identity_sync_checkpoints_updated",
  "uq_scopes_common_singleton",
  "uq_scopes_project_anchor",
  "uq_scopes_role_anchor",
  "uq_scopes_user_anchor",
  "idx_scopes_parent",
  "idx_memory_items_scope_status",
  "idx_memory_items_supersedes",
  "idx_evidence_source_observed",
  "idx_provenance_envelopes_lookup",
  "idx_memory_evidence_links_memory",
  "idx_memory_provenance_links_memory",
  "idx_memory_provenance_links_provenance",
  "idx_evidence_provenance_links_evidence",
  "idx_evidence_provenance_links_provenance",
  "idx_feedback_memory_status",
  "idx_feedback_actor_created",
  "idx_audit_events_tenant_operation",
  "idx_audit_events_owner_reference",
  "idx_audit_event_provenance_links_event",
  "idx_audit_event_provenance_links_tenant_provenance",
  "idx_storage_idempotency_ledger_created",
  "idx_storage_idempotency_ledger_request_hash",
] as const);

export type EnterprisePostgresIndexName =
  (typeof enterprisePostgresIndexNames)[number];

type PostgresIndexDefinition = {
  readonly name: EnterprisePostgresIndexName;
  readonly table: EnterprisePostgresTableName;
  readonly unique: boolean;
  readonly ddl: string;
  readonly migrationVersion: number;
};

export const enterprisePostgresIndexes = Object.freeze([
  {
    name: "idx_users_tenant_status",
    table: "users",
    unique: false,
    ddl: idxUsersTenantStatusDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_projects_tenant_status",
    table: "projects",
    unique: false,
    ddl: idxProjectsTenantStatusDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_project_memberships_user",
    table: "project_memberships",
    unique: false,
    ddl: idxProjectMembershipsUserDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_user_role_assignments_role",
    table: "user_role_assignments",
    unique: false,
    ddl: idxUserRoleAssignmentsRoleDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_identity_issuer_bindings_kind",
    table: "identity_issuer_bindings",
    unique: false,
    ddl: idxIdentityIssuerBindingsKindDdl,
    migrationVersion: 5,
  },
  {
    name: "uq_identity_issuer_bindings_primary",
    table: "identity_issuer_bindings",
    unique: true,
    ddl: uqIdentityIssuerBindingsPrimaryDdl,
    migrationVersion: 5,
  },
  {
    name: "idx_user_external_subjects_user",
    table: "user_external_subjects",
    unique: false,
    ddl: idxUserExternalSubjectsUserDdl,
    migrationVersion: 5,
  },
  {
    name: "idx_user_external_subjects_subject_hash",
    table: "user_external_subjects",
    unique: false,
    ddl: idxUserExternalSubjectsSubjectHashDdl,
    migrationVersion: 5,
  },
  {
    name: "idx_identity_sync_checkpoints_updated",
    table: "identity_sync_checkpoints",
    unique: false,
    ddl: idxIdentitySyncCheckpointsUpdatedDdl,
    migrationVersion: 5,
  },
  {
    name: "uq_scopes_common_singleton",
    table: "scopes",
    unique: true,
    ddl: uqScopesCommonSingletonDdl,
    migrationVersion: 1,
  },
  {
    name: "uq_scopes_project_anchor",
    table: "scopes",
    unique: true,
    ddl: uqScopesProjectAnchorDdl,
    migrationVersion: 1,
  },
  {
    name: "uq_scopes_role_anchor",
    table: "scopes",
    unique: true,
    ddl: uqScopesRoleAnchorDdl,
    migrationVersion: 1,
  },
  {
    name: "uq_scopes_user_anchor",
    table: "scopes",
    unique: true,
    ddl: uqScopesUserAnchorDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_scopes_parent",
    table: "scopes",
    unique: false,
    ddl: idxScopesParentDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_memory_items_scope_status",
    table: "memory_items",
    unique: false,
    ddl: idxMemoryItemsScopeStatusDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_memory_items_supersedes",
    table: "memory_items",
    unique: false,
    ddl: idxMemoryItemsSupersedesDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_evidence_source_observed",
    table: "evidence",
    unique: false,
    ddl: idxEvidenceSourceObservedDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_provenance_envelopes_lookup",
    table: "provenance_envelopes",
    unique: false,
    ddl: idxProvenanceEnvelopesLookupDdl,
    migrationVersion: 6,
  },
  {
    name: "idx_memory_evidence_links_memory",
    table: "memory_evidence_links",
    unique: false,
    ddl: idxMemoryEvidenceLinksMemoryDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_memory_provenance_links_memory",
    table: "memory_provenance_links",
    unique: false,
    ddl: idxMemoryProvenanceLinksMemoryDdl,
    migrationVersion: 6,
  },
  {
    name: "idx_memory_provenance_links_provenance",
    table: "memory_provenance_links",
    unique: false,
    ddl: idxMemoryProvenanceLinksProvenanceDdl,
    migrationVersion: 6,
  },
  {
    name: "idx_evidence_provenance_links_evidence",
    table: "evidence_provenance_links",
    unique: false,
    ddl: idxEvidenceProvenanceLinksEvidenceDdl,
    migrationVersion: 6,
  },
  {
    name: "idx_evidence_provenance_links_provenance",
    table: "evidence_provenance_links",
    unique: false,
    ddl: idxEvidenceProvenanceLinksProvenanceDdl,
    migrationVersion: 6,
  },
  {
    name: "idx_feedback_memory_status",
    table: "feedback",
    unique: false,
    ddl: idxFeedbackMemoryStatusDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_feedback_actor_created",
    table: "feedback",
    unique: false,
    ddl: idxFeedbackActorCreatedDdl,
    migrationVersion: 1,
  },
  {
    name: "idx_audit_events_tenant_operation",
    table: "audit_events",
    unique: false,
    ddl: idxAuditEventsTenantOperationDdl,
    migrationVersion: 3,
  },
  {
    name: "idx_audit_events_owner_reference",
    table: "audit_events",
    unique: false,
    ddl: idxAuditEventsOwnerReferenceDdl,
    migrationVersion: 3,
  },
  {
    name: "idx_audit_event_provenance_links_event",
    table: "audit_event_provenance_links",
    unique: false,
    ddl: idxAuditEventProvenanceLinksEventDdl,
    migrationVersion: 6,
  },
  {
    name: "idx_audit_event_provenance_links_tenant_provenance",
    table: "audit_event_provenance_links",
    unique: false,
    ddl: idxAuditEventProvenanceLinksTenantProvenanceDdl,
    migrationVersion: 6,
  },
  {
    name: "idx_storage_idempotency_ledger_created",
    table: "storage_idempotency_ledger",
    unique: false,
    ddl: idxStorageIdempotencyLedgerCreatedDdl,
    migrationVersion: 4,
  },
  {
    name: "idx_storage_idempotency_ledger_request_hash",
    table: "storage_idempotency_ledger",
    unique: false,
    ddl: idxStorageIdempotencyLedgerRequestHashDdl,
    migrationVersion: 4,
  },
] as const satisfies readonly PostgresIndexDefinition[]);

export const enterprisePostgresSchemaVersion = 6;

export const enterprisePostgresSchemaStatements = Object.freeze([
  ...enterprisePostgresTables.map((table) => table.ddl),
  ...enterprisePostgresTriggers.map((trigger) => trigger.ddl),
  ...enterprisePostgresIndexes.map((index) => index.ddl),
]);

export const enterprisePostgresSchemaSql = `${enterprisePostgresSchemaStatements.join("\n\n")}\n`;

export const enterprisePostgresSchema = Object.freeze({
  version: enterprisePostgresSchemaVersion,
  tables: enterprisePostgresTables,
  triggers: enterprisePostgresTriggers,
  indexes: enterprisePostgresIndexes,
  statements: enterprisePostgresSchemaStatements,
  sql: enterprisePostgresSchemaSql,
}) as PostgresSchemaMetadata<
  EnterprisePostgresTableName,
  EnterprisePostgresIndexName,
  EnterprisePostgresTriggerName
>;
