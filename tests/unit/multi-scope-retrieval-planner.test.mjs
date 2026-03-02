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
  "contracts/validators.ts",
  "contracts/index.ts",
  "errors.ts",
  "storage/sqlite/schema-metadata.ts",
  "storage/sqlite/enterprise-schema.ts",
  "storage/sqlite/migrations.ts",
  "storage/sqlite/snapshot-codec.ts",
  "storage/sqlite/storage-repository.ts",
  "storage/sqlite/index.ts",
  "services/policy-service.ts",
  "services/storage-service.ts",
  "services/retrieval-service.ts",
]);

let modulesPromise;
let transpiledDirectoryPath;

const loadModules = async () => {
  if (!modulesPromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(join(tempRootDirectory, "ums-memory-retrieval-planner-"));

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const retrievalServiceModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/retrieval-service.js"),
    ).href;
    const storageServiceModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/storage-service.js"),
    ).href;

    modulesPromise = Promise.all([
      import(retrievalServiceModuleUrl),
      import(storageServiceModuleUrl),
    ]).then(([retrievalServiceModule, storageServiceModule]) => ({
      retrievalServiceModule,
      storageServiceModule,
    }));
  }

  return modulesPromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

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

const upsertMemorySync = (storageService, request) => {
  Effect.runSync(storageService.upsertMemory(request));
};

const makePolicyService = ({ denyMemoryIds = new Set(), calls = [] } = {}) => ({
  evaluate: (request) => {
    calls.push(request);
    const denied = denyMemoryIds.has(request.resourceId);
    return Effect.succeed({
      decision: denied ? "deny" : "allow",
      reasonCodes: denied ? ["DENIED_BY_TEST_POLICY"] : ["ALLOWED_BY_TEST_POLICY"],
      evaluatedAtMillis: 0,
    });
  },
});

const actionablePackTestTokenBudget = 260;
const actionablePackTestPerCategoryLimit = 2;
const actionablePackTestSourceLimit = 6;
const actionablePackCategories = Object.freeze(["do", "dont", "examples", "risks"]);

const estimateTokenCount = (value) => {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return 0;
  }
  return normalized.split(" ").length;
};

const estimateActionablePackTokens = (actionablePack) => {
  let tokenCount = 0;
  for (const category of actionablePackCategories) {
    for (const line of actionablePack[category]) {
      tokenCount += estimateTokenCount(line);
    }
  }
  for (const source of actionablePack.sources) {
    tokenCount += estimateTokenCount(source.memoryId);
    tokenCount += estimateTokenCount(source.excerpt);
    tokenCount += estimateTokenCount(source.metadata.layer);
    tokenCount += 1;
  }
  for (const warning of actionablePack.warnings) {
    tokenCount += estimateTokenCount(warning);
  }
  return tokenCount;
};

const roundRetrievalScore = (value) => Math.min(1, Math.max(0, Math.round(value * 1_000_000) / 1_000_000));

test("ums-memory-8as.2: retrieval planner merges common/project/job_role/user scopes deterministically", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-scope-merge";
    const projectId = "project-orbit";
    const roleId = "role-mentor";
    const userId = "user-student";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-common",
      layer: "working",
      payload: {
        title: "merge token common",
        updatedAtMillis: 100,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-project",
      layer: "working",
      payload: {
        title: "merge token project",
        scope: { projectId },
        updatedAtMillis: 100,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-role",
      layer: "working",
      payload: {
        title: "merge token role",
        scope: { roleId },
        updatedAtMillis: 100,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-user",
      layer: "working",
      payload: {
        title: "merge token user",
        scope: { userId, roleId },
        updatedAtMillis: 100,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );

    const response = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "merge token",
        limit: 10,
        scope: { projectId, roleId, userId },
      }),
    );
    const responseWithoutSelectors = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "merge token",
        limit: 10,
      }),
    );

    assert.equal(response.totalHits, 4);
    assert.deepEqual(
      response.hits.map((hit) => hit.memoryId),
      ["memory-user", "memory-role", "memory-project", "memory-common"],
    );
    assert.equal(response.nextCursor, null);
    assert.equal(responseWithoutSelectors.totalHits, 4);
    assert.deepEqual(
      responseWithoutSelectors.hits.map((hit) => hit.memoryId),
      ["memory-user", "memory-role", "memory-project", "memory-common"],
    );
  } finally {
    db.close();
  }
});

test("ums-memory-8as.2: retrieval planner filters denied policy decisions", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-policy-filter";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-allowed",
      layer: "working",
      payload: {
        title: "policy token allowed",
        updatedAtMillis: 10,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-denied",
      layer: "working",
      payload: {
        title: "policy token denied",
        updatedAtMillis: 10,
      },
    });

    const policyCalls = [];
    const retrievalService = retrievalServiceModule.makeRetrievalService(storageService, {
      evaluate: (request) => {
        policyCalls.push(request);
        return Effect.succeed({
          decision: request.resourceId === "memory-denied" ? "deny" : "allow",
          reasonCodes: ["TEST_POLICY"],
          evaluatedAtMillis: 0,
        });
      },
    });

    const response = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "policy token",
        limit: 10,
        policy: {
          actorId: "user-policy",
          action: "memory.retrieve",
          evidenceIds: ["evidence-policy-1"],
          context: {
            requestId: "req-policy-1",
          },
        },
      }),
    );

    assert.equal(response.totalHits, 1);
    assert.deepEqual(response.hits.map((hit) => hit.memoryId), ["memory-allowed"]);
    assert.equal(policyCalls.length, 2);
    assert.ok(policyCalls.every((call) => call.actorId === "user-policy"));
    assert.ok(policyCalls.every((call) => call.action === "memory.retrieve"));
  } finally {
    db.close();
  }
});

test("ums-memory-8as.2: retrieval planner cursor pagination is deterministic", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-cursor";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    for (let index = 1; index <= 5; index += 1) {
      upsertMemorySync(storageService, {
        spaceId: tenantId,
        memoryId: `memory-${index}`,
        layer: "working",
        payload: {
          title: `cursor token ${index}`,
          updatedAtMillis: 200,
        },
      });
    }

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );

    const firstPageRequest = {
      spaceId: tenantId,
      query: "cursor token",
      limit: 2,
    };

    const firstPage = await Effect.runPromise(retrievalService.retrieve(firstPageRequest));
    const firstPageReplay = await Effect.runPromise(retrievalService.retrieve(firstPageRequest));
    assert.deepEqual(firstPage.hits, firstPageReplay.hits);
    assert.equal(firstPage.nextCursor, firstPageReplay.nextCursor);
    assert.equal(firstPage.totalHits, 5);
    assert.deepEqual(
      firstPage.hits.map((hit) => hit.memoryId),
      ["memory-1", "memory-2"],
    );
    assert.ok(firstPage.nextCursor);

    const secondPage = await Effect.runPromise(
      retrievalService.retrieve({
        ...firstPageRequest,
        cursor: firstPage.nextCursor,
      }),
    );
    assert.deepEqual(
      secondPage.hits.map((hit) => hit.memoryId),
      ["memory-3", "memory-4"],
    );
    assert.ok(secondPage.nextCursor);

    const thirdPage = await Effect.runPromise(
      retrievalService.retrieve({
        ...firstPageRequest,
        cursor: secondPage.nextCursor,
      }),
    );
    assert.deepEqual(thirdPage.hits.map((hit) => hit.memoryId), ["memory-5"]);
    assert.equal(thirdPage.nextCursor, null);
  } finally {
    db.close();
  }
});

test("ums-memory-8as.2: cursor is rejected when policy context changes", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-cursor-policy";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    for (let index = 1; index <= 3; index += 1) {
      upsertMemorySync(storageService, {
        spaceId: tenantId,
        memoryId: `memory-policy-${index}`,
        layer: "working",
        payload: {
          title: `policy cursor token ${index}`,
          updatedAtMillis: 50,
        },
      });
    }

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const firstPage = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "policy cursor token",
        limit: 1,
        policy: {
          actorId: "actor-a",
          evidenceIds: ["evidence-a"],
          context: { requestId: "req-a" },
        },
      }),
    );
    assert.ok(firstPage.nextCursor);

    await assert.rejects(
      Effect.runPromise(
        retrievalService.retrieve({
          spaceId: tenantId,
          query: "policy cursor token",
          limit: 1,
          cursor: firstPage.nextCursor,
          policy: {
            actorId: "actor-b",
            evidenceIds: ["evidence-b"],
            context: { requestId: "req-b" },
          },
        }),
      ),
      (error) => {
        const errorMessage =
          typeof error?.message === "string" && error.message.length > 0
            ? error.message
            : String(error);
        assert.match(errorMessage, /digest/i);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("ums-memory-8as.3: cursor is rejected when ranking weights change", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-cursor-ranking";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    for (let index = 1; index <= 3; index += 1) {
      upsertMemorySync(storageService, {
        spaceId: tenantId,
        memoryId: `memory-ranking-${index}`,
        layer: "working",
        payload: {
          title: `ranking cursor token ${index}`,
          updatedAtMillis: 200 + index,
        },
      });
    }

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const firstPage = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "ranking cursor token",
        limit: 1,
      }),
    );
    assert.ok(firstPage.nextCursor);

    await assert.rejects(
      Effect.runPromise(
        retrievalService.retrieve({
          spaceId: tenantId,
          query: "ranking cursor token",
          limit: 1,
          cursor: firstPage.nextCursor,
          ranking_weights: {
            decay: 1,
          },
        }),
      ),
      (error) => {
        const errorMessage =
          typeof error?.message === "string" && error.message.length > 0
            ? error.message
            : String(error);
        assert.match(errorMessage, /digest/i);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("ums-memory-8as.2: partial scope selectors include descendant scopes", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-scope-descendants";
    const projectId = "project-desc";
    const roleId = "role-desc";
    const projectUserId = "user-project-desc";
    const roleUserId = "user-role-desc";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [projectUserId, roleUserId],
    });

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-project-parent",
      layer: "working",
      payload: {
        title: "desc token project parent",
        scope: { projectId },
        updatedAtMillis: 10,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-project-user-child",
      layer: "working",
      payload: {
        title: "desc token project user",
        scope: { userId: projectUserId, projectId },
        updatedAtMillis: 10,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-role-parent",
      layer: "working",
      payload: {
        title: "desc token role parent",
        scope: { roleId },
        updatedAtMillis: 10,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-role-user-child",
      layer: "working",
      payload: {
        title: "desc token role user",
        scope: { userId: roleUserId, roleId },
        updatedAtMillis: 10,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );

    const projectScoped = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "desc token",
        limit: 10,
        scope: { projectId },
      }),
    );
    const roleScoped = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "desc token",
        limit: 10,
        scope: { roleId },
      }),
    );

    assert.deepEqual(
      projectScoped.hits.map((hit) => hit.memoryId),
      ["memory-project-user-child", "memory-project-parent"],
    );
    assert.deepEqual(
      roleScoped.hits.map((hit) => hit.memoryId),
      ["memory-role-user-child", "memory-role-parent"],
    );
  } finally {
    db.close();
  }
});

test("ums-memory-8as.3: ranking combines evidence, decay, human weight, and utility with request weight overrides", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-ranking-signals";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-weighted-signals",
      layer: "working",
      payload: {
        title: "ranking signal token weighted profile",
        updatedAtMillis: 100,
        expiresAtMillis: 1_000,
        evidencePointers: [
          { sourceRef: "event://signal-weighted-1", relationKind: "supports" },
          { sourceRef: "event://signal-weighted-2", relationKind: "supports" },
          { sourceRef: "event://signal-weighted-3", relationKind: "supports" },
        ],
        humanWeight: 1,
        utilityScore: 1,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-fresh-low-signals",
      layer: "working",
      payload: {
        title: "ranking signal token fresh profile",
        updatedAtMillis: 900,
        expiresAtMillis: 901,
        humanWeight: 0,
        utilityScore: 0,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );

    const defaultWeightedResponse = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "ranking signal token",
        limit: 10,
      }),
    );
    assert.deepEqual(
      defaultWeightedResponse.hits.map((hit) => hit.memoryId),
      ["memory-weighted-signals", "memory-fresh-low-signals"],
    );
    assert.ok(defaultWeightedResponse.hits.every((hit) => hit.score >= 0 && hit.score <= 1));

    const decayWeightedResponse = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "ranking signal token",
        limit: 10,
        ranking_weights: {
          relevance: 0.15,
          evidence_strength: 0,
          decay: 0.85,
          human_weight: 0,
          utility_score: 0,
        },
      }),
    );
    assert.deepEqual(
      decayWeightedResponse.hits.map((hit) => hit.memoryId),
      ["memory-fresh-low-signals", "memory-weighted-signals"],
    );
    assert.ok(decayWeightedResponse.hits.every((hit) => hit.score >= 0 && hit.score <= 1));

    const decayOnlyResponse = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "ranking signal token",
        limit: 10,
        ranking_weights: {
          decay: 1,
        },
      }),
    );
    assert.deepEqual(
      decayOnlyResponse.hits.map((hit) => hit.memoryId),
      ["memory-fresh-low-signals", "memory-weighted-signals"],
    );
    assert.ok(decayOnlyResponse.hits.every((hit) => hit.score >= 0 && hit.score <= 1));
  } finally {
    db.close();
  }
});

test("ums-memory-8as.4: retrieval reconciles contradictory memories to the newest truth and keeps lineage metadata", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-contradiction-reconcile";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-old-truth",
      layer: "working",
      payload: {
        title: "timeline truth token old release guidance",
        updatedAtMillis: 100,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-new-truth",
      layer: "working",
      payload: {
        title: "timeline truth token new release guidance",
        updatedAtMillis: 300,
        supersedesMemoryId: "memory-old-truth",
        contradictsMemoryIds: ["memory-old-truth"],
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-neutral-fact",
      layer: "working",
      payload: {
        title: "timeline truth token deployment window unchanged",
        updatedAtMillis: 200,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );

    const response = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "timeline truth token",
        limit: 10,
      }),
    );

    assert.equal(response.totalHits, 2);
    assert.deepEqual(
      response.hits.map((hit) => hit.memoryId),
      ["memory-new-truth", "memory-neutral-fact"],
    );
    assert.deepEqual(response.hits[0]?.metadata?.chronology?.supersedesMemoryIds, [
      "memory-old-truth",
    ]);
    assert.deepEqual(response.hits[0]?.metadata?.chronology?.contradictsMemoryIds, [
      "memory-old-truth",
    ]);
    assert.deepEqual(response.hits[0]?.metadata?.chronology?.reconciledMemoryIds, [
      "memory-old-truth",
    ]);
    assert.equal(response.hits[1]?.metadata, undefined);
  } finally {
    db.close();
  }
});

test("ums-memory-8as.4: reconciliation honors contradiction links in metadata lineage payloads", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-contradiction-metadata-lineage";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-lineage-old",
      layer: "working",
      payload: {
        title: "metadata lineage contradiction token old",
        updatedAtMillis: 100,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-lineage-new",
      layer: "working",
      payload: {
        title: "metadata lineage contradiction token new",
        updatedAtMillis: 200,
        metadata: {
          lineage: {
            contradictsMemoryId: "memory-lineage-old",
          },
        },
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );

    const response = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "metadata lineage contradiction token",
        limit: 10,
      }),
    );

    assert.equal(response.totalHits, 1);
    assert.deepEqual(
      response.hits.map((hit) => hit.memoryId),
      ["memory-lineage-new"],
    );
    assert.deepEqual(response.hits[0]?.metadata?.chronology?.contradictsMemoryIds, [
      "memory-lineage-old",
    ]);
    assert.deepEqual(response.hits[0]?.metadata?.chronology?.reconciledMemoryIds, [
      "memory-lineage-old",
    ]);
  } finally {
    db.close();
  }
});

test("ums-memory-8as.4: contradiction reconciliation tie-breaking is deterministic for equal timestamps", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-contradiction-tie";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-alpha",
      layer: "working",
      payload: {
        title: "tie contradiction token alpha",
        updatedAtMillis: 500,
        contradictsMemoryId: "memory-beta",
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-beta",
      layer: "working",
      payload: {
        title: "tie contradiction token beta",
        updatedAtMillis: 500,
        contradictsMemoryId: "memory-alpha",
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );

    const request = {
      spaceId: tenantId,
      query: "tie contradiction token",
      limit: 10,
    };
    const firstResponse = await Effect.runPromise(retrievalService.retrieve(request));
    const secondResponse = await Effect.runPromise(retrievalService.retrieve(request));

    assert.deepEqual(firstResponse.hits, secondResponse.hits);
    assert.equal(firstResponse.totalHits, 1);
    assert.deepEqual(
      firstResponse.hits.map((hit) => hit.memoryId),
      ["memory-alpha"],
    );
    assert.deepEqual(firstResponse.hits[0]?.metadata?.chronology?.contradictsMemoryIds, [
      "memory-beta",
    ]);
    assert.deepEqual(firstResponse.hits[0]?.metadata?.chronology?.reconciledMemoryIds, [
      "memory-beta",
    ]);
  } finally {
    db.close();
  }
});

test("ums-memory-8as.2: retrieval planner enforces tenant isolation", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    upsertMemorySync(storageService, {
      spaceId: "tenant-a",
      memoryId: "memory-tenant-a",
      layer: "working",
      payload: {
        title: "tenant token shared",
        updatedAtMillis: 1,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: "tenant-b",
      memoryId: "memory-tenant-b",
      layer: "working",
      payload: {
        title: "tenant token shared",
        updatedAtMillis: 1,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );

    const tenantAResponse = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: "tenant-a",
        query: "tenant token",
        limit: 10,
      }),
    );
    const tenantBResponse = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: "tenant-b",
        query: "tenant token",
        limit: 10,
      }),
    );

    assert.equal(tenantAResponse.totalHits, 1);
    assert.equal(tenantAResponse.hits[0]?.memoryId, "memory-tenant-a");
    assert.equal(tenantBResponse.totalHits, 1);
    assert.equal(tenantBResponse.hits[0]?.memoryId, "memory-tenant-b");
  } finally {
    db.close();
  }
});

test("ums-memory-8as.5: actionable pack compilation is deterministic across repeated retrieval", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-actionable-pack-deterministic";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-do",
      layer: "working",
      payload: {
        title: "actionable deterministic token do",
        summary: "Do: verify cursor digest before replay.",
        updatedAtMillis: 400,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-dont",
      layer: "working",
      payload: {
        title: "actionable deterministic token dont",
        summary: "Do not bypass policy evaluation on retrieval hits.",
        updatedAtMillis: 300,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-example",
      layer: "episodic",
      payload: {
        title: "actionable deterministic token example",
        summary: "Example: replay the same request twice and compare the cursor output.",
        updatedAtMillis: 200,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-risk",
      layer: "working",
      payload: {
        title: "actionable deterministic token risk",
        summary: "Risk: stale evidence can skew retrieval ranking decisions.",
        updatedAtMillis: 100,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const request = {
      spaceId: tenantId,
      query: "actionable deterministic token",
      limit: 10,
    };

    const firstResponse = await Effect.runPromise(retrievalService.retrieve(request));
    const secondResponse = await Effect.runPromise(retrievalService.retrieve(request));

    assert.deepEqual(firstResponse.actionablePack, secondResponse.actionablePack);
    assert.ok(firstResponse.actionablePack);
    assert.deepEqual(firstResponse.actionablePack.do, ["Do: verify cursor digest before replay."]);
    assert.deepEqual(firstResponse.actionablePack.dont, [
      "Do not bypass policy evaluation on retrieval hits.",
    ]);
    assert.deepEqual(firstResponse.actionablePack.examples, [
      "Example: replay the same request twice and compare the cursor output.",
    ]);
    assert.deepEqual(firstResponse.actionablePack.risks, [
      "Risk: stale evidence can skew retrieval ranking decisions.",
    ]);
    assert.deepEqual(firstResponse.actionablePack.warnings, []);
    assert.deepEqual(
      firstResponse.actionablePack.sources.map((source) => source.memoryId),
      ["memory-do", "memory-dont", "memory-example", "memory-risk"],
    );
  } finally {
    db.close();
  }
});

test("ums-memory-8as.5: actionable pack enforces token budget and category/source bounds", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-actionable-pack-bounded";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const categoryPrefixes = Object.freeze(["Do:", "Do not:", "Example:", "Risk:"]);
    const repeatedBody =
      "deterministic retrieval budget validation requires explicit truncation guards and stable source attribution";

    for (let index = 0; index < 20; index += 1) {
      const prefix = categoryPrefixes[index % categoryPrefixes.length];
      upsertMemorySync(storageService, {
        spaceId: tenantId,
        memoryId: `memory-bounded-${String(index + 1).padStart(2, "0")}`,
        layer: index % categoryPrefixes.length === 2 ? "episodic" : "working",
        payload: {
          title: `actionable bounded token ${index + 1}`,
          summary: `${prefix} case ${index + 1} ${repeatedBody} ${repeatedBody} ${repeatedBody}`,
          updatedAtMillis: 2_000 - index,
        },
      });
    }

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const response = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "actionable bounded token",
        limit: 20,
      }),
    );

    assert.ok(response.actionablePack);
    for (const category of actionablePackCategories) {
      assert.ok(response.actionablePack[category].length <= actionablePackTestPerCategoryLimit);
    }
    assert.ok(response.actionablePack.sources.length <= actionablePackTestSourceLimit);
    assert.ok(estimateActionablePackTokens(response.actionablePack) <= actionablePackTestTokenBudget);
    assert.ok(response.actionablePack.sources.some((source) => source.excerpt.endsWith("...")));
    assert.ok(response.actionablePack.warnings.some((warning) => /token budget/i.test(warning)));
    assert.ok(response.actionablePack.warnings.some((warning) => /category limits/i.test(warning)));
    assert.ok(response.actionablePack.warnings.some((warning) => /source limit/i.test(warning)));
  } finally {
    db.close();
  }
});

test("ums-memory-8as.6: actionable pack warns when included sources are stale relative to freshest source", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-actionable-pack-stale-warning";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-fresh-guidance",
      layer: "working",
      payload: {
        title: "actionable stale warning token fresh guidance",
        summary: "Do: rely on the latest deployment checklist.",
        updatedAtMillis: 9 * 24 * 60 * 60 * 1_000,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-stale-guidance",
      layer: "working",
      payload: {
        title: "actionable stale warning token stale guidance",
        summary: "Risk: legacy rollout notes can drift from the latest state.",
        updatedAtMillis: 0,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const response = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "actionable stale warning token",
        limit: 10,
      }),
    );

    assert.ok(response.actionablePack);
    assert.equal(response.actionablePack.sources.length, 2);
    assert.ok(response.actionablePack.warnings.some((warning) => /stale guidance/i.test(warning)));
    assert.ok(
      !response.actionablePack.warnings.some((warning) => /low-confidence/i.test(warning)),
    );
  } finally {
    db.close();
  }
});

test("ums-memory-8as.6: actionable pack warns when included sources have low-confidence scores", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-actionable-pack-low-confidence-warning";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-high-confidence",
      layer: "working",
      payload: {
        title: "actionable confidence warning token alpha beta gamma profile",
        summary: "Do: prioritize guidance with complete query coverage.",
        updatedAtMillis: 5_000,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-low-confidence",
      layer: "working",
      payload: {
        title: "confidence trace fallback",
        summary: "Example: partial overlap can still produce a retrieval hit.",
        updatedAtMillis: 5_000,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const response = await Effect.runPromise(
      retrievalService.retrieve({
        spaceId: tenantId,
        query: "actionable confidence warning token alpha beta gamma",
        limit: 10,
        ranking_weights: {
          relevance: 1,
          evidence_strength: 0,
          decay: 0,
          human_weight: 0,
          utility_score: 0,
        },
      }),
    );

    assert.ok(response.actionablePack);
    assert.ok(
      response.actionablePack.warnings.some((warning) => /low-confidence guidance/i.test(warning)),
    );
    assert.ok(!response.actionablePack.warnings.some((warning) => /stale guidance/i.test(warning)));
  } finally {
    db.close();
  }
});

test("ums-memory-8as.6: annotation warning helper remains deterministic for stale and low-confidence signals", async () => {
  const { retrievalServiceModule } = await loadModules();
  const dayMillis = 24 * 60 * 60 * 1_000;

  const firstWarnings = retrievalServiceModule.__testOnly.toActionablePackAnnotationWarnings([
    {
      updatedAtMillis: 9 * dayMillis,
      score: 0.82,
    },
    {
      updatedAtMillis: 0,
      score: 0.34,
    },
  ]);
  const secondWarnings = retrievalServiceModule.__testOnly.toActionablePackAnnotationWarnings([
    {
      updatedAtMillis: 9 * dayMillis,
      score: 0.82,
    },
    {
      updatedAtMillis: 0,
      score: 0.34,
    },
  ]);

  assert.deepEqual(firstWarnings, secondWarnings);
  assert.ok(firstWarnings.some((warning) => /stale guidance/i.test(warning)));
  assert.ok(firstWarnings.some((warning) => /low-confidence guidance/i.test(warning)));
});

test("ums-memory-8as.7: explainability returns ranking signals and weighted contributions for selected hits", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-explainability-signals";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-explainability-rich-signals",
      layer: "working",
      payload: {
        title: "explainability signal token rich profile",
        updatedAtMillis: 400,
        expiresAtMillis: 1_400,
        evidencePointers: [
          { sourceRef: "event://explainability-rich-1", relationKind: "supports" },
          { sourceRef: "event://explainability-rich-2", relationKind: "supports" },
        ],
        humanWeight: 0.9,
        utilityScore: 0.8,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-explainability-low-signals",
      layer: "working",
      payload: {
        title: "explainability signal token lean profile",
        updatedAtMillis: 200,
        expiresAtMillis: 205,
        humanWeight: 0.1,
        utilityScore: 0.2,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const request = {
      spaceId: tenantId,
      query: "explainability signal token",
      limit: 10,
      ranking_weights: {
        relevance: 0.5,
        evidence_strength: 0.2,
        decay: 0.15,
        human_weight: 0.1,
        utility_score: 0.05,
      },
    };
    const retrievalResponse = await Effect.runPromise(retrievalService.retrieve(request));
    const explainabilityResponse = await Effect.runPromise(
      retrievalService.retrieveExplainability(request),
    );

    assert.equal(explainabilityResponse.totalHits, retrievalResponse.totalHits);
    assert.equal(explainabilityResponse.nextCursor, retrievalResponse.nextCursor);
    assert.deepEqual(
      explainabilityResponse.hits.map((hit) => hit.memoryId),
      retrievalResponse.hits.map((hit) => hit.memoryId),
    );
    assert.equal(explainabilityResponse.hits.length, 2);

    for (const hit of explainabilityResponse.hits) {
      assert.deepEqual(Object.keys(hit.rankingSignals), [
        "relevance",
        "evidenceStrength",
        "decay",
        "humanWeight",
        "utility",
      ]);
      assert.deepEqual(
        hit.weightedContributions.map((entry) => entry.signal),
        ["relevance", "evidenceStrength", "decay", "humanWeight", "utility"],
      );
      for (const contribution of hit.weightedContributions) {
        assert.ok(contribution.signalScore >= 0 && contribution.signalScore <= 1);
        assert.ok(contribution.weight >= 0 && contribution.weight <= 1);
        assert.equal(
          contribution.weightedContribution,
          roundRetrievalScore(contribution.weight * contribution.signalScore),
        );
      }
    }
  } finally {
    db.close();
  }
});

test("ums-memory-8as.7: explainability response is deterministic across repeated calls", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-explainability-deterministic";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    for (let index = 1; index <= 4; index += 1) {
      upsertMemorySync(storageService, {
        spaceId: tenantId,
        memoryId: `memory-explainability-deterministic-${index}`,
        layer: "working",
        payload: {
          title: `explainability deterministic token ${index}`,
          updatedAtMillis: 100 + index,
        },
      });
    }

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const firstPageRequest = {
      spaceId: tenantId,
      query: "explainability deterministic token",
      limit: 2,
    };

    const firstResponse = await Effect.runPromise(
      retrievalService.retrieveExplainability(firstPageRequest),
    );
    const firstReplay = await Effect.runPromise(
      retrievalService.retrieveExplainability(firstPageRequest),
    );
    assert.deepEqual(firstResponse, firstReplay);
    assert.deepEqual(
      firstResponse.hits.map((hit) => hit.rank),
      [1, 2],
    );
    assert.ok(firstResponse.nextCursor);

    const secondPageRequest = {
      ...firstPageRequest,
      cursor: firstResponse.nextCursor,
    };
    const secondResponse = await Effect.runPromise(
      retrievalService.retrieveExplainability(secondPageRequest),
    );
    const secondReplay = await Effect.runPromise(
      retrievalService.retrieveExplainability(secondPageRequest),
    );
    assert.deepEqual(secondResponse, secondReplay);
    assert.deepEqual(
      secondResponse.hits.map((hit) => hit.rank),
      [3, 4],
    );
  } finally {
    db.close();
  }
});

test("ums-memory-8as.7: explainability reason codes include scope ranking and policy factors", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-explainability-reason-codes";
    const projectId = "project-reason-codes";
    const roleId = "role-reason-codes";
    const userId = "user-reason-codes";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-common-scope-reason",
      layer: "working",
      payload: {
        title: "explainability reason token common",
        updatedAtMillis: 300,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-user-scope-reason",
      layer: "working",
      payload: {
        title: "explainability reason token user",
        scope: { projectId, roleId, userId },
        updatedAtMillis: 300,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const response = await Effect.runPromise(
      retrievalService.retrieveExplainability({
        spaceId: tenantId,
        query: "explainability reason token",
        limit: 10,
        scope: { projectId, roleId, userId },
        policy: {
          actorId: userId,
          action: "memory.retrieve",
          evidenceIds: ["evidence-reason-codes-1"],
          context: {
            requestId: "req-reason-codes-1",
          },
        },
      }),
    );

    assert.equal(response.totalHits, 2);
    assert.equal(response.hits[0]?.memoryId, "memory-user-scope-reason");
    assert.ok(response.hits[0]?.reasonCodes.includes("QUERY_TOKEN_MATCH"));
    assert.ok(response.hits[0]?.reasonCodes.includes("SCOPE_FILTER_MATCH"));
    assert.ok(response.hits[0]?.reasonCodes.includes("SCOPE_SELECTOR_APPLIED"));
    assert.ok(response.hits[0]?.reasonCodes.includes("SCOPE_LEVEL_USER"));
    assert.ok(response.hits[0]?.reasonCodes.includes("POLICY_ALLOW"));
    assert.ok(response.hits[0]?.reasonCodes.includes("RANKING_WEIGHTED_SIGNALS"));
  } finally {
    db.close();
  }
});

test("ums-memory-8as.8: coding-agent release workflow prefers superseding guidance with traceable actionable output", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const dayMillis = 24 * 60 * 60 * 1_000;
    const tenantId = "tenant-scenario-release-workflow";
    const projectId = "project-release-workflow";
    const roleId = "role-release-workflow";
    const userId = "user-release-workflow";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-common-release-checklist",
      layer: "working",
      payload: {
        title: "release workflow token checklist baseline",
        summary: "Do: run the test suite before changing release scripts.",
        updatedAtMillis: 8 * dayMillis,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-project-release-old",
      layer: "working",
      payload: {
        title: "release workflow token bundler legacy guidance",
        summary: "Do: skip bundler verification before publishing packages.",
        scope: { projectId },
        updatedAtMillis: 2 * dayMillis,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-project-release-new",
      layer: "working",
      payload: {
        title: "release workflow token bundler corrected guidance",
        summary: "Do: verify bundler output hash before publishing packages.",
        scope: { projectId },
        updatedAtMillis: 11 * dayMillis,
        supersedesMemoryId: "memory-project-release-old",
        contradictsMemoryIds: ["memory-project-release-old"],
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-role-release-guardrail",
      layer: "working",
      payload: {
        title: "release workflow token role guardrail",
        summary: "Do not merge release changes without green CI checks.",
        scope: { roleId },
        updatedAtMillis: 10 * dayMillis,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-user-release-example",
      layer: "episodic",
      payload: {
        title: "release workflow token user scenario",
        summary: "Example: run lint and tests in dry-run mode before tagging.",
        scope: { projectId, roleId, userId },
        updatedAtMillis: 10 * dayMillis + 1_000,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-common-release-risk-legacy",
      layer: "working",
      payload: {
        title: "release workflow token legacy risk",
        summary: "Risk: legacy publish scripts can omit changelog generation.",
        updatedAtMillis: 0,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const request = {
      spaceId: tenantId,
      query: "release workflow token bundler ci checklist",
      limit: 10,
      scope: { projectId, roleId, userId },
      policy: {
        actorId: userId,
        action: "memory.retrieve",
        evidenceIds: ["evidence-release-1"],
        context: {
          requestId: "req-release-1",
        },
      },
    };

    const firstResponse = await Effect.runPromise(retrievalService.retrieve(request));
    const secondResponse = await Effect.runPromise(retrievalService.retrieve(request));
    assert.deepEqual(firstResponse, secondResponse);

    assert.ok(firstResponse.actionablePack);
    const hitMemoryIds = firstResponse.hits.map((hit) => hit.memoryId);
    assert.ok(firstResponse.totalHits >= firstResponse.hits.length);
    assert.ok(firstResponse.hits.length >= 3);
    assert.ok(hitMemoryIds.includes("memory-project-release-new"));
    assert.ok(!hitMemoryIds.includes("memory-project-release-old"));

    const reconciledHit = firstResponse.hits.find(
      (hit) => hit.memoryId === "memory-project-release-new",
    );
    assert.deepEqual(reconciledHit?.metadata?.chronology?.reconciledMemoryIds, [
      "memory-project-release-old",
    ]);

    const actionablePack = firstResponse.actionablePack;
    assert.ok(actionablePack.do.some((line) => /verify bundler output hash/i.test(line)));
    assert.ok(actionablePack.dont.some((line) => /without green ci/i.test(line)));
    assert.ok(actionablePack.examples.some((line) => /dry-run mode before tagging/i.test(line)));
    assert.ok(actionablePack.risks.length >= 1);
    assert.ok(actionablePack.warnings.length >= 1);
    assert.ok(actionablePack.warnings.some((warning) => /stale/i.test(warning)));

    const sourceMemoryIds = actionablePack.sources.map((source) => source.memoryId);
    assert.ok(sourceMemoryIds.includes("memory-project-release-new"));
    assert.ok(sourceMemoryIds.includes("memory-common-release-risk-legacy"));
    assert.ok(!sourceMemoryIds.includes("memory-project-release-old"));
    assert.ok(sourceMemoryIds.every((memoryId) => hitMemoryIds.includes(memoryId)));
    for (const source of actionablePack.sources) {
      assert.ok(source.metadata.score >= 0 && source.metadata.score <= 1);
      assert.ok(source.metadata.layer === "working" || source.metadata.layer === "episodic");
    }

    const firstExplainability = await Effect.runPromise(retrievalService.retrieveExplainability(request));
    const secondExplainability = await Effect.runPromise(
      retrievalService.retrieveExplainability(request),
    );
    assert.deepEqual(firstExplainability, secondExplainability);
    assert.deepEqual(
      [...firstExplainability.hits.map((hit) => hit.memoryId)].sort(),
      [...hitMemoryIds].sort(),
    );

    const reconciledExplainabilityHit = firstExplainability.hits.find(
      (hit) => hit.memoryId === "memory-project-release-new",
    );
    assert.ok(reconciledExplainabilityHit?.reasonCodes.includes("CHRONOLOGY_RECONCILED"));

    const reasonCodeUnion = new Set(firstExplainability.hits.flatMap((hit) => hit.reasonCodes));
    assert.ok(reasonCodeUnion.has("QUERY_TOKEN_MATCH"));
    assert.ok(reasonCodeUnion.has("SCOPE_FILTER_MATCH"));
    assert.ok(reasonCodeUnion.has("RANKING_WEIGHTED_SIGNALS"));
    assert.ok([...reasonCodeUnion].some((reasonCode) => reasonCode.startsWith("SCOPE_LEVEL_")));

    for (const hit of firstExplainability.hits) {
      assert.ok(hit.reasonCodes.length > 0);
      const rankingSignalKeys = Object.keys(hit.rankingSignals);
      const expectedRankingSignalKeys = [
        "relevance",
        "evidenceStrength",
        "decay",
        "humanWeight",
        "utility",
      ];
      for (const expectedSignalKey of expectedRankingSignalKeys) {
        assert.ok(rankingSignalKeys.includes(expectedSignalKey));
      }
      const contributionSignals = hit.weightedContributions.map((entry) => entry.signal);
      for (const expectedSignalKey of expectedRankingSignalKeys) {
        assert.ok(contributionSignals.includes(expectedSignalKey));
      }
      assert.equal(new Set(contributionSignals).size, contributionSignals.length);
      for (const contribution of hit.weightedContributions) {
        assert.ok(contribution.signalScore >= 0 && contribution.signalScore <= 1);
        assert.ok(contribution.weight >= 0 && contribution.weight <= 1);
        assert.equal(
          contribution.weightedContribution,
          roundRetrievalScore(contribution.weight * contribution.signalScore),
        );
      }
    }
  } finally {
    db.close();
  }
});

test("ums-memory-8as.8: coding-agent flaky-test workflow surfaces stale and low-confidence warnings with explainability weights", async () => {
  const { retrievalServiceModule, storageServiceModule } = await loadModules();
  const db = new DatabaseSync(":memory:");

  try {
    const dayMillis = 24 * 60 * 60 * 1_000;
    const tenantId = "tenant-scenario-flaky-workflow";
    const projectId = "project-flaky-workflow";
    const roleId = "role-flaky-workflow";
    const userId = "user-flaky-workflow";
    const storageService = storageServiceModule.makeSqliteStorageService(db);

    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-common-flaky-old",
      layer: "working",
      payload: {
        title: "flaky test workflow token old guidance",
        summary: "Do: bypass flaky tests by forcing success in CI.",
        updatedAtMillis: 2 * dayMillis,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-user-flaky-new",
      layer: "working",
      payload: {
        title: "flaky test workflow token corrected guidance",
        summary: "Do: quarantine flaky tests and keep retry diagnostics enabled.",
        scope: { projectId, roleId, userId },
        updatedAtMillis: 12 * dayMillis,
        supersedesMemoryId: "memory-common-flaky-old",
        contradictsMemoryIds: ["memory-common-flaky-old"],
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-project-flaky-dont",
      layer: "working",
      payload: {
        title: "flaky test workflow token merge guardrail",
        summary: "Do not merge flaky fixes before reproducing the failing seed.",
        scope: { projectId },
        updatedAtMillis: 11 * dayMillis,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-role-flaky-example",
      layer: "episodic",
      payload: {
        title: "flaky test workflow token role scenario",
        summary: "Example: run tests with --runInBand and seed 42 for deterministic repro.",
        scope: { roleId },
        updatedAtMillis: 11 * dayMillis - 5_000,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-common-flaky-risk-stale",
      layer: "working",
      payload: {
        title: "flaky test workflow token stale cache risk",
        summary: "Risk: stale CI cache can hide flaky test regressions.",
        updatedAtMillis: 0,
      },
    });
    upsertMemorySync(storageService, {
      spaceId: tenantId,
      memoryId: "memory-project-flaky-low-confidence",
      layer: "working",
      payload: {
        title: "flaky tracker note",
        summary: "Do: log flaky owner in the issue tracker.",
        scope: { projectId },
        updatedAtMillis: 12 * dayMillis + 1_000,
      },
    });

    const retrievalService = retrievalServiceModule.makeRetrievalService(
      storageService,
      makePolicyService(),
    );
    const rankingWeights = {
      relevance: 0.9,
      evidence_strength: 0.05,
      decay: 0.05,
      human_weight: 0,
      utility_score: 0,
    };
    const request = {
      spaceId: tenantId,
      query: "flaky test workflow token seed diagnostics cache retry",
      limit: 10,
      scope: { projectId, roleId, userId },
      ranking_weights: rankingWeights,
      policy: {
        actorId: userId,
        action: "memory.retrieve",
        evidenceIds: ["evidence-flaky-1"],
        context: {
          requestId: "req-flaky-1",
        },
      },
    };

    const firstResponse = await Effect.runPromise(retrievalService.retrieve(request));
    const secondResponse = await Effect.runPromise(retrievalService.retrieve(request));
    assert.deepEqual(firstResponse, secondResponse);

    assert.ok(firstResponse.actionablePack);
    const hitMemoryIds = firstResponse.hits.map((hit) => hit.memoryId);
    assert.ok(firstResponse.totalHits >= firstResponse.hits.length);
    assert.ok(firstResponse.hits.length >= 3);
    assert.ok(hitMemoryIds.includes("memory-user-flaky-new"));
    assert.ok(!hitMemoryIds.includes("memory-common-flaky-old"));

    const correctedHit = firstResponse.hits.find((hit) => hit.memoryId === "memory-user-flaky-new");
    assert.deepEqual(correctedHit?.metadata?.chronology?.reconciledMemoryIds, [
      "memory-common-flaky-old",
    ]);

    const actionablePack = firstResponse.actionablePack;
    assert.ok(actionablePack.do.some((line) => /quarantine flaky tests/i.test(line)));
    assert.ok(actionablePack.dont.some((line) => /do not merge flaky fixes/i.test(line)));
    assert.ok(actionablePack.examples.some((line) => /--runInBand/i.test(line)));
    assert.ok(actionablePack.risks.some((line) => /stale ci cache/i.test(line)));
    assert.ok(actionablePack.warnings.length >= 1);
    assert.ok(actionablePack.warnings.some((warning) => /stale/i.test(warning)));
    assert.ok(actionablePack.warnings.some((warning) => /confidence/i.test(warning)));

    const sourceMemoryIds = actionablePack.sources.map((source) => source.memoryId);
    assert.ok(sourceMemoryIds.includes("memory-user-flaky-new"));
    assert.ok(sourceMemoryIds.includes("memory-project-flaky-low-confidence"));
    assert.ok(!sourceMemoryIds.includes("memory-common-flaky-old"));
    assert.ok(sourceMemoryIds.every((memoryId) => hitMemoryIds.includes(memoryId)));
    for (const source of actionablePack.sources) {
      assert.ok(source.metadata.score >= 0 && source.metadata.score <= 1);
    }

    const firstExplainability = await Effect.runPromise(retrievalService.retrieveExplainability(request));
    const secondExplainability = await Effect.runPromise(
      retrievalService.retrieveExplainability(request),
    );
    assert.deepEqual(firstExplainability, secondExplainability);
    assert.deepEqual(
      [...firstExplainability.hits.map((hit) => hit.memoryId)].sort(),
      [...hitMemoryIds].sort(),
    );

    const correctedExplainabilityHit = firstExplainability.hits.find(
      (hit) => hit.memoryId === "memory-user-flaky-new",
    );
    assert.ok(correctedExplainabilityHit?.reasonCodes.includes("CHRONOLOGY_RECONCILED"));
    assert.ok(correctedExplainabilityHit?.reasonCodes.includes("SCOPE_LEVEL_USER"));

    const reasonCodeUnion = new Set(firstExplainability.hits.flatMap((hit) => hit.reasonCodes));
    assert.ok(reasonCodeUnion.has("QUERY_TOKEN_MATCH"));
    assert.ok(reasonCodeUnion.has("SCOPE_FILTER_MATCH"));
    assert.ok(reasonCodeUnion.has("RANKING_WEIGHTED_SIGNALS"));
    assert.ok([...reasonCodeUnion].some((reasonCode) => reasonCode.startsWith("SCOPE_LEVEL_")));

    for (const hit of firstExplainability.hits) {
      assert.ok(hit.reasonCodes.length > 0);
      const contributionSignals = hit.weightedContributions.map((entry) => entry.signal);
      const expectedContributionSignals = [
        "relevance",
        "evidenceStrength",
        "decay",
        "humanWeight",
        "utility",
      ];
      for (const expectedSignal of expectedContributionSignals) {
        assert.ok(contributionSignals.includes(expectedSignal));
      }
      assert.equal(new Set(contributionSignals).size, contributionSignals.length);
      const contributionBySignal = Object.fromEntries(
        hit.weightedContributions.map((entry) => [entry.signal, entry]),
      );
      assert.ok(contributionBySignal.relevance.weight >= 0 && contributionBySignal.relevance.weight <= 1);
      assert.ok(
        contributionBySignal.evidenceStrength.weight >= 0 &&
          contributionBySignal.evidenceStrength.weight <= 1,
      );
      assert.ok(contributionBySignal.decay.weight >= 0 && contributionBySignal.decay.weight <= 1);
      assert.ok(
        contributionBySignal.humanWeight.weight >= 0 &&
          contributionBySignal.humanWeight.weight <= 1,
      );
      assert.ok(contributionBySignal.utility.weight >= 0 && contributionBySignal.utility.weight <= 1);
      assert.equal(contributionBySignal.humanWeight.weight, 0);
      assert.equal(contributionBySignal.utility.weight, 0);
      assert.ok(contributionBySignal.relevance.weight > contributionBySignal.evidenceStrength.weight);
      for (const contribution of hit.weightedContributions) {
        assert.equal(
          contribution.weightedContribution,
          roundRetrievalScore(contribution.weight * contribution.signalScore),
        );
      }
    }
  } finally {
    db.close();
  }
});
