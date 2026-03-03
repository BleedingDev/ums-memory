import type {
  SqliteIndexMetadata,
  SqliteSchemaMetadata,
  SqliteTableMetadata,
} from "./schema-metadata.js";

const toSqlStringLiteralList = (values: ReadonlyArray<string>): string =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");

const createStrictTableDdl = (
  tableName: string,
  definitions: ReadonlyArray<string>
): string =>
  `CREATE TABLE IF NOT EXISTS ${tableName} (\n${definitions.map((definition) => `  ${definition}`).join(",\n")}\n) STRICT;`;

export const enterpriseScopeLevels = Object.freeze([
  "common",
  "project",
  "job_role",
  "user",
] as const);
export const enterpriseUserStatuses = Object.freeze([
  "active",
  "disabled",
  "pending",
] as const);
export const enterpriseProjectStatuses = Object.freeze([
  "active",
  "archived",
] as const);
export const enterpriseRoleTypes = Object.freeze([
  "system",
  "project",
  "custom",
] as const);
export const enterpriseIdentityIssuerKinds = Object.freeze([
  "oidc",
  "saml",
  "scim",
] as const);
export const enterpriseIdentitySubjectSources = Object.freeze([
  "sso",
  "scim",
  "manual",
] as const);
export const enterpriseIdentitySyncChannels = Object.freeze([
  "scim_users",
  "scim_groups",
  "sso_jit",
] as const);
export const enterpriseMemoryLayers = Object.freeze([
  "episodic",
  "working",
  "procedural",
] as const);
export const enterpriseMemoryKinds = Object.freeze([
  "note",
  "decision",
  "rule",
  "anti_pattern",
  "summary",
] as const);
export const enterpriseMemoryStatuses = Object.freeze([
  "active",
  "superseded",
  "tombstoned",
] as const);
export const enterpriseEvidenceSourceKinds = Object.freeze([
  "event",
  "artifact",
  "feedback",
  "external_document",
  "test_result",
] as const);
export const enterpriseEvidenceRelationKinds = Object.freeze([
  "supports",
  "contradicts",
  "supersedes",
] as const);
export const enterpriseFeedbackKinds = Object.freeze([
  "helpful",
  "harmful",
  "correction",
  "question",
  "policy_flag",
] as const);
export const enterpriseFeedbackStatuses = Object.freeze([
  "open",
  "resolved",
  "dismissed",
] as const);
export const enterpriseAuditEventOperations = Object.freeze([
  "upsert",
  "delete",
] as const);
export const enterpriseAuditEventOutcomes = Object.freeze([
  "accepted",
  "denied",
  "not_found",
] as const);
export const enterpriseAuditEventReasons = Object.freeze([
  "inserted",
  "updated",
  "stale_replay",
  "equal_replay",
  "deleted",
  "cross_tenant_reference",
  "cross_tenant_delete_probe",
  "memory_not_found",
] as const);
export const enterpriseAuditEventReferenceKinds = Object.freeze([
  "scope",
  "project",
  "role",
  "user",
  "supersedes_memory",
  "memory",
] as const);

export type EnterpriseScopeLevel = (typeof enterpriseScopeLevels)[number];
export type EnterpriseUserStatus = (typeof enterpriseUserStatuses)[number];
export type EnterpriseProjectStatus =
  (typeof enterpriseProjectStatuses)[number];
export type EnterpriseRoleType = (typeof enterpriseRoleTypes)[number];
export type EnterpriseIdentityIssuerKind =
  (typeof enterpriseIdentityIssuerKinds)[number];
export type EnterpriseIdentitySubjectSource =
  (typeof enterpriseIdentitySubjectSources)[number];
export type EnterpriseIdentitySyncChannel =
  (typeof enterpriseIdentitySyncChannels)[number];
export type EnterpriseMemoryLayer = (typeof enterpriseMemoryLayers)[number];
export type EnterpriseMemoryKind = (typeof enterpriseMemoryKinds)[number];
export type EnterpriseMemoryStatus = (typeof enterpriseMemoryStatuses)[number];
export type EnterpriseEvidenceSourceKind =
  (typeof enterpriseEvidenceSourceKinds)[number];
export type EnterpriseEvidenceRelationKind =
  (typeof enterpriseEvidenceRelationKinds)[number];
export type EnterpriseFeedbackKind = (typeof enterpriseFeedbackKinds)[number];
export type EnterpriseFeedbackStatus =
  (typeof enterpriseFeedbackStatuses)[number];
export type EnterpriseAuditEventOperation =
  (typeof enterpriseAuditEventOperations)[number];
export type EnterpriseAuditEventOutcome =
  (typeof enterpriseAuditEventOutcomes)[number];
export type EnterpriseAuditEventReason =
  (typeof enterpriseAuditEventReasons)[number];
export type EnterpriseAuditEventReferenceKind =
  (typeof enterpriseAuditEventReferenceKinds)[number];

export const enterpriseSqliteTableNames = Object.freeze([
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

export type EnterpriseSqliteTableName =
  (typeof enterpriseSqliteTableNames)[number];

const tenantsTableDdl = createStrictTableDdl("tenants", [
  "tenant_id TEXT NOT NULL",
  "tenant_slug TEXT NOT NULL",
  "display_name TEXT NOT NULL",
  "created_at_ms INTEGER NOT NULL",
  "updated_at_ms INTEGER NOT NULL",
  "PRIMARY KEY (tenant_id)",
  "UNIQUE (tenant_slug)",
  "CHECK (length(trim(tenant_id)) > 0)",
  "CHECK (length(trim(tenant_slug)) > 0)",
  "CHECK (length(trim(display_name)) > 0)",
  "CHECK (created_at_ms >= 0)",
  "CHECK (updated_at_ms >= created_at_ms)",
]);

const usersTableDdl = createStrictTableDdl("users", [
  "tenant_id TEXT NOT NULL",
  "user_id TEXT NOT NULL",
  "email TEXT NOT NULL",
  "display_name TEXT NOT NULL",
  "status TEXT NOT NULL",
  "created_at_ms INTEGER NOT NULL",
  "updated_at_ms INTEGER NOT NULL",
  "PRIMARY KEY (tenant_id, user_id)",
  "UNIQUE (tenant_id, email)",
  "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "CHECK (length(trim(user_id)) > 0)",
  "CHECK (length(trim(email)) > 3)",
  "CHECK (instr(email, '@') > 1)",
  "CHECK (length(trim(display_name)) > 0)",
  `CHECK (status IN (${toSqlStringLiteralList(enterpriseUserStatuses)}))`,
  "CHECK (created_at_ms >= 0)",
  "CHECK (updated_at_ms >= created_at_ms)",
]);

const projectsTableDdl = createStrictTableDdl("projects", [
  "tenant_id TEXT NOT NULL",
  "project_id TEXT NOT NULL",
  "project_key TEXT NOT NULL",
  "display_name TEXT NOT NULL",
  "status TEXT NOT NULL",
  "created_at_ms INTEGER NOT NULL",
  "archived_at_ms INTEGER",
  "PRIMARY KEY (tenant_id, project_id)",
  "UNIQUE (tenant_id, project_key)",
  "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "CHECK (length(trim(project_id)) > 0)",
  "CHECK (length(trim(project_key)) > 0)",
  "CHECK (length(trim(display_name)) > 0)",
  `CHECK (status IN (${toSqlStringLiteralList(enterpriseProjectStatuses)}))`,
  "CHECK (created_at_ms >= 0)",
  "CHECK (archived_at_ms IS NULL OR archived_at_ms >= created_at_ms)",
  `CHECK (
    (status = 'active' AND archived_at_ms IS NULL) OR
    (status = 'archived' AND archived_at_ms IS NOT NULL AND archived_at_ms >= created_at_ms)
  )`,
]);

const rolesTableDdl = createStrictTableDdl("roles", [
  "tenant_id TEXT NOT NULL",
  "role_id TEXT NOT NULL",
  "role_code TEXT NOT NULL",
  "display_name TEXT NOT NULL",
  "role_type TEXT NOT NULL",
  "created_at_ms INTEGER NOT NULL",
  "PRIMARY KEY (tenant_id, role_id)",
  "UNIQUE (tenant_id, role_code)",
  "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "CHECK (length(trim(role_id)) > 0)",
  "CHECK (length(trim(role_code)) > 0)",
  "CHECK (length(trim(display_name)) > 0)",
  `CHECK (role_type IN (${toSqlStringLiteralList(enterpriseRoleTypes)}))`,
  "CHECK (created_at_ms >= 0)",
]);

const projectMembershipsTableDdl = createStrictTableDdl("project_memberships", [
  "tenant_id TEXT NOT NULL",
  "project_id TEXT NOT NULL",
  "user_id TEXT NOT NULL",
  "role_id TEXT",
  "assigned_at_ms INTEGER NOT NULL",
  "PRIMARY KEY (tenant_id, project_id, user_id)",
  "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, role_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "CHECK (assigned_at_ms >= 0)",
]);

const userRoleAssignmentsTableDdl = createStrictTableDdl(
  "user_role_assignments",
  [
    "tenant_id TEXT NOT NULL",
    "user_id TEXT NOT NULL",
    "role_id TEXT NOT NULL",
    "assigned_at_ms INTEGER NOT NULL",
    "assigned_by_user_id TEXT",
    "PRIMARY KEY (tenant_id, user_id, role_id)",
    "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, role_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, assigned_by_user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "CHECK (assigned_at_ms >= 0)",
  ]
);

const identityIssuerBindingsTableDdl = createStrictTableDdl(
  "identity_issuer_bindings",
  [
    "tenant_id TEXT NOT NULL",
    "issuer_binding_id TEXT NOT NULL",
    "issuer TEXT NOT NULL",
    "issuer_kind TEXT NOT NULL",
    "is_primary INTEGER NOT NULL DEFAULT 0",
    "created_at_ms INTEGER NOT NULL",
    "updated_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (tenant_id, issuer_binding_id)",
    "UNIQUE (tenant_id, issuer)",
    "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "CHECK (length(trim(issuer_binding_id)) > 0)",
    "CHECK (issuer_binding_id = trim(issuer_binding_id))",
    "CHECK (length(trim(issuer)) > 0)",
    "CHECK (issuer = trim(issuer))",
    "CHECK (issuer = lower(issuer))",
    `CHECK (issuer_kind IN (${toSqlStringLiteralList(enterpriseIdentityIssuerKinds)}))`,
    "CHECK (is_primary IN (0, 1))",
    "CHECK (created_at_ms >= 0)",
    "CHECK (updated_at_ms >= created_at_ms)",
  ]
);

const userExternalSubjectsTableDdl = createStrictTableDdl(
  "user_external_subjects",
  [
    "tenant_id TEXT NOT NULL",
    "issuer_binding_id TEXT NOT NULL",
    "external_subject_id TEXT NOT NULL",
    "user_id TEXT NOT NULL",
    "subject_hash_sha256 TEXT NOT NULL",
    "subject_source TEXT NOT NULL",
    "first_seen_at_ms INTEGER NOT NULL",
    "last_seen_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (tenant_id, issuer_binding_id, external_subject_id)",
    "UNIQUE (tenant_id, issuer_binding_id, subject_hash_sha256)",
    "FOREIGN KEY (tenant_id, issuer_binding_id) REFERENCES identity_issuer_bindings (tenant_id, issuer_binding_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "CHECK (length(trim(external_subject_id)) > 0)",
    "CHECK (external_subject_id = trim(external_subject_id))",
    "CHECK (length(subject_hash_sha256) = 64)",
    "CHECK (subject_hash_sha256 NOT GLOB '*[^0-9A-Fa-f]*')",
    `CHECK (subject_source IN (${toSqlStringLiteralList(enterpriseIdentitySubjectSources)}))`,
    "CHECK (first_seen_at_ms >= 0)",
    "CHECK (last_seen_at_ms >= first_seen_at_ms)",
  ]
);

const identitySyncCheckpointsTableDdl = createStrictTableDdl(
  "identity_sync_checkpoints",
  [
    "tenant_id TEXT NOT NULL",
    "issuer_binding_id TEXT NOT NULL",
    "sync_channel TEXT NOT NULL",
    "checkpoint_cursor TEXT NOT NULL",
    "cursor_hash_sha256 TEXT NOT NULL",
    "cursor_sequence INTEGER NOT NULL",
    "checkpointed_at_ms INTEGER NOT NULL",
    "updated_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (tenant_id, issuer_binding_id, sync_channel)",
    "FOREIGN KEY (tenant_id, issuer_binding_id) REFERENCES identity_issuer_bindings (tenant_id, issuer_binding_id) ON DELETE CASCADE ON UPDATE CASCADE",
    `CHECK (sync_channel IN (${toSqlStringLiteralList(enterpriseIdentitySyncChannels)}))`,
    "CHECK (length(trim(checkpoint_cursor)) > 0)",
    "CHECK (length(cursor_hash_sha256) = 64)",
    "CHECK (cursor_hash_sha256 NOT GLOB '*[^0-9A-Fa-f]*')",
    "CHECK (cursor_sequence >= 0)",
    "CHECK (checkpointed_at_ms >= 0)",
    "CHECK (updated_at_ms >= checkpointed_at_ms)",
  ]
);

const scopesTableDdl = createStrictTableDdl("scopes", [
  "tenant_id TEXT NOT NULL",
  "scope_id TEXT NOT NULL",
  "scope_level TEXT NOT NULL",
  "project_id TEXT",
  "role_id TEXT",
  "user_id TEXT",
  "parent_scope_id TEXT",
  "created_at_ms INTEGER NOT NULL",
  "PRIMARY KEY (tenant_id, scope_id)",
  "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, role_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, parent_scope_id) REFERENCES scopes (tenant_id, scope_id) ON DELETE CASCADE ON UPDATE CASCADE",
  `CHECK (scope_level IN (${toSqlStringLiteralList(enterpriseScopeLevels)}))`,
  `CHECK (
    (scope_level = 'common' AND project_id IS NULL AND role_id IS NULL AND user_id IS NULL) OR
    (scope_level = 'project' AND project_id IS NOT NULL AND role_id IS NULL AND user_id IS NULL) OR
    (scope_level = 'job_role' AND project_id IS NULL AND role_id IS NOT NULL AND user_id IS NULL) OR
    (scope_level = 'user' AND project_id IS NULL AND role_id IS NULL AND user_id IS NOT NULL)
  )`,
  "CHECK ((scope_level = 'common' AND parent_scope_id IS NULL) OR (scope_level <> 'common' AND parent_scope_id IS NOT NULL))",
  "CHECK (length(trim(scope_id)) > 0)",
  "CHECK (parent_scope_id IS NULL OR parent_scope_id <> scope_id)",
  "CHECK (created_at_ms >= 0)",
]);

const memoryItemsTableDdl = createStrictTableDdl("memory_items", [
  "tenant_id TEXT NOT NULL",
  "memory_id TEXT NOT NULL",
  "scope_id TEXT NOT NULL",
  "memory_layer TEXT NOT NULL",
  "memory_kind TEXT NOT NULL",
  "status TEXT NOT NULL",
  "title TEXT NOT NULL",
  "payload_json TEXT NOT NULL",
  "created_by_user_id TEXT",
  "supersedes_memory_id TEXT",
  "created_at_ms INTEGER NOT NULL",
  "updated_at_ms INTEGER NOT NULL",
  "expires_at_ms INTEGER",
  "tombstoned_at_ms INTEGER",
  "PRIMARY KEY (tenant_id, memory_id)",
  "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, scope_id) REFERENCES scopes (tenant_id, scope_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, supersedes_memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
  `CHECK (memory_layer IN (${toSqlStringLiteralList(enterpriseMemoryLayers)}))`,
  `CHECK (memory_kind IN (${toSqlStringLiteralList(enterpriseMemoryKinds)}))`,
  `CHECK (status IN (${toSqlStringLiteralList(enterpriseMemoryStatuses)}))`,
  "CHECK (length(trim(memory_id)) > 0)",
  "CHECK (length(trim(scope_id)) > 0)",
  "CHECK (length(trim(title)) > 0)",
  "CHECK (json_valid(payload_json))",
  "CHECK (created_at_ms >= 0)",
  "CHECK (updated_at_ms >= created_at_ms)",
  "CHECK (expires_at_ms IS NULL OR expires_at_ms >= created_at_ms)",
  `CHECK (
    (status = 'tombstoned' AND tombstoned_at_ms IS NOT NULL AND tombstoned_at_ms >= created_at_ms AND updated_at_ms >= tombstoned_at_ms) OR
    (status <> 'tombstoned' AND tombstoned_at_ms IS NULL)
  )`,
  "CHECK (supersedes_memory_id IS NULL OR supersedes_memory_id <> memory_id)",
]);

const memoryItemsFtsTableDdl = [
  "CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(",
  "  tenant_id UNINDEXED,",
  "  memory_id UNINDEXED,",
  "  title,",
  "  payload_text,",
  "  tokenize = 'unicode61 remove_diacritics 2'",
  ");",
].join("\n");

const evidenceTableDdl = createStrictTableDdl("evidence", [
  "tenant_id TEXT NOT NULL",
  "evidence_id TEXT NOT NULL",
  "source_kind TEXT NOT NULL",
  "source_ref TEXT NOT NULL",
  "digest_sha256 TEXT NOT NULL",
  "payload_json TEXT NOT NULL",
  "observed_at_ms INTEGER NOT NULL",
  "created_at_ms INTEGER NOT NULL",
  "PRIMARY KEY (tenant_id, evidence_id)",
  "UNIQUE (tenant_id, source_kind, source_ref, digest_sha256)",
  "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
  `CHECK (source_kind IN (${toSqlStringLiteralList(enterpriseEvidenceSourceKinds)}))`,
  "CHECK (length(trim(evidence_id)) > 0)",
  "CHECK (length(trim(source_ref)) > 0)",
  "CHECK (length(digest_sha256) = 64)",
  "CHECK (digest_sha256 NOT GLOB '*[^0-9A-Fa-f]*')",
  "CHECK (json_valid(payload_json))",
  "CHECK (observed_at_ms >= 0)",
  "CHECK (created_at_ms >= observed_at_ms)",
]);

const provenanceEnvelopesTableDdl = createStrictTableDdl(
  "provenance_envelopes",
  [
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
    "observed_at_ms INTEGER NOT NULL",
    "created_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (tenant_id, provenance_id)",
    "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, role_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "CHECK (length(trim(provenance_id)) > 0)",
    "CHECK (project_id IS NULL OR length(trim(project_id)) > 0)",
    "CHECK (role_id IS NULL OR length(trim(role_id)) > 0)",
    "CHECK (user_id IS NULL OR length(trim(user_id)) > 0)",
    "CHECK (agent_id IS NULL OR length(trim(agent_id)) > 0)",
    "CHECK (conversation_id IS NULL OR length(trim(conversation_id)) > 0)",
    "CHECK (message_id IS NULL OR length(trim(message_id)) > 0)",
    "CHECK (source_id IS NULL OR length(trim(source_id)) > 0)",
    "CHECK (batch_id IS NULL OR length(trim(batch_id)) > 0)",
    "CHECK (observed_at_ms >= 0)",
    "CHECK (created_at_ms >= observed_at_ms)",
    `CHECK (
      project_id IS NOT NULL OR
      role_id IS NOT NULL OR
      user_id IS NOT NULL OR
      agent_id IS NOT NULL OR
      conversation_id IS NOT NULL OR
      message_id IS NOT NULL OR
      source_id IS NOT NULL OR
      batch_id IS NOT NULL
    )`,
  ]
);

const memoryEvidenceLinksTableDdl = createStrictTableDdl(
  "memory_evidence_links",
  [
    "tenant_id TEXT NOT NULL",
    "memory_id TEXT NOT NULL",
    "evidence_id TEXT NOT NULL",
    "relation_kind TEXT NOT NULL",
    "created_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (tenant_id, memory_id, evidence_id)",
    "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence (tenant_id, evidence_id) ON DELETE CASCADE ON UPDATE CASCADE",
    `CHECK (relation_kind IN (${toSqlStringLiteralList(enterpriseEvidenceRelationKinds)}))`,
    "CHECK (created_at_ms >= 0)",
  ]
);

const memoryProvenanceLinksTableDdl = createStrictTableDdl(
  "memory_provenance_links",
  [
    "tenant_id TEXT NOT NULL",
    "memory_id TEXT NOT NULL",
    "provenance_id TEXT NOT NULL",
    "linked_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (tenant_id, memory_id, provenance_id)",
    "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, provenance_id) REFERENCES provenance_envelopes (tenant_id, provenance_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "CHECK (linked_at_ms >= 0)",
  ]
);

const evidenceProvenanceLinksTableDdl = createStrictTableDdl(
  "evidence_provenance_links",
  [
    "tenant_id TEXT NOT NULL",
    "evidence_id TEXT NOT NULL",
    "provenance_id TEXT NOT NULL",
    "linked_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (tenant_id, evidence_id, provenance_id)",
    "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence (tenant_id, evidence_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, provenance_id) REFERENCES provenance_envelopes (tenant_id, provenance_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "CHECK (linked_at_ms >= 0)",
  ]
);

const feedbackTableDdl = createStrictTableDdl("feedback", [
  "tenant_id TEXT NOT NULL",
  "feedback_id TEXT NOT NULL",
  "memory_id TEXT NOT NULL",
  "evidence_id TEXT",
  "actor_user_id TEXT",
  "feedback_kind TEXT NOT NULL",
  "status TEXT NOT NULL",
  "severity INTEGER NOT NULL",
  "comment TEXT",
  "created_at_ms INTEGER NOT NULL",
  "resolved_at_ms INTEGER",
  "PRIMARY KEY (tenant_id, feedback_id)",
  "FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, memory_id) REFERENCES memory_items (tenant_id, memory_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence (tenant_id, evidence_id) ON DELETE CASCADE ON UPDATE CASCADE",
  "FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE",
  `CHECK (feedback_kind IN (${toSqlStringLiteralList(enterpriseFeedbackKinds)}))`,
  `CHECK (status IN (${toSqlStringLiteralList(enterpriseFeedbackStatuses)}))`,
  "CHECK (length(trim(feedback_id)) > 0)",
  "CHECK (severity BETWEEN 0 AND 100)",
  "CHECK (comment IS NULL OR length(trim(comment)) > 0)",
  "CHECK (created_at_ms >= 0)",
  `CHECK (
    (status = 'open' AND resolved_at_ms IS NULL) OR
    (status IN ('resolved', 'dismissed') AND resolved_at_ms IS NOT NULL AND resolved_at_ms >= created_at_ms)
  )`,
]);

const auditEventsTableDdl = createStrictTableDdl("audit_events", [
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
  "recorded_at_ms INTEGER NOT NULL",
  "PRIMARY KEY (event_id)",
  "CHECK (length(trim(event_id)) > 0)",
  "CHECK (length(trim(tenant_id)) > 0)",
  "CHECK (length(trim(memory_id)) > 0)",
  `CHECK (operation IN (${toSqlStringLiteralList(enterpriseAuditEventOperations)}))`,
  `CHECK (outcome IN (${toSqlStringLiteralList(enterpriseAuditEventOutcomes)}))`,
  `CHECK (reason IN (${toSqlStringLiteralList(enterpriseAuditEventReasons)}))`,
  "CHECK (length(trim(details)) > 0)",
  `CHECK (reference_kind IS NULL OR reference_kind IN (${toSqlStringLiteralList(enterpriseAuditEventReferenceKinds)}))`,
  "CHECK (reference_id IS NULL OR length(trim(reference_id)) > 0)",
  "CHECK (owner_tenant_id IS NULL OR length(trim(owner_tenant_id)) > 0)",
  "CHECK (recorded_at_ms >= 0)",
  `CHECK (
    (owner_tenant_id IS NULL AND reference_kind IS NULL AND reference_id IS NULL) OR
    (owner_tenant_id IS NOT NULL AND reference_kind IS NOT NULL AND reference_id IS NOT NULL)
  )`,
  `CHECK (
    (reason IN ('cross_tenant_reference', 'cross_tenant_delete_probe') AND owner_tenant_id IS NOT NULL) OR
    (reason NOT IN ('cross_tenant_reference', 'cross_tenant_delete_probe') AND owner_tenant_id IS NULL)
  )`,
]);

const auditEventProvenanceLinksTableDdl = createStrictTableDdl(
  "audit_event_provenance_links",
  [
    "event_id TEXT NOT NULL",
    "tenant_id TEXT NOT NULL",
    "provenance_id TEXT NOT NULL",
    "linked_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (event_id, provenance_id)",
    "FOREIGN KEY (event_id) REFERENCES audit_events (event_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "FOREIGN KEY (tenant_id, provenance_id) REFERENCES provenance_envelopes (tenant_id, provenance_id) ON DELETE CASCADE ON UPDATE CASCADE",
    "CHECK (length(trim(event_id)) > 0)",
    "CHECK (linked_at_ms >= 0)",
  ]
);

const storageIdempotencyLedgerTableDdl = createStrictTableDdl(
  "storage_idempotency_ledger",
  [
    "tenant_id TEXT NOT NULL",
    "operation TEXT NOT NULL",
    "idempotency_key TEXT NOT NULL",
    "request_hash_sha256 TEXT NOT NULL",
    "response_json TEXT NOT NULL",
    "created_at_ms INTEGER NOT NULL",
    "PRIMARY KEY (tenant_id, operation, idempotency_key)",
    "CHECK (length(trim(tenant_id)) > 0)",
    `CHECK (operation IN (${toSqlStringLiteralList(enterpriseAuditEventOperations)}))`,
    "CHECK (length(trim(idempotency_key)) > 0)",
    "CHECK (length(request_hash_sha256) = 64)",
    "CHECK (request_hash_sha256 NOT GLOB '*[^0-9A-Fa-f]*')",
    "CHECK (json_valid(response_json))",
    "CHECK (created_at_ms >= 0)",
  ]
);

export const enterpriseSqliteTables = Object.freeze([
  {
    name: "tenants",
    ddl: tenantsTableDdl,
    dependencies: [] as const,
  },
  {
    name: "users",
    ddl: usersTableDdl,
    dependencies: ["tenants"] as const,
  },
  {
    name: "projects",
    ddl: projectsTableDdl,
    dependencies: ["tenants"] as const,
  },
  {
    name: "roles",
    ddl: rolesTableDdl,
    dependencies: ["tenants"] as const,
  },
  {
    name: "project_memberships",
    ddl: projectMembershipsTableDdl,
    dependencies: ["tenants", "projects", "users", "roles"] as const,
  },
  {
    name: "user_role_assignments",
    ddl: userRoleAssignmentsTableDdl,
    dependencies: ["tenants", "users", "roles"] as const,
  },
  {
    name: "identity_issuer_bindings",
    ddl: identityIssuerBindingsTableDdl,
    dependencies: ["tenants"] as const,
  },
  {
    name: "user_external_subjects",
    ddl: userExternalSubjectsTableDdl,
    dependencies: ["identity_issuer_bindings", "users"] as const,
  },
  {
    name: "identity_sync_checkpoints",
    ddl: identitySyncCheckpointsTableDdl,
    dependencies: ["identity_issuer_bindings"] as const,
  },
  {
    name: "scopes",
    ddl: scopesTableDdl,
    dependencies: ["tenants", "projects", "roles", "users"] as const,
  },
  {
    name: "memory_items",
    ddl: memoryItemsTableDdl,
    dependencies: ["tenants", "scopes", "users"] as const,
  },
  {
    name: "memory_items_fts",
    ddl: memoryItemsFtsTableDdl,
    dependencies: ["memory_items"] as const,
  },
  {
    name: "evidence",
    ddl: evidenceTableDdl,
    dependencies: ["tenants"] as const,
  },
  {
    name: "provenance_envelopes",
    ddl: provenanceEnvelopesTableDdl,
    dependencies: ["tenants", "projects", "roles", "users"] as const,
  },
  {
    name: "memory_evidence_links",
    ddl: memoryEvidenceLinksTableDdl,
    dependencies: ["tenants", "memory_items", "evidence"] as const,
  },
  {
    name: "memory_provenance_links",
    ddl: memoryProvenanceLinksTableDdl,
    dependencies: ["tenants", "memory_items", "provenance_envelopes"] as const,
  },
  {
    name: "evidence_provenance_links",
    ddl: evidenceProvenanceLinksTableDdl,
    dependencies: ["tenants", "evidence", "provenance_envelopes"] as const,
  },
  {
    name: "feedback",
    ddl: feedbackTableDdl,
    dependencies: ["tenants", "memory_items", "evidence", "users"] as const,
  },
  {
    name: "audit_events",
    ddl: auditEventsTableDdl,
    dependencies: [] as const,
  },
  {
    name: "audit_event_provenance_links",
    ddl: auditEventProvenanceLinksTableDdl,
    dependencies: ["audit_events", "provenance_envelopes"] as const,
  },
  {
    name: "storage_idempotency_ledger",
    ddl: storageIdempotencyLedgerTableDdl,
    dependencies: [] as const,
  },
] as const satisfies readonly SqliteTableMetadata<EnterpriseSqliteTableName>[]);

const trgScopesParentLevelGuardInsertDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_scopes_parent_level_guard_insert",
  "BEFORE INSERT ON scopes",
  "FOR EACH ROW",
  "WHEN NEW.parent_scope_id IS NOT NULL",
  "BEGIN",
  "  SELECT CASE",
  "    WHEN NEW.scope_level = 'project' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level = 'common'",
  "    ) THEN RAISE(ABORT, 'SCOPE_PARENT_LEVEL_INVALID')",
  "    WHEN NEW.scope_level = 'job_role' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level = 'common'",
  "    ) THEN RAISE(ABORT, 'SCOPE_PARENT_LEVEL_INVALID')",
  "    WHEN NEW.scope_level = 'user' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level IN ('common', 'project', 'job_role')",
  "    ) THEN RAISE(ABORT, 'SCOPE_PARENT_LEVEL_INVALID')",
  "  END;",
  "END;",
].join("\n");

const trgScopesScopeLevelImmutableDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_scopes_scope_level_immutable",
  "BEFORE UPDATE OF scope_level ON scopes",
  "FOR EACH ROW",
  "WHEN NEW.scope_level <> OLD.scope_level",
  "BEGIN",
  "  SELECT RAISE(ABORT, 'SCOPE_LEVEL_IMMUTABLE');",
  "END;",
].join("\n");

const trgScopesAnchorImmutableDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_scopes_anchor_immutable",
  "BEFORE UPDATE OF tenant_id, parent_scope_id, project_id, role_id, user_id ON scopes",
  "FOR EACH ROW",
  "WHEN",
  "  NEW.tenant_id IS NOT OLD.tenant_id OR",
  "  NEW.parent_scope_id IS NOT OLD.parent_scope_id OR",
  "  NEW.project_id IS NOT OLD.project_id OR",
  "  NEW.role_id IS NOT OLD.role_id OR",
  "  NEW.user_id IS NOT OLD.user_id",
  "BEGIN",
  "  SELECT RAISE(ABORT, 'SCOPE_ANCHOR_IMMUTABLE');",
  "END;",
].join("\n");

const trgScopesParentLevelGuardUpdateDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_scopes_parent_level_guard_update",
  "BEFORE UPDATE OF tenant_id, parent_scope_id, scope_level ON scopes",
  "FOR EACH ROW",
  "WHEN NEW.parent_scope_id IS NOT NULL",
  "BEGIN",
  "  SELECT CASE",
  "    WHEN NEW.scope_level = 'project' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level = 'common'",
  "    ) THEN RAISE(ABORT, 'SCOPE_PARENT_LEVEL_INVALID')",
  "    WHEN NEW.scope_level = 'job_role' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level = 'common'",
  "    ) THEN RAISE(ABORT, 'SCOPE_PARENT_LEVEL_INVALID')",
  "    WHEN NEW.scope_level = 'user' AND NOT EXISTS (",
  "      SELECT 1 FROM scopes parent",
  "      WHERE parent.tenant_id = NEW.tenant_id",
  "        AND parent.scope_id = NEW.parent_scope_id",
  "        AND parent.scope_level IN ('common', 'project', 'job_role')",
  "    ) THEN RAISE(ABORT, 'SCOPE_PARENT_LEVEL_INVALID')",
  "  END;",
  "END;",
].join("\n");

const trgScopesNoCycleInsertDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_scopes_no_cycle_insert",
  "BEFORE INSERT ON scopes",
  "FOR EACH ROW",
  "WHEN NEW.parent_scope_id IS NOT NULL",
  "BEGIN",
  "  WITH RECURSIVE ancestry(scope_id, parent_scope_id) AS (",
  "    SELECT scope_id, parent_scope_id",
  "    FROM scopes",
  "    WHERE tenant_id = NEW.tenant_id AND scope_id = NEW.parent_scope_id",
  "    UNION ALL",
  "    SELECT child.scope_id, child.parent_scope_id",
  "    FROM scopes child",
  "    JOIN ancestry parent ON child.tenant_id = NEW.tenant_id AND child.scope_id = parent.parent_scope_id",
  "    WHERE parent.parent_scope_id IS NOT NULL",
  "  )",
  "  SELECT CASE",
  "    WHEN EXISTS (SELECT 1 FROM ancestry WHERE scope_id = NEW.scope_id)",
  "    THEN RAISE(ABORT, 'SCOPE_CYCLE_DETECTED')",
  "  END;",
  "END;",
].join("\n");

const trgScopesNoCycleUpdateDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_scopes_no_cycle_update",
  "BEFORE UPDATE OF tenant_id, parent_scope_id ON scopes",
  "FOR EACH ROW",
  "WHEN NEW.parent_scope_id IS NOT NULL",
  "BEGIN",
  "  WITH RECURSIVE ancestry(scope_id, parent_scope_id) AS (",
  "    SELECT scope_id, parent_scope_id",
  "    FROM scopes",
  "    WHERE tenant_id = NEW.tenant_id AND scope_id = NEW.parent_scope_id",
  "    UNION ALL",
  "    SELECT child.scope_id, child.parent_scope_id",
  "    FROM scopes child",
  "    JOIN ancestry parent ON child.tenant_id = NEW.tenant_id AND child.scope_id = parent.parent_scope_id",
  "    WHERE parent.parent_scope_id IS NOT NULL",
  "  )",
  "  SELECT CASE",
  "    WHEN EXISTS (SELECT 1 FROM ancestry WHERE scope_id = NEW.scope_id)",
  "    THEN RAISE(ABORT, 'SCOPE_CYCLE_DETECTED')",
  "  END;",
  "END;",
].join("\n");

const trgMemoryItemsNoSupersedesCycleInsertDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_memory_items_no_supersedes_cycle_insert",
  "BEFORE INSERT ON memory_items",
  "FOR EACH ROW",
  "WHEN NEW.supersedes_memory_id IS NOT NULL",
  "BEGIN",
  "  WITH RECURSIVE ancestry(memory_id, supersedes_memory_id) AS (",
  "    SELECT memory_id, supersedes_memory_id",
  "    FROM memory_items",
  "    WHERE tenant_id = NEW.tenant_id AND memory_id = NEW.supersedes_memory_id",
  "    UNION ALL",
  "    SELECT predecessor.memory_id, predecessor.supersedes_memory_id",
  "    FROM memory_items predecessor",
  "    JOIN ancestry current ON predecessor.tenant_id = NEW.tenant_id AND predecessor.memory_id = current.supersedes_memory_id",
  "    WHERE current.supersedes_memory_id IS NOT NULL",
  "  )",
  "  SELECT CASE",
  "    WHEN EXISTS (SELECT 1 FROM ancestry WHERE memory_id = NEW.memory_id)",
  "    THEN RAISE(ABORT, 'MEMORY_SUPERSEDES_CYCLE_DETECTED')",
  "  END;",
  "END;",
].join("\n");

const trgMemoryItemsNoSupersedesCycleUpdateDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_memory_items_no_supersedes_cycle_update",
  "BEFORE UPDATE OF tenant_id, supersedes_memory_id ON memory_items",
  "FOR EACH ROW",
  "WHEN NEW.supersedes_memory_id IS NOT NULL",
  "BEGIN",
  "  WITH RECURSIVE ancestry(memory_id, supersedes_memory_id) AS (",
  "    SELECT memory_id, supersedes_memory_id",
  "    FROM memory_items",
  "    WHERE tenant_id = NEW.tenant_id AND memory_id = NEW.supersedes_memory_id",
  "    UNION ALL",
  "    SELECT predecessor.memory_id, predecessor.supersedes_memory_id",
  "    FROM memory_items predecessor",
  "    JOIN ancestry current ON predecessor.tenant_id = NEW.tenant_id AND predecessor.memory_id = current.supersedes_memory_id",
  "    WHERE current.supersedes_memory_id IS NOT NULL",
  "  )",
  "  SELECT CASE",
  "    WHEN EXISTS (SELECT 1 FROM ancestry WHERE memory_id = NEW.memory_id)",
  "    THEN RAISE(ABORT, 'MEMORY_SUPERSEDES_CYCLE_DETECTED')",
  "  END;",
  "END;",
].join("\n");

const trgMemoryItemsFtsInsertDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_insert",
  "AFTER INSERT ON memory_items",
  "FOR EACH ROW",
  "BEGIN",
  "  INSERT INTO memory_items_fts (rowid, tenant_id, memory_id, title, payload_text)",
  "  VALUES (NEW.rowid, NEW.tenant_id, NEW.memory_id, NEW.title, NEW.payload_json);",
  "END;",
].join("\n");

const trgMemoryItemsFtsDeleteDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_delete",
  "AFTER DELETE ON memory_items",
  "FOR EACH ROW",
  "BEGIN",
  "  DELETE FROM memory_items_fts WHERE rowid = OLD.rowid;",
  "END;",
].join("\n");

const trgMemoryItemsFtsUpdateDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_update",
  "AFTER UPDATE ON memory_items",
  "FOR EACH ROW",
  "BEGIN",
  "  DELETE FROM memory_items_fts WHERE rowid = OLD.rowid;",
  "  INSERT INTO memory_items_fts (rowid, tenant_id, memory_id, title, payload_text)",
  "  VALUES (NEW.rowid, NEW.tenant_id, NEW.memory_id, NEW.title, NEW.payload_json);",
  "END;",
].join("\n");

const trgAuditEventsAppendOnlyUpdateDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_audit_events_append_only_update",
  "BEFORE UPDATE ON audit_events",
  "FOR EACH ROW",
  "BEGIN",
  "  SELECT RAISE(ABORT, 'AUDIT_EVENTS_APPEND_ONLY');",
  "END;",
].join("\n");

const trgAuditEventsAppendOnlyDeleteDdl = [
  "CREATE TRIGGER IF NOT EXISTS trg_audit_events_append_only_delete",
  "BEFORE DELETE ON audit_events",
  "FOR EACH ROW",
  "BEGIN",
  "  SELECT RAISE(ABORT, 'AUDIT_EVENTS_APPEND_ONLY');",
  "END;",
].join("\n");

export const enterpriseSqliteTriggerNames = Object.freeze([
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

export type EnterpriseSqliteTriggerName =
  (typeof enterpriseSqliteTriggerNames)[number];

export const enterpriseSqliteTriggers = Object.freeze([
  {
    name: "trg_scopes_scope_level_immutable",
    table: "scopes",
    ddl: trgScopesScopeLevelImmutableDdl,
  },
  {
    name: "trg_scopes_anchor_immutable",
    table: "scopes",
    ddl: trgScopesAnchorImmutableDdl,
  },
  {
    name: "trg_scopes_parent_level_guard_insert",
    table: "scopes",
    ddl: trgScopesParentLevelGuardInsertDdl,
  },
  {
    name: "trg_scopes_parent_level_guard_update",
    table: "scopes",
    ddl: trgScopesParentLevelGuardUpdateDdl,
  },
  {
    name: "trg_scopes_no_cycle_insert",
    table: "scopes",
    ddl: trgScopesNoCycleInsertDdl,
  },
  {
    name: "trg_scopes_no_cycle_update",
    table: "scopes",
    ddl: trgScopesNoCycleUpdateDdl,
  },
  {
    name: "trg_memory_items_no_supersedes_cycle_insert",
    table: "memory_items",
    ddl: trgMemoryItemsNoSupersedesCycleInsertDdl,
  },
  {
    name: "trg_memory_items_no_supersedes_cycle_update",
    table: "memory_items",
    ddl: trgMemoryItemsNoSupersedesCycleUpdateDdl,
  },
  {
    name: "trg_memory_items_fts_insert",
    table: "memory_items",
    ddl: trgMemoryItemsFtsInsertDdl,
  },
  {
    name: "trg_memory_items_fts_delete",
    table: "memory_items",
    ddl: trgMemoryItemsFtsDeleteDdl,
  },
  {
    name: "trg_memory_items_fts_update",
    table: "memory_items",
    ddl: trgMemoryItemsFtsUpdateDdl,
  },
  {
    name: "trg_audit_events_append_only_update",
    table: "audit_events",
    ddl: trgAuditEventsAppendOnlyUpdateDdl,
  },
  {
    name: "trg_audit_events_append_only_delete",
    table: "audit_events",
    ddl: trgAuditEventsAppendOnlyDeleteDdl,
  },
] as const);

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
  "WHERE is_primary = 1;",
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

export const enterpriseSqliteIndexNames = Object.freeze([
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

export type EnterpriseSqliteIndexName =
  (typeof enterpriseSqliteIndexNames)[number];

export const enterpriseSqliteIndexes = Object.freeze([
  {
    name: "idx_users_tenant_status",
    table: "users",
    unique: false,
    ddl: idxUsersTenantStatusDdl,
  },
  {
    name: "idx_projects_tenant_status",
    table: "projects",
    unique: false,
    ddl: idxProjectsTenantStatusDdl,
  },
  {
    name: "idx_project_memberships_user",
    table: "project_memberships",
    unique: false,
    ddl: idxProjectMembershipsUserDdl,
  },
  {
    name: "idx_user_role_assignments_role",
    table: "user_role_assignments",
    unique: false,
    ddl: idxUserRoleAssignmentsRoleDdl,
  },
  {
    name: "idx_identity_issuer_bindings_kind",
    table: "identity_issuer_bindings",
    unique: false,
    ddl: idxIdentityIssuerBindingsKindDdl,
  },
  {
    name: "uq_identity_issuer_bindings_primary",
    table: "identity_issuer_bindings",
    unique: true,
    ddl: uqIdentityIssuerBindingsPrimaryDdl,
  },
  {
    name: "idx_user_external_subjects_user",
    table: "user_external_subjects",
    unique: false,
    ddl: idxUserExternalSubjectsUserDdl,
  },
  {
    name: "idx_user_external_subjects_subject_hash",
    table: "user_external_subjects",
    unique: false,
    ddl: idxUserExternalSubjectsSubjectHashDdl,
  },
  {
    name: "idx_identity_sync_checkpoints_updated",
    table: "identity_sync_checkpoints",
    unique: false,
    ddl: idxIdentitySyncCheckpointsUpdatedDdl,
  },
  {
    name: "uq_scopes_common_singleton",
    table: "scopes",
    unique: true,
    ddl: uqScopesCommonSingletonDdl,
  },
  {
    name: "uq_scopes_project_anchor",
    table: "scopes",
    unique: true,
    ddl: uqScopesProjectAnchorDdl,
  },
  {
    name: "uq_scopes_role_anchor",
    table: "scopes",
    unique: true,
    ddl: uqScopesRoleAnchorDdl,
  },
  {
    name: "uq_scopes_user_anchor",
    table: "scopes",
    unique: true,
    ddl: uqScopesUserAnchorDdl,
  },
  {
    name: "idx_scopes_parent",
    table: "scopes",
    unique: false,
    ddl: idxScopesParentDdl,
  },
  {
    name: "idx_memory_items_scope_status",
    table: "memory_items",
    unique: false,
    ddl: idxMemoryItemsScopeStatusDdl,
  },
  {
    name: "idx_memory_items_supersedes",
    table: "memory_items",
    unique: false,
    ddl: idxMemoryItemsSupersedesDdl,
  },
  {
    name: "idx_evidence_source_observed",
    table: "evidence",
    unique: false,
    ddl: idxEvidenceSourceObservedDdl,
  },
  {
    name: "idx_provenance_envelopes_lookup",
    table: "provenance_envelopes",
    unique: false,
    ddl: idxProvenanceEnvelopesLookupDdl,
  },
  {
    name: "idx_memory_evidence_links_memory",
    table: "memory_evidence_links",
    unique: false,
    ddl: idxMemoryEvidenceLinksMemoryDdl,
  },
  {
    name: "idx_memory_provenance_links_memory",
    table: "memory_provenance_links",
    unique: false,
    ddl: idxMemoryProvenanceLinksMemoryDdl,
  },
  {
    name: "idx_memory_provenance_links_provenance",
    table: "memory_provenance_links",
    unique: false,
    ddl: idxMemoryProvenanceLinksProvenanceDdl,
  },
  {
    name: "idx_evidence_provenance_links_evidence",
    table: "evidence_provenance_links",
    unique: false,
    ddl: idxEvidenceProvenanceLinksEvidenceDdl,
  },
  {
    name: "idx_evidence_provenance_links_provenance",
    table: "evidence_provenance_links",
    unique: false,
    ddl: idxEvidenceProvenanceLinksProvenanceDdl,
  },
  {
    name: "idx_feedback_memory_status",
    table: "feedback",
    unique: false,
    ddl: idxFeedbackMemoryStatusDdl,
  },
  {
    name: "idx_feedback_actor_created",
    table: "feedback",
    unique: false,
    ddl: idxFeedbackActorCreatedDdl,
  },
  {
    name: "idx_audit_events_tenant_operation",
    table: "audit_events",
    unique: false,
    ddl: idxAuditEventsTenantOperationDdl,
  },
  {
    name: "idx_audit_events_owner_reference",
    table: "audit_events",
    unique: false,
    ddl: idxAuditEventsOwnerReferenceDdl,
  },
  {
    name: "idx_audit_event_provenance_links_event",
    table: "audit_event_provenance_links",
    unique: false,
    ddl: idxAuditEventProvenanceLinksEventDdl,
  },
  {
    name: "idx_audit_event_provenance_links_tenant_provenance",
    table: "audit_event_provenance_links",
    unique: false,
    ddl: idxAuditEventProvenanceLinksTenantProvenanceDdl,
  },
  {
    name: "idx_storage_idempotency_ledger_created",
    table: "storage_idempotency_ledger",
    unique: false,
    ddl: idxStorageIdempotencyLedgerCreatedDdl,
  },
  {
    name: "idx_storage_idempotency_ledger_request_hash",
    table: "storage_idempotency_ledger",
    unique: false,
    ddl: idxStorageIdempotencyLedgerRequestHashDdl,
  },
] as const satisfies readonly SqliteIndexMetadata<
  EnterpriseSqliteIndexName,
  EnterpriseSqliteTableName
>[]);

export const enterpriseSqliteSchemaStatements = Object.freeze([
  ...enterpriseSqliteTables.map((table) => table.ddl),
  ...enterpriseSqliteTriggers.map((trigger) => trigger.ddl),
  ...enterpriseSqliteIndexes.map((index) => index.ddl),
]);

export const enterpriseSqliteSchemaSql = `${enterpriseSqliteSchemaStatements.join("\n\n")}\n`;

export const enterpriseSqliteSchemaVersion = 6 as const;

export const enterpriseSqliteSchema: SqliteSchemaMetadata<
  EnterpriseSqliteTableName,
  EnterpriseSqliteIndexName
> = Object.freeze({
  tables: enterpriseSqliteTables,
  indexes: enterpriseSqliteIndexes,
  statements: enterpriseSqliteSchemaStatements,
  sql: enterpriseSqliteSchemaSql,
});
