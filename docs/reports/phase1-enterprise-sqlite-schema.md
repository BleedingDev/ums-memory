# Phase 1 Enterprise SQLite Schema (bead `ums-memory-5cb.1`)

Canonical schema definitions live in:

- `libs/shared/src/effect/storage/sqlite/enterprise-schema.ts`
- `libs/shared/src/effect/storage/sqlite/schema-metadata.ts`
- `libs/shared/src/effect/storage/sqlite/migrations.ts`

## Domain Coverage

The schema is normalized around tenant-bound entities:

1. `tenants`
2. `users`
3. `projects`
4. `roles`
5. `project_memberships`
6. `user_role_assignments`
7. `scopes`
8. `memory_items`
9. `evidence`
10. `memory_evidence_links`
11. `feedback`
12. `audit_events`
13. `storage_idempotency_ledger`

## Key Constraint Strategy

- Every domain table uses `STRICT` table mode.
- Tenant isolation is enforced with composite keys and tenant-prefixed foreign keys.
- Scope lattice constraints enforce exactly one level anchor per row (`common|project|job_role|user`).
- Memory payloads and evidence payloads require valid JSON via `json_valid(...)`.
- Feedback lifecycle is constrained (`open` rows cannot be resolved; resolved/dismissed rows require `resolved_at_ms`).
- Partial unique indexes enforce one common scope per tenant and one anchor per project/role/user scope.
- Audit events are append-only with immutable update/delete triggers.
- Storage idempotency ledger enforces deterministic replay by unique key + request-hash checks.

## Deterministic Export Contract

The module exports deterministic ordered metadata:

- `enterpriseSqliteTables`
- `enterpriseSqliteIndexes`
- `enterpriseSqliteSchemaStatements`
- `enterpriseSqliteSchemaSql`
- `enterpriseSqliteSchemaVersion`
- `enterpriseSqliteMigrations`
- `enterpriseSqliteLatestMigrationVersion`

Ordering is validated by:

- `tests/unit/enterprise-sqlite-schema-definition.test.ts`
- `tests/unit/enterprise-sqlite-migrations.test.ts`

## Follow-On Runbook

For the Phase 7 scale path from SQLite to Postgres, see:
[SQLite to Postgres Migration Strategy](../runbooks/sqlite-to-postgres-migration-strategy.md).
