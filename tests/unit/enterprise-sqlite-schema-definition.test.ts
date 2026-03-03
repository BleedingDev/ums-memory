import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import ts from "typescript";

const schemaPath = new URL(
  "../../libs/shared/src/effect/storage/sqlite/enterprise-schema.ts",
  import.meta.url
);
const schemaSource = readFileSync(schemaPath, "utf8");

const expectedTableOrder = Object.freeze([
  "tenants",
  "users",
  "projects",
  "roles",
  "project_memberships",
  "user_role_assignments",
  "scopes",
  "memory_items",
  "memory_items_fts",
  "evidence",
  "memory_evidence_links",
  "feedback",
  "audit_events",
  "storage_idempotency_ledger",
]);

const expectedIndexOrder = Object.freeze([
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
  "idx_audit_events_tenant_operation",
  "idx_audit_events_owner_reference",
  "idx_storage_idempotency_ledger_created",
  "idx_storage_idempotency_ledger_request_hash",
]);

const expectedTriggerOrder = Object.freeze([
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
]);

let schemaModulePromise;

const loadSchemaModule = async () => {
  if (!schemaModulePromise) {
    const transpiled = ts.transpileModule(schemaSource, {
      fileName: schemaPath.pathname,
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const encoded = Buffer.from(transpiled.outputText, "utf8").toString(
      "base64"
    );
    schemaModulePromise = import(`data:text/javascript;base64,${encoded}`);
  }
  return schemaModulePromise;
};

const expectConstraintFailure = (callback) => {
  assert.throws(
    callback,
    /constraint|check|foreign key|scope_parent_level_invalid|scope_cycle_detected|scope_level_immutable|scope_anchor_immutable|memory_supersedes_cycle_detected|audit_events_append_only/i
  );
};

const countRows = (db, tableName) => {
  const result = db
    .prepare(`SELECT COUNT(*) AS row_count FROM ${tableName}`)
    .get();
  return Number(result?.row_count ?? 0);
};

const countRowsByTenant = (db, tableName, tenantId) => {
  const result = db
    .prepare(
      `SELECT COUNT(*) AS row_count FROM ${tableName} WHERE tenant_id = ?`
    )
    .get(tenantId);
  return Number(result?.row_count ?? 0);
};

test("ums-memory-5cb.1: enterprise sqlite schema ordering is deterministic", async () => {
  const schema = await loadSchemaModule();

  assert.deepEqual(
    [...schema.enterpriseSqliteTableNames],
    [...expectedTableOrder]
  );
  assert.deepEqual(
    [...schema.enterpriseSqliteIndexNames],
    [...expectedIndexOrder]
  );
  assert.deepEqual(
    [...schema.enterpriseSqliteTriggerNames],
    [...expectedTriggerOrder]
  );
  assert.deepEqual(
    schema.enterpriseSqliteTables.map((table) => table.name),
    [...expectedTableOrder]
  );
  assert.deepEqual(
    schema.enterpriseSqliteIndexes.map((index) => index.name),
    [...expectedIndexOrder]
  );
  assert.deepEqual(
    schema.enterpriseSqliteTriggers.map((trigger) => trigger.name),
    [...expectedTriggerOrder]
  );
  assert.equal(schema.enterpriseSqliteTables.length, expectedTableOrder.length);
  assert.equal(
    schema.enterpriseSqliteIndexes.length,
    expectedIndexOrder.length
  );
  assert.equal(
    schema.enterpriseSqliteTriggers.length,
    expectedTriggerOrder.length
  );

  const expectedStatements = [
    ...schema.enterpriseSqliteTables.map((table) => table.ddl),
    ...schema.enterpriseSqliteTriggers.map((trigger) => trigger.ddl),
    ...schema.enterpriseSqliteIndexes.map((index) => index.ddl),
  ];
  assert.deepEqual(schema.enterpriseSqliteSchemaStatements, expectedStatements);
  assert.equal(
    schema.enterpriseSqliteSchemaSql,
    `${schema.enterpriseSqliteSchemaStatements.join("\n\n")}\n`
  );
  assert.equal(schema.enterpriseSqliteSchemaVersion, 4);
});

test("ums-memory-5cb.1: enterprise sqlite schema enforces key constraints at runtime", async () => {
  const schema = await loadSchemaModule();
  const db = new DatabaseSync(":memory:");

  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(schema.enterpriseSqliteSchemaSql);

    const now = 1_700_000_000_000;
    db.prepare(
      "INSERT INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)"
    ).run("tenant_a", "tenant-a", "Tenant A", now, now);

    db.prepare(
      "INSERT INTO projects (tenant_id, project_id, project_key, display_name, status, created_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("tenant_a", "project_a", "PROJ-A", "Project A", "active", now, null);
    db.prepare(
      "INSERT INTO projects (tenant_id, project_id, project_key, display_name, status, created_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "project_alt",
      "PROJ-ALT",
      "Project Alt",
      "active",
      now,
      null
    );

    db.prepare(
      "INSERT INTO users (tenant_id, user_id, email, display_name, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "user_a",
      "user_a@example.com",
      "User A",
      "active",
      now,
      now
    );

    db.prepare(
      "INSERT INTO roles (tenant_id, role_id, role_code, display_name, role_type, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("tenant_a", "role_a", "ROLE_A", "Role A", "project", now);
    db.prepare(
      "INSERT INTO roles (tenant_id, role_id, role_code, display_name, role_type, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("tenant_a", "role_b", "ROLE_B", "Role B", "project", now);

    db.prepare(
      "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("tenant_a", "scope_common", "common", null, null, null, null, now);

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "scope_project_missing_parent",
        "project",
        "project_a",
        null,
        null,
        null,
        now
      );
    });

    db.prepare(
      "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "scope_project",
      "project",
      "project_a",
      null,
      null,
      "scope_common",
      now
    );

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "scope_common_duplicate",
        "common",
        null,
        null,
        null,
        null,
        now
      );
    });

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "scope_project_duplicate",
        "project",
        "project_a",
        null,
        null,
        "scope_common",
        now
      );
    });

    db.prepare(
      "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "scope_role",
      "job_role",
      null,
      "role_b",
      null,
      "scope_common",
      now
    );
    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "scope_role_duplicate",
        "job_role",
        null,
        "role_b",
        null,
        "scope_common",
        now
      );
    });

    db.prepare(
      "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "scope_user",
      "user",
      null,
      null,
      "user_a",
      "scope_project",
      now
    );
    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "scope_user_duplicate",
        "user",
        null,
        null,
        "user_a",
        "scope_project",
        now
      );
    });

    db.prepare(
      "INSERT INTO project_memberships (tenant_id, project_id, user_id, role_id, assigned_at_ms) VALUES (?, ?, ?, ?, ?)"
    ).run("tenant_a", "project_a", "user_a", "role_a", now);

    db.prepare(
      "INSERT INTO user_role_assignments (tenant_id, user_id, role_id, assigned_at_ms, assigned_by_user_id) VALUES (?, ?, ?, ?, ?)"
    ).run("tenant_a", "user_a", "role_b", now, "user_a");

    db.prepare(
      "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "memory_ok",
      "scope_project",
      "working",
      "note",
      "active",
      "Valid Memory",
      "{}",
      null,
      null,
      now,
      now,
      null,
      null
    );

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "scope_common_invalid_parent",
        "common",
        null,
        null,
        null,
        "scope_project",
        now + 1
      );
    });

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO projects (tenant_id, project_id, project_key, display_name, status, created_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "project_archived_invalid",
        "PROJ-ARCH",
        "Project Archived Invalid",
        "archived",
        now,
        null
      );
    });

    expectConstraintFailure(() => {
      const invalidDigest = `a${"z".repeat(63)}`;
      db.prepare(
        "INSERT INTO evidence (tenant_id, evidence_id, source_kind, source_ref, digest_sha256, payload_json, observed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "evidence_bad_digest",
        "event",
        "event://bad",
        invalidDigest,
        "{}",
        now,
        now
      );
    });

    db.prepare(
      "INSERT INTO evidence (tenant_id, evidence_id, source_kind, source_ref, digest_sha256, payload_json, observed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "evidence_ok",
      "event",
      "event://ok",
      "a".repeat(64),
      "{}",
      now,
      now
    );
    db.prepare(
      "INSERT INTO memory_evidence_links (tenant_id, memory_id, evidence_id, relation_kind, created_at_ms) VALUES (?, ?, ?, ?, ?)"
    ).run("tenant_a", "memory_ok", "evidence_ok", "supports", now);

    db.prepare(
      "INSERT INTO audit_events (event_id, tenant_id, memory_id, operation, outcome, reason, details, reference_kind, reference_id, owner_tenant_id, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "audit:test:event-1",
      "tenant_a",
      "memory_ok",
      "upsert",
      "accepted",
      "inserted",
      "deterministic test event",
      null,
      null,
      null,
      now
    );
    expectConstraintFailure(() => {
      db.prepare("UPDATE audit_events SET details = ? WHERE event_id = ?").run(
        "attempted mutation",
        "audit:test:event-1"
      );
    });
    expectConstraintFailure(() => {
      db.prepare("DELETE FROM audit_events WHERE event_id = ?").run(
        "audit:test:event-1"
      );
    });

    db.prepare(
      "INSERT INTO feedback (tenant_id, feedback_id, memory_id, evidence_id, actor_user_id, feedback_kind, status, severity, comment, created_at_ms, resolved_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "feedback_ok",
      "memory_ok",
      "evidence_ok",
      "user_a",
      "helpful",
      "open",
      20,
      "Useful memory entry",
      now,
      null
    );

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO feedback (tenant_id, feedback_id, memory_id, evidence_id, actor_user_id, feedback_kind, status, severity, comment, created_at_ms, resolved_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "feedback_invalid_lifecycle",
        "memory_ok",
        null,
        null,
        "harmful",
        "open",
        70,
        "Should fail because open feedback cannot be resolved.",
        now,
        now
      );
    });

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "memory_negative_created_at",
        "scope_project",
        "working",
        "note",
        "active",
        "Negative Created At",
        "{}",
        null,
        null,
        -1,
        0,
        null,
        null
      );
    });

    db.prepare("DELETE FROM roles WHERE tenant_id = ? AND role_id = ?").run(
      "tenant_a",
      "role_a"
    );
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS row_count FROM project_memberships WHERE tenant_id = ? AND project_id = ? AND user_id = ?"
          )
          .get("tenant_a", "project_a", "user_a")?.row_count ?? 0
      ),
      0
    );

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "",
        "scope_project",
        "working",
        "note",
        "active",
        "Empty Memory Id",
        "{}",
        null,
        null,
        now,
        now,
        null,
        null
      );
    });

    db.prepare(
      "INSERT INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)"
    ).run("tenant_b", "tenant-b", "Tenant B", now, now);
    db.prepare(
      "INSERT INTO projects (tenant_id, project_id, project_key, display_name, status, created_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("tenant_b", "project_b", "PROJ-B", "Project B", "active", now, null);
    db.prepare(
      "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("tenant_b", "scope_common_b", "common", null, null, null, null, now);
    db.prepare(
      "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_b",
      "scope_project_b",
      "project",
      "project_b",
      null,
      null,
      "scope_common_b",
      now
    );

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "memory_cross_tenant_scope",
        "scope_project_b",
        "working",
        "note",
        "active",
        "Cross Tenant Scope",
        "{}",
        null,
        null,
        now,
        now,
        null,
        null
      );
    });

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "scope_project_bad_parent_level",
        "project",
        "project_a",
        null,
        null,
        "scope_project",
        now
      );
    });

    expectConstraintFailure(() => {
      db.prepare(
        "UPDATE scopes SET scope_level = ?, project_id = ?, user_id = ? WHERE tenant_id = ? AND scope_id = ?"
      ).run("user", null, "user_a", "tenant_a", "scope_project");
    });

    expectConstraintFailure(() => {
      db.prepare(
        "UPDATE scopes SET project_id = ? WHERE tenant_id = ? AND scope_id = ?"
      ).run("project_alt", "tenant_a", "scope_project");
    });

    db.prepare(
      "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "memory_cycle_a",
      "scope_project",
      "working",
      "note",
      "active",
      "Memory Cycle A",
      "{}",
      null,
      null,
      now,
      now,
      null,
      null
    );
    db.prepare(
      "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_a",
      "memory_cycle_b",
      "scope_project",
      "working",
      "note",
      "active",
      "Memory Cycle B",
      "{}",
      null,
      "memory_cycle_a",
      now,
      now,
      null,
      null
    );

    expectConstraintFailure(() => {
      db.prepare(
        "UPDATE memory_items SET supersedes_memory_id = ? WHERE tenant_id = ? AND memory_id = ?"
      ).run("memory_cycle_b", "tenant_a", "memory_cycle_a");
    });

    expectConstraintFailure(() => {
      db.prepare(
        "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "tenant_a",
        "memory_tombstone_chronology_invalid",
        "scope_project",
        "working",
        "note",
        "tombstoned",
        "Tombstone Chronology Invalid",
        "{}",
        null,
        null,
        now,
        now,
        null,
        now + 1
      );
    });

    db.prepare("DELETE FROM tenants WHERE tenant_id = ?").run("tenant_a");
    assert.equal(countRowsByTenant(db, "tenants", "tenant_a"), 0);
    assert.equal(countRowsByTenant(db, "scopes", "tenant_a"), 0);
    assert.equal(countRowsByTenant(db, "memory_items", "tenant_a"), 0);
    assert.equal(countRows(db, "tenants"), 1);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.6: enterprise sqlite schema keeps FTS5 index in sync and query plans use virtual table index", async () => {
  const schema = await loadSchemaModule();
  const db = new DatabaseSync(":memory:");

  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(schema.enterpriseSqliteSchemaSql);

    const now = 1_700_000_000_001;
    db.prepare(
      "INSERT INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)"
    ).run("tenant_fts", "tenant-fts", "Tenant FTS", now, now);
    db.prepare(
      "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_fts",
      "scope_common_fts",
      "common",
      null,
      null,
      null,
      null,
      now
    );

    db.prepare(
      "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_fts",
      "memory_fts_1",
      "scope_common_fts",
      "working",
      "note",
      "active",
      "Alpha retrieval seed",
      '{"body":"contains beta keyword"}',
      null,
      null,
      now,
      now,
      null,
      null
    );

    const initialSearchRows = db
      .prepare(
        "SELECT tenant_id, memory_id FROM memory_items_fts WHERE memory_items_fts MATCH ? AND tenant_id = ?;"
      )
      .all("beta", "tenant_fts");
    assert.equal(initialSearchRows.length, 1);
    assert.equal(initialSearchRows[0].memory_id, "memory_fts_1");

    db.prepare(
      "UPDATE memory_items SET title = ?, payload_json = ? WHERE tenant_id = ? AND memory_id = ?;"
    ).run(
      "Gamma retrieval update",
      '{"body":"contains gamma keyword"}',
      "tenant_fts",
      "memory_fts_1"
    );
    const oldKeywordRows = db
      .prepare(
        "SELECT memory_id FROM memory_items_fts WHERE memory_items_fts MATCH ? AND tenant_id = ?;"
      )
      .all("beta", "tenant_fts");
    const newKeywordRows = db
      .prepare(
        "SELECT memory_id FROM memory_items_fts WHERE memory_items_fts MATCH ? AND tenant_id = ?;"
      )
      .all("gamma", "tenant_fts");
    assert.equal(oldKeywordRows.length, 0);
    assert.equal(newKeywordRows.length, 1);
    assert.equal(newKeywordRows[0].memory_id, "memory_fts_1");

    const queryPlanRows = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT memory_id FROM memory_items_fts WHERE memory_items_fts MATCH ? AND tenant_id = ? LIMIT 5;"
      )
      .all("gamma", "tenant_fts");
    const planDetails = queryPlanRows.map((row) => String(row.detail ?? ""));
    assert.ok(
      planDetails.some(
        (detail) =>
          /virtual table/i.test(detail) && /memory_items_fts/i.test(detail)
      )
    );

    db.prepare(
      "DELETE FROM memory_items WHERE tenant_id = ? AND memory_id = ?;"
    ).run("tenant_fts", "memory_fts_1");
    const deletedRows = db
      .prepare(
        "SELECT memory_id FROM memory_items_fts WHERE memory_items_fts MATCH ? AND tenant_id = ?;"
      )
      .all("gamma", "tenant_fts");
    assert.equal(deletedRows.length, 0);
  } finally {
    db.close();
  }
});
