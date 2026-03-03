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

import { Effect } from "effect";
import ts from "typescript";

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
  "services/policy-pack-plugin-service.ts",
]);

let modulesPromise;
let transpiledDirectoryPath;

const loadPolicyPackPluginModules = async () => {
  if (!modulesPromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(
      join(tempRootDirectory, "ums-memory-policy-pack-plugin-service-")
    );

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const policyPackPluginServiceModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/policy-pack-plugin-service.js")
    ).href;

    modulesPromise = Promise.all([
      import(policyPackPluginServiceModuleUrl),
    ]).then(([policyPackPluginServiceModule]) => ({
      policyPackPluginServiceModule,
    }));
  }

  return modulesPromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

test("ums-memory-a9v.5 noop policy pack plugin service is deterministic and pass-through", async () => {
  const { policyPackPluginServiceModule } = await loadPolicyPackPluginModules();
  const service =
    policyPackPluginServiceModule.makeNoopPolicyPackPluginService();

  const response = await Effect.runPromise(
    service.evaluateDecisionUpdate({
      contractVersion: "v1",
      operation: "policy_decision_update",
      storeId: "tenant-plugin-noop",
      profileId: "profile-plugin-noop",
      decisionId: "pol-plugin-noop",
      policyKey: "plugin-noop",
      action: "evaluate",
      surface: "general",
      outcome: "review",
      reasonCodes: ["insufficient-evidence"],
      provenanceEventIds: ["evt-plugin-noop-1"],
      evidenceEventIds: [],
      metadata: {},
      createdAt: "2026-03-02T20:00:00.000Z",
      updatedAt: "2026-03-02T20:00:00.000Z",
    })
  );

  assert.deepEqual(response, {
    contractVersion: "v1",
    outcome: "pass",
    reasonCodes: [],
    metadata: {},
  });
});

test("ums-memory-a9v.5 custom policy pack plugin service hook is invoked", async () => {
  const { policyPackPluginServiceModule } = await loadPolicyPackPluginModules();
  let called = 0;
  const service = policyPackPluginServiceModule.makePolicyPackPluginService(
    (request) => {
      called += 1;
      return Effect.succeed({
        contractVersion: "v1",
        outcome: request.policyKey === "plugin-deny" ? "deny" : "pass",
        reasonCodes: request.policyKey === "plugin-deny" ? ["plugin-risk"] : [],
        metadata: {
          seenPolicyKey: request.policyKey,
        },
      });
    }
  );

  const response = await Effect.runPromise(
    service.evaluateDecisionUpdate({
      contractVersion: "v1",
      operation: "policy_decision_update",
      storeId: "tenant-plugin-custom",
      profileId: "profile-plugin-custom",
      decisionId: "pol-plugin-custom",
      policyKey: "plugin-deny",
      action: "evaluate",
      surface: "general",
      outcome: "review",
      reasonCodes: ["insufficient-evidence"],
      provenanceEventIds: ["evt-plugin-custom-1"],
      evidenceEventIds: [],
      metadata: {},
      createdAt: "2026-03-02T20:05:00.000Z",
      updatedAt: "2026-03-02T20:05:00.000Z",
    })
  );

  assert.equal(called, 1);
  assert.equal(response.outcome, "deny");
  assert.deepEqual(response.reasonCodes, ["plugin-risk"]);
  assert.equal(response.metadata.seenPolicyKey, "plugin-deny");
});
