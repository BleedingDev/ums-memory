import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { test } from "@effect-native/bun-test";
import { Effect as EffectOriginal } from "effect";
import ts from "typescript";

const either = (effect: any) =>
  EffectOriginal.result(effect).pipe(
    EffectOriginal.map((result) =>
      result._tag === "Failure"
        ? { _tag: "Left", left: result.failure }
        : { _tag: "Right", right: result.success }
    )
  );

const Effect: any = { ...EffectOriginal, either };

const effectModuleDirectory = new URL(
  "../../libs/shared/src/effect/",
  import.meta.url
);

const transpileEffectModule = (sourceFilename: any, tempDirectory: any) => {
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
  "errors.ts",
  "services/authorization-service.ts",
]);

let modulesPromise: any;
let transpiledDirectoryPath: any;

const loadAuthorizationModules = async () => {
  if (!modulesPromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(
      join(tempRootDirectory, "ums-memory-rbac-authorization-model-")
    );

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const authorizationServiceModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/authorization-service.js")
    ).href;
    const errorsModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "errors.js")
    ).href;

    modulesPromise = Promise.all([
      import(authorizationServiceModuleUrl),
      import(errorsModuleUrl),
    ]).then(([authorizationServiceModule, errorsModule]) => ({
      authorizationServiceModule,
      errorsModule,
    }));
  }

  return modulesPromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

const evaluate = (service: any, request: any) =>
  Effect.runPromise(service.evaluate(request));

test("ums-memory-a9v.1: admin is allowed to run privileged policy override action", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();
  const service =
    authorizationServiceModule.makeDeterministicAuthorizationService();

  const decision = await evaluate(service, {
    role: "admin",
    action: "policy.override",
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reasonCode, "RBAC_ALLOW");
  assert.equal(decision.evaluatedAtMillis, 0);
});

test("ums-memory-a9v.1: auditor is denied privileged policy override action", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();
  const service =
    authorizationServiceModule.makeDeterministicAuthorizationService();

  const decision = await evaluate(service, {
    role: "auditor",
    action: "policy.override",
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "RBAC_DENY_ROLE_ACTION");
  assert.equal(decision.evaluatedAtMillis, 0);
});

test("ums-memory-a9v.1: dev role is denied memory promote and demote actions", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();
  const service =
    authorizationServiceModule.makeDeterministicAuthorizationService();

  const promoteDecision = await evaluate(service, {
    role: "dev",
    action: "memory.promote",
  });
  const demoteDecision = await evaluate(service, {
    role: "dev",
    action: "memory.demote",
  });

  assert.equal(promoteDecision.allowed, false);
  assert.equal(demoteDecision.allowed, false);
});

test("ums-memory-a9v.1: lead role is allowed memory promote and replay_eval actions", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();
  const service =
    authorizationServiceModule.makeDeterministicAuthorizationService();

  const promoteDecision = await evaluate(service, {
    role: "lead",
    action: "memory.promote",
  });
  const replayEvalDecision = await evaluate(service, {
    role: "lead",
    action: "memory.replay_eval",
  });

  assert.equal(promoteDecision.allowed, true);
  assert.equal(replayEvalDecision.allowed, true);
});

test("ums-memory-a9v.1: policy.write is reserved for admin and lead roles", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();
  const service =
    authorizationServiceModule.makeDeterministicAuthorizationService();

  const adminDecision = await evaluate(service, {
    role: "admin",
    action: "policy.write",
  });
  const leadDecision = await evaluate(service, {
    role: "lead",
    action: "policy.write",
  });
  const devDecision = await evaluate(service, {
    role: "dev",
    action: "policy.write",
  });

  assert.equal(adminDecision.allowed, true);
  assert.equal(leadDecision.allowed, true);
  assert.equal(devDecision.allowed, false);
});

test("ums-memory-a9v.1: assertAllowed fails with AuthorizationDeniedError on denied action", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();
  const service =
    authorizationServiceModule.makeDeterministicAuthorizationService();

  const eitherResult = await Effect.runPromise(
    Effect.either(
      service.assertAllowed({
        role: "auditor",
        action: "policy.override",
      })
    )
  );

  assert.equal(eitherResult._tag, "Left");
  assert.equal(eitherResult.left._tag, "AuthorizationDeniedError");
  assert.equal(eitherResult.left.role, "auditor");
  assert.equal(eitherResult.left.action, "policy.override");
  assert.equal(eitherResult.left.reasonCode, "RBAC_DENY_ROLE_ACTION");
  assert.equal(eitherResult.left.evaluatedAtMillis, 0);
});

test("ums-memory-a9v.1: authorization decisions remain deterministic across repeated calls", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();
  const service =
    authorizationServiceModule.makeDeterministicAuthorizationService();
  const request = {
    role: "lead",
    action: "memory.replay_eval",
  };

  const decisions = await Promise.all(
    Array.from({ length: 10 }, () => evaluate(service, request))
  );

  for (const decision of decisions) {
    assert.deepEqual(decision, decisions[0]);
  }
});

test("ums-memory-a9v.1: deterministicAuthorizationLayer provides zeroed evaluation clock", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();

  const decision = await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(
        Effect.service(authorizationServiceModule.AuthorizationServiceTag),
        (service: any) =>
          service.evaluate({
            role: "admin",
            action: "memory.read",
          })
      ),
      authorizationServiceModule.deterministicAuthorizationLayer
    )
  );

  assert.equal(decision.evaluatedAtMillis, 0);
});

test("ums-memory-a9v.1: any role/action inputs fail closed without throwing", async () => {
  const { authorizationServiceModule } = await loadAuthorizationModules();
  const service =
    authorizationServiceModule.makeDeterministicAuthorizationService();

  const decision = await evaluate(service, {
    role: "principal-engineer",
    action: "policy.override",
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "RBAC_DENY_ROLE_ACTION");
});
