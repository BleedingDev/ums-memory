import type {
  SqliteIndexMetadata,
  SqliteSchemaMetadata,
  SqliteTableMetadata,
} from "./schema-metadata.js";

const toSqlStringLiteralList = (values: ReadonlyArray<string>): string =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");

const createStrictTableDdl = (tableName: string, definitions: ReadonlyArray<string>): string =>
  `CREATE TABLE IF NOT EXISTS ${tableName} (\n${definitions.map((definition) => `  ${definition}`).join(",\n")}\n) STRICT;`;

export const enterpriseScopeLevels = Object.freeze([
  "common",
  "project",
  "job_role",
  "user",
] as const);
export const enterpriseUserStatuses = Object.freeze(["active", "disabled", "pending"] as const);
export const enterpriseProjectStatuses = Object.freeze(["active", "archived"] as const);
export const enterpriseRoleTypes = Object.freeze(["system", "project", "custom"] as const);
export const enterpriseMemoryLayers = Object.freeze(["episodic", "working", "procedural"] as const);
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
export const enterpriseFeedbackStatuses = Object.freeze(["open", "resolved", "dismissed"] as const);

export type EnterpriseScopeLevel = (typeof enterpriseScopeLevels)[number];
export type EnterpriseUserStatus = (typeof enterpriseUserStatuses)[number];
export type EnterpriseProjectStatus = (typeof enterpriseProjectStatuses)[number];
export type EnterpriseRoleType = (typeof enterpriseRoleTypes)[number];
export type EnterpriseMemoryLayer = (typeof enterpriseMemoryLayers)[number];
export type EnterpriseMemoryKind = (typeof enterpriseMemoryKinds)[number];
export type EnterpriseMemoryStatus = (typeof enterpriseMemoryStatuses)[number];
export type EnterpriseEvidenceSourceKind = (typeof enterpriseEvidenceSourceKinds)[number];
export type EnterpriseEvidenceRelationKind = (typeof enterpriseEvidenceRelationKinds)[number];
export type EnterpriseFeedbackKind = (typeof enterpriseFeedbackKinds)[number];
export type EnterpriseFeedbackStatus = (typeof enterpriseFeedbackStatuses)[number];

export const enterpriseSqliteTableNames = Object.freeze([
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
] as const);

export type EnterpriseSqliteTableName = (typeof enterpriseSqliteTableNames)[number];

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

const userRoleAssignmentsTableDdl = createStrictTableDdl("user_role_assignments", [
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
]);

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

const memoryEvidenceLinksTableDdl = createStrictTableDdl("memory_evidence_links", [
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
]);

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
    name: "evidence",
    ddl: evidenceTableDdl,
    dependencies: ["tenants"] as const,
  },
  {
    name: "memory_evidence_links",
    ddl: memoryEvidenceLinksTableDdl,
    dependencies: ["tenants", "memory_items", "evidence"] as const,
  },
  {
    name: "feedback",
    ddl: feedbackTableDdl,
    dependencies: ["tenants", "memory_items", "evidence", "users"] as const,
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

export const enterpriseSqliteTriggerNames = Object.freeze([
  "trg_scopes_scope_level_immutable",
  "trg_scopes_anchor_immutable",
  "trg_scopes_parent_level_guard_insert",
  "trg_scopes_parent_level_guard_update",
  "trg_scopes_no_cycle_insert",
  "trg_scopes_no_cycle_update",
  "trg_memory_items_no_supersedes_cycle_insert",
  "trg_memory_items_no_supersedes_cycle_update",
] as const);

export type EnterpriseSqliteTriggerName = (typeof enterpriseSqliteTriggerNames)[number];

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
] as const);

const idxUsersTenantStatusDdl =
  "CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON users (tenant_id, status, user_id);";
const idxProjectsTenantStatusDdl =
  "CREATE INDEX IF NOT EXISTS idx_projects_tenant_status ON projects (tenant_id, status, project_id);";
const idxProjectMembershipsUserDdl =
  "CREATE INDEX IF NOT EXISTS idx_project_memberships_user ON project_memberships (tenant_id, user_id, project_id);";
const idxUserRoleAssignmentsRoleDdl =
  "CREATE INDEX IF NOT EXISTS idx_user_role_assignments_role ON user_role_assignments (tenant_id, role_id, user_id);";
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
const idxMemoryEvidenceLinksMemoryDdl = [
  "CREATE INDEX IF NOT EXISTS idx_memory_evidence_links_memory ON memory_evidence_links",
  "(tenant_id, memory_id, relation_kind, evidence_id);",
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

export const enterpriseSqliteIndexNames = Object.freeze([
  "idx_users_tenant_status",
  "idx_projects_tenant_status",
  "idx_project_memberships_user",
  "idx_user_role_assignments_role",
  "uq_scopes_common_singleton",
  "uq_scopes_project_anchor",
  "uq_scopes_role_anchor",
  "uq_scopes_user_anchor",
  "idx_scopes_parent",
  "idx_memory_items_scope_status",
  "idx_memory_items_supersedes",
  "idx_evidence_source_observed",
  "idx_memory_evidence_links_memory",
  "idx_feedback_memory_status",
  "idx_feedback_actor_created",
] as const);

export type EnterpriseSqliteIndexName = (typeof enterpriseSqliteIndexNames)[number];

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
    name: "idx_memory_evidence_links_memory",
    table: "memory_evidence_links",
    unique: false,
    ddl: idxMemoryEvidenceLinksMemoryDdl,
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

export const enterpriseSqliteSchemaVersion = 1 as const;

export const enterpriseSqliteSchema: SqliteSchemaMetadata<
  EnterpriseSqliteTableName,
  EnterpriseSqliteIndexName
> = Object.freeze({
  tables: enterpriseSqliteTables,
  indexes: enterpriseSqliteIndexes,
  statements: enterpriseSqliteSchemaStatements,
  sql: enterpriseSqliteSchemaSql,
});
