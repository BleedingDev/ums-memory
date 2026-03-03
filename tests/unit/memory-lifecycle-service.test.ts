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
  "contracts/index.ts",
  "contracts/validators.ts",
  "errors.ts",
  "services/lifecycle-service.ts",
]);

let modulesPromise: any;
let transpiledDirectoryPath: any;

const loadModules = async () => {
  if (!modulesPromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(
      join(tempRootDirectory, "ums-memory-lifecycle-service-")
    );

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const lifecycleServiceModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/lifecycle-service.js")
    ).href;

    modulesPromise = import(lifecycleServiceModuleUrl);
  }

  return modulesPromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

const runEither = (effect: any) => Effect.runPromise(Effect.either(effect));

const defaultShadowWriteRequest = Object.freeze({
  spaceId: "tenant-75m-default",
  candidateId: "candidate-75m-default",
  statement: "Memory lifecycle request baseline",
  scope: "project",
  sourceEpisodeIds: ["episode-a", "episode-b"],
  expiresAtMillis: 1_900_000_000_000,
  writtenAtMillis: 1_800_000_000_000,
});

const runShadowWriteViaLayer = (lifecycleServiceModule: any, request: any) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(
        Effect.service(lifecycleServiceModule.MemoryLifecycleServiceTag),
        (service: any) => service.shadowWrite(request)
      ),
      lifecycleServiceModule.noopMemoryLifecycleLayer
    )
  );

test("ums-memory-75m: shadow_write and replay_eval are deterministic for identical request digests", async () => {
  const lifecycleServiceModule = await loadModules();
  const service =
    lifecycleServiceModule.makeDeterministicMemoryLifecycleService();

  const shadowWriteRequest = {
    spaceId: "tenant-75m-shadow",
    candidateId: "candidate-75m-shadow",
    statement:
      "Prefer deterministic replay gates before any production promotion.",
    scope: "project",
    sourceEpisodeIds: ["episode-b", "episode-a", "episode-a"],
    expiresAtMillis: 1_900_000_000_000,
    writtenAtMillis: 1_800_000_000_000,
  };

  const firstShadow = await Effect.runPromise(
    service.shadowWrite(shadowWriteRequest)
  );
  const replayedShadow = await Effect.runPromise(
    service.shadowWrite({
      ...shadowWriteRequest,
    })
  );

  assert.deepEqual(replayedShadow, firstShadow);
  assert.equal(firstShadow.action, "created");
  assert.deepEqual(firstShadow.candidate.sourceEpisodeIds, [
    "episode-a",
    "episode-b",
  ]);

  const replayEvalRequest = {
    spaceId: "tenant-75m-shadow",
    candidateId: "candidate-75m-shadow",
    evaluationPackId: "pack-75m-digest",
    targetMemorySpace: "tenant-75m-shadow",
    evaluatedAtMillis: 1_800_000_010_000,
    qualityDelta: {
      successRateDelta: 0.18,
      reopenRateDelta: -0.07,
    },
    efficiencyDelta: {
      latencyP95DeltaMs: -150,
      tokenCostDelta: -40,
    },
    safetyDelta: {
      policyViolationsDelta: 0,
      hallucinationFlagDelta: 0,
    },
  };

  const firstReplay = await Effect.runPromise(
    service.replayEval(replayEvalRequest)
  );
  const replayedReplay = await Effect.runPromise(
    service.replayEval({
      ...replayEvalRequest,
    })
  );

  assert.deepEqual(replayedReplay, firstReplay);
  assert.equal(firstReplay.gateStatus, "pass");
  assert.ok(firstReplay.netValueScore >= 0);
});

test("ums-memory-75m: shadow_write canonical request digest is stable across sourceEpisodeIds ordering", async () => {
  const lifecycleServiceModule = await loadModules();
  const service =
    lifecycleServiceModule.makeDeterministicMemoryLifecycleService();

  const first = await Effect.runPromise(
    service.shadowWrite({
      ...defaultShadowWriteRequest,
      spaceId: "tenant-75m-shadow-canonical",
      candidateId: "candidate-75m-shadow-canonical",
      sourceEpisodeIds: ["episode-b", "episode-a"],
    })
  );

  const replay = await Effect.runPromise(
    service.shadowWrite({
      ...defaultShadowWriteRequest,
      spaceId: "tenant-75m-shadow-canonical",
      candidateId: "candidate-75m-shadow-canonical",
      sourceEpisodeIds: ["episode-a", "episode-b"],
    })
  );

  assert.deepEqual(replay, first);
  assert.equal(first.action, "created");
});

test("ums-memory-75m: shadow_write with newer writtenAtMillis refreshes candidate and clears replay state", async () => {
  const lifecycleServiceModule = await loadModules();
  const service =
    lifecycleServiceModule.makeDeterministicMemoryLifecycleService();

  await Effect.runPromise(
    service.shadowWrite({
      ...defaultShadowWriteRequest,
      spaceId: "tenant-75m-shadow-refresh",
      candidateId: "candidate-75m-shadow-refresh",
      sourceEpisodeIds: ["episode-refresh-1"],
      writtenAtMillis: 1_800_000_000_100,
    })
  );

  const replay = await Effect.runPromise(
    service.replayEval({
      spaceId: "tenant-75m-shadow-refresh",
      candidateId: "candidate-75m-shadow-refresh",
      evaluationPackId: "pack-75m-shadow-refresh",
      targetMemorySpace: "tenant-75m-shadow-refresh",
      evaluatedAtMillis: 1_800_000_000_200,
      qualityDelta: {
        successRateDelta: 0.12,
        reopenRateDelta: -0.03,
      },
      efficiencyDelta: {
        latencyP95DeltaMs: -80,
        tokenCostDelta: -12,
      },
      safetyDelta: {
        policyViolationsDelta: 0,
        hallucinationFlagDelta: 0,
      },
    })
  );

  const refreshed = await Effect.runPromise(
    service.shadowWrite({
      ...defaultShadowWriteRequest,
      spaceId: "tenant-75m-shadow-refresh",
      candidateId: "candidate-75m-shadow-refresh",
      sourceEpisodeIds: ["episode-refresh-1"],
      writtenAtMillis: 1_800_000_000_300,
    })
  );

  assert.equal(replay.gateStatus, "pass");
  assert.equal(refreshed.action, "updated");
  assert.equal(refreshed.candidate.latestReplayEvalId, null);
  assert.equal(refreshed.candidate.updatedAtMillis, 1_800_000_000_300);
});

test("ums-memory-75m: promote and demote transitions stay deterministic while enforcing idempotent no-op replays", async () => {
  const lifecycleServiceModule = await loadModules();
  const service =
    lifecycleServiceModule.makeDeterministicMemoryLifecycleService();

  await Effect.runPromise(
    service.shadowWrite({
      spaceId: "tenant-75m-promote",
      candidateId: "candidate-75m-promote",
      statement: "Ship replay-safe procedural rules only after canary pass.",
      scope: "global",
      sourceEpisodeIds: ["episode-promote-1"],
      expiresAtMillis: 1_900_000_000_000,
      writtenAtMillis: 1_800_000_001_000,
    })
  );

  await Effect.runPromise(
    service.replayEval({
      spaceId: "tenant-75m-promote",
      candidateId: "candidate-75m-promote",
      evaluationPackId: "pack-75m-promote",
      targetMemorySpace: "tenant-75m-promote",
      evaluatedAtMillis: 1_800_000_011_000,
      qualityDelta: {
        successRateDelta: 0.11,
        reopenRateDelta: -0.04,
      },
      efficiencyDelta: {
        latencyP95DeltaMs: -90,
        tokenCostDelta: -25,
      },
      safetyDelta: {
        policyViolationsDelta: 0,
        hallucinationFlagDelta: 0,
      },
    })
  );

  const promoted = await Effect.runPromise(
    service.promote({
      spaceId: "tenant-75m-promote",
      candidateId: "candidate-75m-promote",
      promotedAtMillis: 1_800_000_020_000,
    })
  );
  const promoteNoop = await Effect.runPromise(
    service.promote({
      spaceId: "tenant-75m-promote",
      candidateId: "candidate-75m-promote",
      promotedAtMillis: 1_800_000_020_001,
    })
  );

  assert.equal(promoted.action, "promoted");
  assert.equal(promoteNoop.action, "noop");
  assert.equal(promoted.ruleId, promoteNoop.ruleId);
  assert.equal(promoted.candidate.status, "promoted");

  const demoted = await Effect.runPromise(
    service.demote({
      spaceId: "tenant-75m-promote",
      candidateId: "candidate-75m-promote",
      demotedAtMillis: 1_800_000_030_000,
      reasonCodes: ["stability_check", "manual_override", "stability_check"],
    })
  );
  const demoteNoop = await Effect.runPromise(
    service.demote({
      spaceId: "tenant-75m-promote",
      candidateId: "candidate-75m-promote",
      demotedAtMillis: 1_800_000_030_001,
      reasonCodes: ["manual_override", "stability_check"],
    })
  );

  assert.equal(demoted.action, "demoted");
  assert.equal(demoted.candidate.status, "demoted");
  assert.ok(demoted.removedRuleId);
  assert.deepEqual(demoted.reasonCodes, ["manual_override", "stability_check"]);
  assert.equal(demoteNoop.action, "noop");
  assert.equal(demoteNoop.removedRuleId, null);
  assert.deepEqual(demoteNoop.reasonCodes, [
    "manual_override",
    "stability_check",
  ]);

  const demoteReplayCanonical = await Effect.runPromise(
    service.demote({
      spaceId: "tenant-75m-promote",
      candidateId: "candidate-75m-promote",
      demotedAtMillis: 1_800_000_030_000,
      reasonCodes: ["stability_check", "manual_override"],
    })
  );
  assert.deepEqual(demoteReplayCanonical, demoted);
});

test("ums-memory-75m: lifecycle contract decoding and gate errors are deterministic and typed", async () => {
  const lifecycleServiceModule = await loadModules();
  const service =
    lifecycleServiceModule.makeDeterministicMemoryLifecycleService();

  const invalidShadowEither = await runEither(
    service.shadowWrite({
      spaceId: "tenant-75m-errors",
      candidateId: "candidate-75m-errors",
      statement: "Invalid contract payload should fail decode.",
      scope: "user",
      sourceEpisodeIds: ["episode-error-1"],
      expiresAtMillis: 1_900_000_000_000,
      writtenAtMillis: "not-a-number",
    })
  );

  assert.equal(invalidShadowEither._tag, "Left");
  assert.equal(invalidShadowEither.left._tag, "ContractValidationError");
  assert.equal(
    invalidShadowEither.left.contract,
    "MemoryLifecycleShadowWriteRequest"
  );

  await Effect.runPromise(
    service.shadowWrite({
      spaceId: "tenant-75m-errors",
      candidateId: "candidate-75m-errors",
      statement: "Promotion must fail before replay evaluation passes.",
      scope: "user",
      sourceEpisodeIds: ["episode-error-1"],
      expiresAtMillis: 1_900_000_000_000,
      writtenAtMillis: 1_800_000_100_000,
    })
  );

  const promoteRequest = {
    spaceId: "tenant-75m-errors",
    candidateId: "candidate-75m-errors",
    promotedAtMillis: 1_800_000_110_000,
  };

  const promoteBeforeReplayA = await runEither(service.promote(promoteRequest));
  const promoteBeforeReplayB = await runEither(service.promote(promoteRequest));

  assert.equal(promoteBeforeReplayA._tag, "Left");
  assert.equal(promoteBeforeReplayB._tag, "Left");
  assert.equal(
    promoteBeforeReplayA.left._tag,
    "MemoryLifecyclePreconditionError"
  );
  assert.equal(
    promoteBeforeReplayB.left._tag,
    "MemoryLifecyclePreconditionError"
  );
  assert.equal(
    promoteBeforeReplayA.left.reasonCode,
    "PROMOTE_REQUIRES_PASSING_REPLAY_EVAL"
  );
  assert.equal(
    promoteBeforeReplayB.left.reasonCode,
    "PROMOTE_REQUIRES_PASSING_REPLAY_EVAL"
  );
});

test("ums-memory-75m: state isolation via lifecycle layer keeps fresh in-memory state per provide", async () => {
  const lifecycleServiceModule = await loadModules();
  const request = {
    ...defaultShadowWriteRequest,
    spaceId: "tenant-75m-layer-isolation",
    candidateId: "candidate-75m-layer-isolation",
  };

  const first = await runShadowWriteViaLayer(lifecycleServiceModule, request);
  const second = await runShadowWriteViaLayer(lifecycleServiceModule, request);

  assert.equal(first.action, "created");
  assert.equal(second.action, "created");
});

test("ums-memory-75m: response mutation does not corrupt internal candidate state", async () => {
  const lifecycleServiceModule = await loadModules();
  const service =
    lifecycleServiceModule.makeDeterministicMemoryLifecycleService();

  const shadow = await Effect.runPromise(
    service.shadowWrite({
      ...defaultShadowWriteRequest,
      spaceId: "tenant-75m-response-isolation",
      candidateId: "candidate-75m-response-isolation",
      sourceEpisodeIds: ["episode-response-1"],
    })
  );

  shadow.candidate.status = "promoted";
  shadow.candidate.statement = "mutated-local-response-only";

  const replay = await Effect.runPromise(
    service.replayEval({
      spaceId: "tenant-75m-response-isolation",
      candidateId: "candidate-75m-response-isolation",
      evaluationPackId: "pack-75m-response-isolation",
      targetMemorySpace: "tenant-75m-response-isolation",
      evaluatedAtMillis: 1_800_000_050_000,
      qualityDelta: {
        successRateDelta: 0.1,
        reopenRateDelta: -0.03,
      },
      efficiencyDelta: {
        latencyP95DeltaMs: -30,
        tokenCostDelta: -10,
      },
      safetyDelta: {
        policyViolationsDelta: 0,
        hallucinationFlagDelta: 0,
      },
    })
  );

  assert.equal(replay.gateStatus, "pass");
});

test("ums-memory-75m: candidate keying is collision-free across delimiter-like IDs", async () => {
  const lifecycleServiceModule = await loadModules();
  const service =
    lifecycleServiceModule.makeDeterministicMemoryLifecycleService();

  const first = await Effect.runPromise(
    service.shadowWrite({
      ...defaultShadowWriteRequest,
      spaceId: "tenant::alpha",
      candidateId: "candidate",
      sourceEpisodeIds: ["episode-collision-1"],
    })
  );

  const second = await Effect.runPromise(
    service.shadowWrite({
      ...defaultShadowWriteRequest,
      spaceId: "tenant",
      candidateId: "alpha::candidate",
      sourceEpisodeIds: ["episode-collision-2"],
    })
  );

  assert.equal(first.action, "created");
  assert.equal(second.action, "created");
  assert.notEqual(first.requestDigest, second.requestDigest);
});
