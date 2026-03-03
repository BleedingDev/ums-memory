import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Effect as EffectOriginal } from "effect";
import ts from "typescript";

const either = (effect) =>
  EffectOriginal.result(effect).pipe(
    EffectOriginal.map((result) =>
      result._tag === "Failure"
        ? { _tag: "Left", left: result.failure }
        : { _tag: "Right", right: result.success }
    )
  );

const Effect = { ...EffectOriginal, either };

const effectModuleDirectory = new URL(
  "../../libs/shared/src/effect/",
  import.meta.url
);

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
        const messageText = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n"
        );
        const position =
          diagnostic.file === undefined || diagnostic.start === undefined
            ? sourceFilename
            : `${sourceFilename}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
        return `${position} - ${messageText}`;
      })
      .join("\n");
    throw new Error(
      `TypeScript transpile diagnostics for ${sourceFilename}:\n${diagnosticMessage}`
    );
  }

  const outputFilename = join(
    tempDirectory,
    sourceFilename.replace(/\.ts$/, ".js")
  );
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
  "services/tenant-routing-service.ts",
]);

let modulesPromise;
let transpiledDirectoryPath;

const loadTenantRoutingModules = async () => {
  if (!modulesPromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(
      join(tempRootDirectory, "ums-memory-tenant-routing-service-")
    );

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const tenantRoutingModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/tenant-routing-service.js")
    ).href;

    modulesPromise = import(tenantRoutingModuleUrl).then(
      (tenantRoutingServiceModule) => ({
        tenantRoutingServiceModule,
      })
    );
  }

  return modulesPromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

const baseRequest = Object.freeze({
  tenants: [
    { tenantId: "tenant_a", tenantSlug: "tenant-a" },
    { tenantId: "tenant_b", tenantSlug: "tenant-b" },
  ],
  issuerBindings: [
    { issuer: "https://idp-a.example.com", tenantId: "tenant_a" },
    { issuer: "https://idp-b.example.com", tenantId: "tenant_b" },
  ],
});

test("ums-memory-wt0.2: resolves tenant by tenant_id claim first", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      tenantIdClaim: "tenant_b",
      tenantSlugClaim: "tenant-b",
      issuer: "https://idp-b.example.com",
    })
  );

  assert.equal(decision.resolved, true);
  assert.equal(decision.tenantId, "tenant_b");
  assert.equal(decision.source, "tenant_id_claim");
  assert.equal(decision.denyReasonCode, undefined);
  assert.deepEqual(decision.candidateTenantIds, ["tenant_b"]);
});

test("ums-memory-wt0.2: falls back to tenant_slug claim when tenant_id claim is absent", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      tenantSlugClaim: "tenant-a",
    })
  );

  assert.equal(decision.resolved, true);
  assert.equal(decision.tenantId, "tenant_a");
  assert.equal(decision.source, "tenant_slug_claim");
  assert.equal(decision.denyReasonCode, undefined);
  assert.deepEqual(decision.candidateTenantIds, ["tenant_a"]);
});

test("ums-memory-wt0.2: falls back to issuer binding when claims are absent", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      issuer: "https://idp-a.example.com",
    })
  );

  assert.equal(decision.resolved, true);
  assert.equal(decision.tenantId, "tenant_a");
  assert.equal(decision.source, "issuer_binding");
  assert.equal(decision.denyReasonCode, undefined);
  assert.deepEqual(decision.candidateTenantIds, ["tenant_a"]);
});

test("ums-memory-wt0.2: denies with TENANT_ROUTE_CONFLICT when tenant_id and tenant_slug disagree", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      tenantIdClaim: "tenant_a",
      tenantSlugClaim: "tenant-b",
    })
  );

  assert.equal(decision.resolved, false);
  assert.equal(decision.denyReasonCode, "TENANT_ROUTE_CONFLICT");
  assert.deepEqual(decision.candidateTenantIds, ["tenant_a", "tenant_b"]);
});

test("ums-memory-wt0.2: denies with TENANT_ROUTE_CONFLICT on duplicate slug mappings to different tenants", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      tenants: [
        ...baseRequest.tenants,
        { tenantId: "tenant_c", tenantSlug: "tenant-a" },
      ],
    })
  );

  assert.equal(decision.resolved, false);
  assert.equal(decision.denyReasonCode, "TENANT_ROUTE_CONFLICT");
  assert.deepEqual(decision.candidateTenantIds, ["tenant_a", "tenant_c"]);
});

test("ums-memory-wt0.2: denies with TENANT_ROUTE_CONFLICT on duplicate issuer mappings to different tenants", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      issuer: "https://idp-a.example.com",
      issuerBindings: [
        ...baseRequest.issuerBindings,
        { issuer: "https://idp-a.example.com", tenantId: "tenant_b" },
      ],
    })
  );

  assert.equal(decision.resolved, false);
  assert.equal(decision.denyReasonCode, "TENANT_ROUTE_CONFLICT");
  assert.deepEqual(decision.candidateTenantIds, ["tenant_a", "tenant_b"]);
});

test("ums-memory-wt0.2: denies with TENANT_ISSUER_MISMATCH when issuer binding disagrees with resolved tenant", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      tenantIdClaim: "tenant_a",
      issuer: "https://idp-b.example.com",
    })
  );

  assert.equal(decision.resolved, false);
  assert.equal(decision.tenantId, "tenant_a");
  assert.equal(decision.denyReasonCode, "TENANT_ISSUER_MISMATCH");
  assert.deepEqual(decision.candidateTenantIds, ["tenant_a", "tenant_b"]);
});

test("ums-memory-wt0.2: denies with TENANT_ISSUER_MISMATCH on issuer bindings that reference unknown tenants", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      issuer: "https://idp-unknown.example.com",
      issuerBindings: [
        ...baseRequest.issuerBindings,
        {
          issuer: "https://idp-unknown.example.com",
          tenantId: "tenant_missing",
        },
      ],
    })
  );

  assert.equal(decision.resolved, false);
  assert.equal(decision.tenantId, undefined);
  assert.equal(decision.denyReasonCode, "TENANT_ISSUER_MISMATCH");
  assert.deepEqual(decision.candidateTenantIds, []);
});

test("ums-memory-wt0.2: denies with TENANT_ISSUER_MISMATCH when issuer has both valid and invalid bindings", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      issuer: "https://idp-a.example.com",
      issuerBindings: [
        ...baseRequest.issuerBindings,
        {
          issuer: "https://idp-a.example.com",
          tenantId: "tenant_missing",
        },
      ],
    })
  );

  assert.equal(decision.resolved, false);
  assert.equal(decision.tenantId, "tenant_a");
  assert.equal(decision.denyReasonCode, "TENANT_ISSUER_MISMATCH");
  assert.deepEqual(decision.candidateTenantIds, ["tenant_a"]);
});

test("ums-memory-wt0.2: denies with TENANT_ROUTE_MISSING when no path resolves", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const decision = await Effect.runPromise(
    service.resolve({
      ...baseRequest,
      tenantSlugClaim: "tenant-z",
      issuer: "https://idp-z.example.com",
    })
  );

  assert.equal(decision.resolved, false);
  assert.equal(decision.tenantId, undefined);
  assert.equal(decision.denyReasonCode, "TENANT_ROUTE_MISSING");
  assert.deepEqual(decision.candidateTenantIds, []);
});

test("ums-memory-wt0.2: assertResolved fails with TenantRoutingDeniedError for denied routes", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();
  const service =
    tenantRoutingServiceModule.makeDeterministicTenantRoutingService();

  const eitherResult = await Effect.runPromise(
    Effect.either(
      service.assertResolved({
        ...baseRequest,
        tenantIdClaim: "tenant_a",
        issuer: "https://idp-b.example.com",
      })
    )
  );

  assert.equal(eitherResult._tag, "Left");
  assert.equal(eitherResult.left._tag, "TenantRoutingDeniedError");
  assert.equal(eitherResult.left.denyReasonCode, "TENANT_ISSUER_MISMATCH");
  assert.deepEqual(eitherResult.left.candidateTenantIds, [
    "tenant_a",
    "tenant_b",
  ]);
  assert.equal(eitherResult.left.evaluatedAtMillis, 0);
});

test("ums-memory-wt0.2: deterministic layer keeps evaluatedAtMillis stable at zero", async () => {
  const { tenantRoutingServiceModule } = await loadTenantRoutingModules();

  const decision = await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(
        Effect.service(tenantRoutingServiceModule.TenantRoutingServiceTag),
        (service) =>
          service.resolve({
            ...baseRequest,
            tenantIdClaim: "tenant_b",
          })
      ),
      tenantRoutingServiceModule.deterministicTenantRoutingLayer
    )
  );

  assert.equal(decision.evaluatedAtMillis, 0);
});
