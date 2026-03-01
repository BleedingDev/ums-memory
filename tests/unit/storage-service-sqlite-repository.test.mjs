import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import ts from "typescript";

const effectModuleDirectory = new URL("../../libs/shared/src/effect/", import.meta.url);

const transpileEffectModule = (sourceFilename, tempDirectory) => {
  const sourceFileUrl = new URL(sourceFilename, effectModuleDirectory);
  const source = readFileSync(sourceFileUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: sourceFileUrl.pathname,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    const diagnosticMessage = diagnostics
      .map((diagnostic) => {
        const messageText = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        const position =
          diagnostic.file === undefined || diagnostic.start === undefined
            ? sourceFilename
            : `${sourceFilename}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
        return `${position} - ${messageText}`;
      })
      .join("\n");
    throw new Error(`TypeScript transpile diagnostics for ${sourceFilename}:\n${diagnosticMessage}`);
  }

  const outputFilename = join(tempDirectory, sourceFilename.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(outputFilename), { recursive: true });
  writeFileSync(outputFilename, transpiled.outputText, "utf8");
};

const transpileManifest = Object.freeze([
  "contracts/ids.ts",
  "contracts/domains.ts",
  "contracts/services.ts",
  "contracts/index.ts",
  "errors.ts",
  "storage/sqlite/schema-metadata.ts",
  "storage/sqlite/enterprise-schema.ts",
  "storage/sqlite/migrations.ts",
  "storage/sqlite/storage-repository.ts",
  "storage/sqlite/index.ts",
  "services/storage-service.ts",
]);

let storageServiceModulePromise;
let transpiledDirectoryPath;

const loadStorageServiceModule = async () => {
  if (!storageServiceModulePromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(join(tempRootDirectory, "ums-memory-storage-sqlite-"));

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const storageServiceModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/storage-service.js"),
    ).href;
    storageServiceModulePromise = import(storageServiceModuleUrl);
  }

  return storageServiceModulePromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

const unwrapFailure = (eitherResult) => {
  assert.equal(eitherResult?._tag, "Left");
  return eitherResult.left;
};

const seedScopeLatticeAnchors = (
  db,
  tenantId,
  {
    projectIds = [],
    roleIds = [],
    userIds = [],
  } = {},
) => {
  const now = 1_700_000_000_000;
  db.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?);",
  ).run(tenantId, tenantId, tenantId, now, now);

  for (const userId of userIds) {
    db.prepare(
      "INSERT OR IGNORE INTO users (tenant_id, user_id, email, display_name, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);",
    ).run(tenantId, userId, `${userId}@example.com`, userId, "active", now, now);
  }

  for (const projectId of projectIds) {
    db.prepare(
      "INSERT OR IGNORE INTO projects (tenant_id, project_id, project_key, display_name, status, created_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);",
    ).run(tenantId, projectId, `KEY_${projectId}`, projectId, "active", now, null);
  }

  for (const roleId of roleIds) {
    db.prepare(
      "INSERT OR IGNORE INTO roles (tenant_id, role_id, role_code, display_name, role_type, created_at_ms) VALUES (?, ?, ?, ?, ?, ?);",
    ).run(tenantId, roleId, `ROLE_${roleId}`, roleId, "project", now);
  }
};

test("ums-memory-5cb.4: sqlite storage service resolves common/project/job_role/user scopes when scopeId is omitted", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-lattice";
    const projectId = "project-alpha";
    const roleId = "role-editor";
    const userId = "user-learner";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-common",
        layer: "working",
        payload: {
          title: "Common fallback write",
          updatedAtMillis: 1_700_000_000_001,
        },
      }),
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-project",
        layer: "working",
        payload: {
          title: "Project anchored write",
          scope: {
            projectId,
          },
          updatedAtMillis: 1_700_000_000_002,
        },
      }),
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-role",
        layer: "working",
        payload: {
          title: "Role anchored write",
          scope: {
            roleId,
          },
          updatedAtMillis: 1_700_000_000_003,
        },
      }),
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-user",
        layer: "working",
        payload: {
          title: "User anchored write",
          scope: {
            userId,
          },
          updatedAtMillis: 1_700_000_000_004,
        },
      }),
    );

    const persistedScopeRows = db
      .prepare(
        "SELECT memory_id, scope_id FROM memory_items WHERE tenant_id = ? ORDER BY memory_id ASC;",
      )
      .all(tenantId);
    const scopeIdByMemoryId = new Map(
      persistedScopeRows.map((row) => [row.memory_id, row.scope_id]),
    );
    assert.equal(scopeIdByMemoryId.get("memory-common"), `common:${tenantId}`);
    assert.equal(scopeIdByMemoryId.get("memory-project"), `project:${tenantId}:${projectId}`);
    assert.equal(scopeIdByMemoryId.get("memory-role"), `job_role:${tenantId}:${roleId}`);
    assert.equal(scopeIdByMemoryId.get("memory-user"), `user:${tenantId}:${userId}`);

    const commonScopeRow = db
      .prepare(
        "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'common';",
      )
      .get(tenantId);
    const projectScopeRow = db
      .prepare(
        "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'project' AND project_id = ?;",
      )
      .get(tenantId, projectId);
    const roleScopeRow = db
      .prepare(
        "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'job_role' AND role_id = ?;",
      )
      .get(tenantId, roleId);
    const userScopeRow = db
      .prepare(
        "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'user' AND user_id = ?;",
      )
      .get(tenantId, userId);

    assert.ok(commonScopeRow);
    assert.ok(projectScopeRow);
    assert.ok(roleScopeRow);
    assert.ok(userScopeRow);
    assert.equal(commonScopeRow.scope_id, `common:${tenantId}`);
    assert.equal(commonScopeRow.parent_scope_id, null);
    assert.equal(projectScopeRow.parent_scope_id, commonScopeRow.scope_id);
    assert.equal(roleScopeRow.parent_scope_id, commonScopeRow.scope_id);
    assert.equal(userScopeRow.parent_scope_id, commonScopeRow.scope_id);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: sqlite storage service applies deterministic precedence and stable scope reuse", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-precedence";
    const projectId = "project-saturn";
    const roleId = "role-mentor";
    const userId = "user-priority";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-user-priority",
        layer: "working",
        payload: {
          title: "User wins over role and project",
          scope: {
            userId,
            roleId,
            projectId,
          },
          updatedAtMillis: 1_700_000_000_101,
        },
      }),
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-user-replay",
        layer: "working",
        payload: {
          title: "Replay with user-only anchor must reuse existing user scope",
          scope: {
            userId,
          },
          updatedAtMillis: 1_700_000_000_102,
        },
      }),
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-role-priority",
        layer: "working",
        payload: {
          title: "Role wins over project",
          scope: {
            roleId,
            projectId,
          },
          updatedAtMillis: 1_700_000_000_103,
        },
      }),
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-project-priority",
        layer: "working",
        payload: {
          title: "Project wins over common",
          scope: {
            projectId,
          },
          updatedAtMillis: 1_700_000_000_104,
        },
      }),
    );

    const scopeIdRows = db
      .prepare("SELECT memory_id, scope_id FROM memory_items WHERE tenant_id = ? ORDER BY memory_id ASC;")
      .all(tenantId);
    const scopeIdByMemoryId = new Map(scopeIdRows.map((row) => [row.memory_id, row.scope_id]));
    assert.equal(scopeIdByMemoryId.get("memory-user-priority"), `user:${tenantId}:${userId}`);
    assert.equal(scopeIdByMemoryId.get("memory-user-replay"), `user:${tenantId}:${userId}`);
    assert.equal(scopeIdByMemoryId.get("memory-role-priority"), `job_role:${tenantId}:${roleId}`);
    assert.equal(scopeIdByMemoryId.get("memory-project-priority"), `project:${tenantId}:${projectId}`);

    const userScopeRow = db
      .prepare(
        "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'user' AND user_id = ?;",
      )
      .get(tenantId, userId);
    assert.ok(userScopeRow);
    assert.equal(userScopeRow.scope_id, `user:${tenantId}:${userId}`);
    assert.equal(userScopeRow.parent_scope_id, `job_role:${tenantId}:${roleId}`);

    const scopeCountRows = db
      .prepare(
        "SELECT scope_level, COUNT(*) AS row_count FROM scopes WHERE tenant_id = ? GROUP BY scope_level ORDER BY scope_level ASC;",
      )
      .all(tenantId);
    const rowCountByScopeLevel = new Map(
      scopeCountRows.map((row) => [row.scope_level, Number(row.row_count)]),
    );
    assert.equal(rowCountByScopeLevel.get("common"), 1);
    assert.equal(rowCountByScopeLevel.get("project"), 1);
    assert.equal(rowCountByScopeLevel.get("job_role"), 1);
    assert.equal(rowCountByScopeLevel.get("user"), 1);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: createdByUserId remains audit-only and does not select scope", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-metadata";
    const projectId = "project-meta";
    const roleId = "role-meta";
    const userId = "user-meta";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-metadata-opaque",
        layer: "working",
        payload: {
          title: "createdByUserId should not select scope",
          projectHint: projectId,
          roleHint: roleId,
          userHint: userId,
          createdByUserId: userId,
          updatedAtMillis: 1_700_000_000_150,
        },
      }),
    );

    const persistedRow = db
      .prepare(
        "SELECT scope_id, created_by_user_id FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
      )
      .get(tenantId, "memory-metadata-opaque");
    assert.ok(persistedRow);
    assert.equal(persistedRow.scope_id, `common:${tenantId}`);
    assert.equal(persistedRow.created_by_user_id, userId);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: conflicting user parent anchors fail deterministically", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-conflict";
    const projectId = "project-conflict";
    const roleId = "role-conflict";
    const userId = "user-conflict";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-user-role-parent",
        layer: "working",
        payload: {
          title: "Creates user scope with role parent",
          scope: {
            userId,
            roleId,
          },
          updatedAtMillis: 1_700_000_000_160,
        },
      }),
    );

    const conflictEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: tenantId,
          memoryId: "memory-user-project-parent",
          layer: "working",
          payload: {
            title: "Conflicting parent anchor",
            scope: {
              userId,
              projectId,
            },
            updatedAtMillis: 1_700_000_000_161,
          },
        }),
      ),
    );
    const conflictFailure = unwrapFailure(conflictEither);

    assert.equal(conflictFailure._tag, "ContractValidationError");
    assert.equal(conflictFailure.contract, "StorageUpsertRequest.payload");
    assert.match(conflictFailure.details, /anchors conflict/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: accepts legacy root scopeId when payload.scope is absent", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-legacy";
    const commonScopeId = `common:${tenantId}`;

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-bootstrap-common",
        layer: "working",
        payload: {
          title: "Bootstrap common scope",
          updatedAtMillis: 1_700_000_000_169,
        },
      }),
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-legacy-root-scope-id",
        layer: "working",
        payload: {
          title: "Legacy root scope key stays supported",
          scopeId: commonScopeId,
          updatedAtMillis: 1_700_000_000_170,
        },
      }),
    );

    const persistedRow = db
      .prepare("SELECT scope_id FROM memory_items WHERE tenant_id = ? AND memory_id = ?;")
      .get(tenantId, "memory-legacy-root-scope-id");
    assert.ok(persistedRow);
    assert.equal(persistedRow.scope_id, commonScopeId);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: rejects invalid payload.scope shapes and mixed legacy controls", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const invalidRequests = [
      {
        memoryId: "memory-scope-mixed-legacy",
        payload: {
          title: "Legacy root scope key cannot mix with payload.scope controls",
          scopeId: "common:tenant-scope-shape",
          scope: {
            userId: "user-shape",
          },
          updatedAtMillis: 1_700_000_000_170,
        },
      },
      {
        memoryId: "memory-scope-null",
        payload: {
          title: "Invalid null scope",
          scope: null,
          updatedAtMillis: 1_700_000_000_171,
        },
      },
      {
        memoryId: "memory-scope-array",
        payload: {
          title: "Invalid array scope",
          scope: [],
          updatedAtMillis: 1_700_000_000_172,
        },
      },
      {
        memoryId: "memory-scope-string",
        payload: {
          title: "Invalid string scope",
          scope: "invalid",
          updatedAtMillis: 1_700_000_000_173,
        },
      },
    ];

    for (const invalidRequest of invalidRequests) {
      const upsertEither = Effect.runSync(
        Effect.either(
          storageService.upsertMemory({
            spaceId: "tenant-scope-shape",
            memoryId: invalidRequest.memoryId,
            layer: "working",
            payload: invalidRequest.payload,
          }),
        ),
      );
      const upsertFailure = unwrapFailure(upsertEither);

      assert.equal(upsertFailure._tag, "ContractValidationError");
      assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
      assert.match(upsertFailure.details, /payload\.scope|cannot be combined/i);
    }
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: rejects unknown project/role/user scope anchors with contract validation errors", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const invalidAnchoredRequests = [
      {
        memoryId: "memory-project-anchor-missing",
        payload: {
          title: "Project anchor must exist",
          scope: {
            projectId: "project-missing",
          },
          updatedAtMillis: 1_700_000_000_180,
        },
        expectedAnchor: "project",
      },
      {
        memoryId: "memory-role-anchor-missing",
        payload: {
          title: "Role anchor must exist",
          scope: {
            roleId: "role-missing",
          },
          updatedAtMillis: 1_700_000_000_181,
        },
        expectedAnchor: "role",
      },
      {
        memoryId: "memory-user-anchor-missing",
        payload: {
          title: "User anchor must exist",
          scope: {
            userId: "user-missing",
          },
          updatedAtMillis: 1_700_000_000_182,
        },
        expectedAnchor: "user",
      },
    ];

    for (const requestUnderTest of invalidAnchoredRequests) {
      const upsertEither = Effect.runSync(
        Effect.either(
          storageService.upsertMemory({
            spaceId: "tenant-missing-anchors",
            memoryId: requestUnderTest.memoryId,
            layer: "working",
            payload: requestUnderTest.payload,
          }),
        ),
      );
      const upsertFailure = unwrapFailure(upsertEither);

      assert.equal(upsertFailure._tag, "ContractValidationError");
      assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
      assert.match(upsertFailure.details, new RegExp(`unknown tenant ${requestUnderTest.expectedAnchor} anchor`, "i"));
    }
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: rejects mixed explicit scopeId and scope anchors", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-scope-mixed",
          memoryId: "memory-mixed-scope-controls",
          layer: "working",
          payload: {
            title: "Invalid mixed scope controls",
            scope: {
              scopeId: "user:tenant-scope-mixed:user-a",
              userId: "user-a",
            },
            updatedAtMillis: 1_700_000_000_174,
          },
        }),
      ),
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(upsertFailure.details, /cannot be combined/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service upsert maps payload deterministically and delete succeeds", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const firstResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          updatedAtMillis: 1_700_000_000_200,
          title: "Deterministic Storage Item",
          memoryKind: "summary",
          nested: {
            zed: 3,
            alpha: 1,
          },
          createdAtMillis: 1_700_000_000_100,
          tags: ["alpha", "beta"],
        },
      }),
    );
    assert.equal(firstResponse.spaceId, "tenant-storage");
    assert.equal(firstResponse.memoryId, "memory-a");
    assert.equal(firstResponse.accepted, true);
    assert.equal(firstResponse.persistedAtMillis, 1_700_000_000_200);
    assert.equal(firstResponse.version, 1);

    const initialPersistedRow = db
      .prepare(
        [
          "SELECT",
          "  tenant_id,",
          "  memory_id,",
          "  scope_id,",
          "  memory_layer,",
          "  memory_kind,",
          "  status,",
          "  title,",
          "  payload_json,",
          "  created_at_ms,",
          "  updated_at_ms,",
          "  tombstoned_at_ms",
          "FROM memory_items",
          "WHERE tenant_id = ? AND memory_id = ?;",
        ].join("\n"),
      )
      .get("tenant-storage", "memory-a");

    assert.ok(initialPersistedRow);
    assert.equal(initialPersistedRow.scope_id, "common:tenant-storage");
    assert.equal(initialPersistedRow.memory_layer, "working");
    assert.equal(initialPersistedRow.memory_kind, "summary");
    assert.equal(initialPersistedRow.status, "active");
    assert.equal(initialPersistedRow.title, "Deterministic Storage Item");
    assert.equal(initialPersistedRow.created_at_ms, 1_700_000_000_100);
    assert.equal(initialPersistedRow.updated_at_ms, 1_700_000_000_200);
    assert.equal(initialPersistedRow.tombstoned_at_ms, null);
    assert.equal(
      initialPersistedRow.payload_json,
      '{"createdAtMillis":1700000000100,"memoryKind":"summary","nested":{"alpha":1,"zed":3},"tags":["alpha","beta"],"title":"Deterministic Storage Item","updatedAtMillis":1700000000200}',
    );

    const secondResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          title: "Deterministic Storage Item (tombstoned)",
          status: "tombstoned",
          createdAtMillis: 1_700_000_000_100,
          updatedAtMillis: 1_700_000_000_400,
          tombstonedAtMillis: 1_700_000_000_350,
        },
      }),
    );

    assert.equal(secondResponse.accepted, true);
    assert.equal(secondResponse.persistedAtMillis, 1_700_000_000_400);
    assert.equal(secondResponse.version, 1);

    const staleReplayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          title: "Stale Replay Should Not Override",
          status: "active",
          createdAtMillis: 1_700_000_000_100,
          updatedAtMillis: 1_700_000_000_300,
        },
      }),
    );

    assert.equal(staleReplayResponse.accepted, true);
    assert.equal(staleReplayResponse.persistedAtMillis, 1_700_000_000_400);
    assert.equal(staleReplayResponse.version, 1);

    const equalTimestampReplayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          title: "Equal Timestamp Replay Should Not Override",
          status: "active",
          createdAtMillis: 1_700_000_000_100,
          updatedAtMillis: 1_700_000_000_400,
        },
      }),
    );

    assert.equal(equalTimestampReplayResponse.accepted, true);
    assert.equal(equalTimestampReplayResponse.persistedAtMillis, 1_700_000_000_400);
    assert.equal(equalTimestampReplayResponse.version, 1);

    const rowCountAfterUpsert = db
      .prepare("SELECT COUNT(*) AS row_count FROM memory_items WHERE tenant_id = ? AND memory_id = ?;")
      .get("tenant-storage", "memory-a");
    assert.equal(rowCountAfterUpsert.row_count, 1);

    const tombstonedRow = db
      .prepare(
        "SELECT status, title, updated_at_ms, tombstoned_at_ms FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
      )
      .get("tenant-storage", "memory-a");

    assert.ok(tombstonedRow);
    assert.equal(tombstonedRow.status, "tombstoned");
    assert.equal(tombstonedRow.title, "Deterministic Storage Item (tombstoned)");
    assert.equal(tombstonedRow.updated_at_ms, 1_700_000_000_400);
    assert.equal(tombstonedRow.tombstoned_at_ms, 1_700_000_000_350);

    const persistedPayloadRow = db
      .prepare("SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;")
      .get("tenant-storage", "memory-a");
    assert.ok(persistedPayloadRow);
    assert.equal(
      persistedPayloadRow.payload_json,
      '{"createdAtMillis":1700000000100,"status":"tombstoned","title":"Deterministic Storage Item (tombstoned)","tombstonedAtMillis":1700000000350,"updatedAtMillis":1700000000400}',
    );

    const deleteResponse = Effect.runSync(
      storageService.deleteMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
      }),
    );
    assert.deepEqual(deleteResponse, {
      spaceId: "tenant-storage",
      memoryId: "memory-a",
      deleted: true,
    });

    const rowCountAfterDelete = db
      .prepare("SELECT COUNT(*) AS row_count FROM memory_items WHERE tenant_id = ? AND memory_id = ?;")
      .get("tenant-storage", "memory-a");
    assert.equal(rowCountAfterDelete.row_count, 0);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps missing deletes to StorageNotFoundError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const deleteEither = Effect.runSync(
      Effect.either(
        storageService.deleteMemory({
          spaceId: "tenant-storage",
          memoryId: "unknown-memory",
        }),
      ),
    );
    const deleteFailure = unwrapFailure(deleteEither);

    assert.equal(deleteFailure._tag, "StorageNotFoundError");
    assert.equal(deleteFailure.spaceId, "tenant-storage");
    assert.equal(deleteFailure.memoryId, "unknown-memory");
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps sqlite constraint failures to StorageConflictError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-storage",
          memoryId: "memory-conflict",
          layer: "working",
          payload: {
            title: "Scope FK conflict",
            scope: {
              scopeId: "scope-missing",
            },
          },
        }),
      ),
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "StorageConflictError");
    assert.equal(upsertFailure.spaceId, "tenant-storage");
    assert.equal(upsertFailure.memoryId, "memory-conflict");
    assert.match(upsertFailure.message, /constraint|foreign key/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps trigger aborts to StorageConflictError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-cycle-a",
        layer: "working",
        payload: {
          title: "Cycle A",
          createdAtMillis: 100,
          updatedAtMillis: 100,
        },
      }),
    );

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-cycle-b",
        layer: "working",
        payload: {
          title: "Cycle B",
          supersedesMemoryId: "memory-cycle-a",
          createdAtMillis: 110,
          updatedAtMillis: 110,
        },
      }),
    );

    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-storage",
          memoryId: "memory-cycle-a",
          layer: "working",
          payload: {
            title: "Cycle A should fail",
            supersedesMemoryId: "memory-cycle-b",
            createdAtMillis: 100,
            updatedAtMillis: 120,
          },
        }),
      ),
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "StorageConflictError");
    assert.equal(upsertFailure.spaceId, "tenant-storage");
    assert.equal(upsertFailure.memoryId, "memory-cycle-a");
    assert.match(upsertFailure.message, /constraint|abort|cycle/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps payload validation failures to ContractValidationError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-storage",
          memoryId: "memory-validation",
          layer: "working",
          payload: {
            title: "Invalid payload ordering",
            createdAtMillis: 2_000,
            updatedAtMillis: 1_000,
          },
        }),
      ),
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(upsertFailure.details, /updatedAtMillis/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service rejects non-plain-object payload values", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-storage",
          memoryId: "memory-invalid-object",
          layer: "working",
          payload: {
            title: "Invalid runtime object payload",
            nested: new Date(0),
          },
        }),
      ),
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(upsertFailure.details, /plain JSON-compatible objects/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service rejects non-record root payload values", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const invalidPayloads = [null, [], "invalid-root"];

    for (const invalidPayload of invalidPayloads) {
      const upsertEither = Effect.runSync(
        Effect.either(
          storageService.upsertMemory({
            spaceId: "tenant-storage",
            memoryId: `memory-invalid-root-${String(invalidPayload)}`,
            layer: "working",
            payload: invalidPayload,
          }),
        ),
      );
      const upsertFailure = unwrapFailure(upsertEither);

      assert.equal(upsertFailure._tag, "ContractValidationError");
      assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
      assert.match(upsertFailure.details, /plain object record/i);
    }
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps non-constraint runtime failures to ContractValidationError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");
  const storageService = storageServiceModule.makeSqliteStorageService(db);

  db.close();

  const upsertEither = Effect.runSync(
    Effect.either(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-runtime-failure",
        layer: "working",
        payload: {
          title: "Runtime failure",
          updatedAtMillis: 9_000,
        },
      }),
    ),
  );
  const upsertFailure = unwrapFailure(upsertEither);

  assert.equal(upsertFailure._tag, "ContractValidationError");
  assert.equal(upsertFailure.contract, "StorageRuntimeFailure");
});

test("ums-memory-5cb.3: sqlite storage layer provides StorageServiceTag wiring", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const response = Effect.runSync(
      Effect.gen(function* () {
        const storageService = yield* storageServiceModule.StorageServiceTag;
        return yield* storageService.upsertMemory({
          spaceId: "tenant-layer",
          memoryId: "memory-layer",
          layer: "working",
          payload: {
            title: "Layer-wired upsert",
            updatedAtMillis: 2_000,
          },
        });
      }).pipe(Effect.provide(storageServiceModule.makeSqliteStorageLayer(db))),
    );

    assert.equal(response.accepted, true);
    assert.equal(response.persistedAtMillis, 2_000);
    assert.equal(response.memoryId, "memory-layer");
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository options allow explicit migration/fk modes", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");
  const fkDisabledDb = new DatabaseSync(":memory:");

  try {
    const bootstrapService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      bootstrapService.upsertMemory({
        spaceId: "tenant-options",
        memoryId: "memory-bootstrap",
        layer: "working",
        payload: {
          title: "Bootstrap",
          updatedAtMillis: 1_000,
        },
      }),
    );

    const noMigrationService = storageServiceModule.makeSqliteStorageService(db, {
      applyMigrations: false,
    });
    const noMigrationResponse = Effect.runSync(
      noMigrationService.upsertMemory({
        spaceId: "tenant-options",
        memoryId: "memory-no-migration",
        layer: "working",
        payload: {
          title: "No migration option path",
          updatedAtMillis: 1_100,
        },
      }),
    );
    assert.equal(noMigrationResponse.accepted, true);
    assert.equal(noMigrationResponse.persistedAtMillis, 1_100);

    const foreignKeysDisabledService = storageServiceModule.makeSqliteStorageService(fkDisabledDb, {
      enforceForeignKeys: false,
    });
    const fkDisabledResponse = Effect.runSync(
      foreignKeysDisabledService.upsertMemory({
        spaceId: "tenant-options",
        memoryId: "memory-fk-off",
        layer: "working",
        payload: {
          scope: {
            scopeId: "scope-not-created",
          },
          title: "Foreign key disabled option path",
          updatedAtMillis: 1_200,
        },
      }),
    );
    assert.equal(fkDisabledResponse.accepted, true);
    assert.equal(fkDisabledResponse.persistedAtMillis, 1_200);
  } finally {
    db.close();
    fkDisabledDb.close();
  }
});

test("ums-memory-5cb.3: sqlite storage layer maps initialization failures to ContractValidationError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const program = Effect.gen(function* () {
      const storageService = yield* storageServiceModule.StorageServiceTag;
      return yield* storageService.upsertMemory({
        spaceId: "tenant-layer-failure",
        memoryId: "memory-layer-failure",
        layer: "working",
        payload: {
          title: "This call should never execute",
        },
      });
    }).pipe(Effect.provide(storageServiceModule.makeSqliteStorageLayer(db, { applyMigrations: false })));

    const result = Effect.runSync(Effect.either(program));
    const failure = unwrapFailure(result);
    assert.equal(failure._tag, "ContractValidationError");
    assert.equal(failure.contract, "StorageServiceInitialization");
    assert.match(failure.details, /no such table/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository rejects conflicting foreign key mode on shared connection", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    storageServiceModule.makeSqliteStorageService(db, { enforceForeignKeys: true });

    assert.throws(
      () =>
        storageServiceModule.makeSqliteStorageService(db, {
          enforceForeignKeys: false,
        }),
      /immutable|foreign_keys/i,
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository honors PRAGMA foreign_keys with readBigInts mode", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:", { readBigInts: true });

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });
    const response = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-bigint",
        memoryId: "memory-bigint",
        layer: "working",
        payload: {
          title: "BigInt PRAGMA compatibility",
          updatedAtMillis: 5_000,
        },
      }),
    );

    assert.equal(response.accepted, true);
    assert.equal(response.persistedAtMillis, 5_000);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository re-applies foreign key enforcement after external PRAGMA drift", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });

    db.exec("PRAGMA foreign_keys = OFF;");

    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      applyMigrations: false,
      enforceForeignKeys: true,
    });

    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-drift",
          memoryId: "memory-drift",
          layer: "working",
          payload: {
            scope: {
              scopeId: "scope-not-created",
            },
            title: "Foreign key should be re-enforced",
            updatedAtMillis: 8_000,
          },
        }),
      ),
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "StorageConflictError");
    assert.match(upsertFailure.message, /constraint|foreign key/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository detects foreign key drift on live service instances", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });
    db.exec("PRAGMA foreign_keys = OFF;");

    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-drift-live",
          memoryId: "memory-drift-live",
          layer: "working",
          payload: {
            scope: {
              scopeId: "scope-not-created",
            },
            title: "Live service drift check",
            updatedAtMillis: 10_000,
          },
        }),
      ),
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "SqliteStorageRepositoryOptions.enforceForeignKeys");
    assert.match(upsertFailure.message, /drift detected/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository preserves drift contract error on delete path", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-drift-delete",
        memoryId: "memory-drift-delete",
        layer: "working",
        payload: {
          title: "Delete drift fixture",
          updatedAtMillis: 11_000,
        },
      }),
    );

    db.exec("PRAGMA foreign_keys = OFF;");

    const deleteEither = Effect.runSync(
      Effect.either(
        storageService.deleteMemory({
          spaceId: "tenant-drift-delete",
          memoryId: "memory-drift-delete",
        }),
      ),
    );
    const deleteFailure = unwrapFailure(deleteEither);

    assert.equal(deleteFailure._tag, "ContractValidationError");
    assert.equal(deleteFailure.contract, "SqliteStorageRepositoryOptions.enforceForeignKeys");
    assert.match(deleteFailure.message, /drift detected/i);
  } finally {
    db.close();
  }
});
