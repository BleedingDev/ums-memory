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
import { Effect } from "effect";
import ts from "typescript";

const effectModuleDirectory = new URL(
  "../../libs/shared/src/effect/",
  import.meta.url
);

const transpileEffectModule = (
  sourceFilename: string,
  tempDirectory: string
): void => {
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
  "services/ncm-hybrid-service.ts",
]);

let modulesPromise: Promise<{
  ncmHybridServiceModule: Record<string, any>;
}> | null = null;
let transpiledDirectoryPath: string | null = null;

const loadModules = async (): Promise<{
  ncmHybridServiceModule: Record<string, any>;
}> => {
  if (modulesPromise === null) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(
      join(tempRootDirectory, "ums-memory-ncm-hybrid-service-")
    );

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const moduleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/ncm-hybrid-service.js")
    ).href;
    modulesPromise = import(moduleUrl).then((ncmHybridServiceModule) => ({
      ncmHybridServiceModule,
    }));
  }
  return modulesPromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath !== null) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

test("ums-memory-2i1.2: feedback ingestion maps helpful/failure into deterministic reinforcement with replay safety", async () => {
  const { ncmHybridServiceModule } = await loadModules();
  const service = (
    ncmHybridServiceModule["makeDeterministicNcmHybridService"] as any
  )() as any;

  const baseRequest = {
    event: {
      feedbackId: "fb-1",
      spaceId: "tenant_alpha",
      memoryId: "mem-guideline-1",
      source: "human_feedback",
      signal: "helpful",
      actorUserId: "user_alpha",
      note: "Saved significant rework time.",
      idempotencyKey: "idem-feedback-1",
      occurredAtMillis: 1_700_000_000_000,
      provenance: {
        tenantId: "tenant_alpha",
        agentId: "agent_codex_1",
        conversationId: "conv_123",
        messageId: "msg_99",
        sourceId: "chat_export",
      },
    },
    currentWeight: 0.5,
    recentRetrievalCount: 3,
    nowMillis: 1_700_000_100_000,
    existingEvents: [],
    existingTransitions: [],
  };

  const created = (await Effect.runPromise(
    service.ingestFeedback(baseRequest)
  )) as any;
  assert.equal(created.action, "created");
  assert.equal(created.idempotentReplay, false);
  assert.equal(created.events.length, 1);
  assert.equal(created.transitions.length, 1);
  assert.equal(created.computedWeight > 0.5, true);
  assert.equal(created.transition?.action, "reheat");

  const replayed = (await Effect.runPromise(
    service.ingestFeedback({
      ...baseRequest,
      existingEvents: created.events,
      existingTransitions: created.transitions,
    })
  )) as any;
  assert.equal(replayed.action, "replayed");
  assert.equal(replayed.idempotentReplay, true);
  assert.deepEqual(replayed.events, created.events);
  assert.deepEqual(replayed.transitions, created.transitions);
});

test("ums-memory-2i1.3: deterministic decay/reheating policy remains stable across equivalent signal ordering", async () => {
  const { ncmHybridServiceModule } = await loadModules();
  const service = (
    ncmHybridServiceModule["makeDeterministicNcmHybridService"] as any
  )() as any;

  const requestA = {
    spaceId: "tenant_alpha",
    memoryId: "mem-guideline-2",
    nowMillis: 1_700_100_000_000,
    currentWeight: 0.74,
    lastRetrievedAtMillis: 1_700_000_000_000,
    recentRetrievalCount: 2,
    feedbackSignals: ["helpful", "failure", "helpful"],
  };
  const requestB = {
    ...requestA,
    feedbackSignals: ["helpful", "helpful", "failure"],
  };

  const responseA = (await Effect.runPromise(
    service.evaluateDecayReheatPolicy(requestA)
  )) as any;
  const responseB = (await Effect.runPromise(
    service.evaluateDecayReheatPolicy(requestB)
  )) as any;

  assert.deepEqual(responseA, responseB);
  assert.equal(responseA.toWeight >= 0 && responseA.toWeight <= 1, true);
});

test("ums-memory-2i1.4: bounded operator controls apply replay-safe manual weight tuning", async () => {
  const { ncmHybridServiceModule } = await loadModules();
  const service = (
    ncmHybridServiceModule["makeDeterministicNcmHybridService"] as any
  )() as any;

  const request = {
    adjustmentId: "adj-001",
    spaceId: "tenant_alpha",
    memoryId: "mem-guideline-3",
    actorUserId: "user_admin",
    reason: "Critical best-practice confirmed.",
    delta: 0.2,
    currentWeight: 0.45,
    nowMillis: 1_700_200_000_000,
    existingAdjustments: [],
  };

  const applied = (await Effect.runPromise(
    service.applyOperatorWeightAdjustment(request)
  )) as any;
  assert.equal(applied.action, "applied");
  assert.equal(applied.tunedWeight, 0.65);

  const replayed = (await Effect.runPromise(
    service.applyOperatorWeightAdjustment({
      ...request,
      existingAdjustments: applied.adjustments,
    })
  )) as any;
  assert.equal(replayed.action, "replayed");
  assert.equal(replayed.idempotentReplay, true);
  assert.equal(replayed.tunedWeight, applied.tunedWeight);
});

test("ums-memory-2i1.6: memory console signal feed includes lineage-backed reinforcement and decay entries", async () => {
  const { ncmHybridServiceModule } = await loadModules();
  const service = (
    ncmHybridServiceModule["makeDeterministicNcmHybridService"] as any
  )() as any;

  const first = (await Effect.runPromise(
    service.ingestFeedback({
      event: {
        feedbackId: "fb-console-1",
        spaceId: "tenant_alpha",
        memoryId: "mem-console-1",
        source: "agent_outcome",
        signal: "failure",
        actorAgentId: "agent_gemini_2",
        note: "Outcome failed policy gate.",
        occurredAtMillis: 1_700_300_000_000,
        provenance: {
          tenantId: "tenant_alpha",
          userId: "user_alpha",
          agentId: "agent_gemini_2",
          conversationId: "conv_console_1",
          messageId: "msg_console_1",
          sourceId: "api_runtime",
          batchId: "batch-7",
        },
      },
      currentWeight: 0.66,
      nowMillis: 1_700_300_000_000,
      recentRetrievalCount: 0,
      existingEvents: [],
      existingTransitions: [],
    })
  )) as any;

  const feed = (await Effect.runPromise(
    service.getConsoleSignals({
      spaceId: "tenant_alpha",
      feedbackEvents: first.events,
      decayTransitions: first.transitions,
      operatorAdjustments: [],
      limit: 20,
    })
  )) as any;

  assert.equal(feed.totalFeedbackEvents, 1);
  assert.equal(feed.totalDecayTransitions, 1);
  assert.equal(feed.entries.length >= 2, true);
  assert.equal(
    feed.entries.some((entry: any) =>
      entry.lineageRefs.includes("agent:agent_gemini_2")
    ),
    true
  );
  assert.equal(
    feed.entries.some((entry: any) =>
      entry.lineageRefs.includes("conversation:conv_console_1")
    ),
    true
  );
});

test("ums-memory-2i1.7: tenant policy knobs fail-closed when NCM ingestion is disabled", async () => {
  const { ncmHybridServiceModule } = await loadModules();
  const service = (
    ncmHybridServiceModule["makeDeterministicNcmHybridService"] as any
  )({
    defaultPolicy: {
      tenantId: "tenant_alpha",
      updatedAtMillis: 1_700_400_000_000,
      knobs: {
        enableFeedbackIngestion: false,
        enableDeterministicDecayReheat: true,
        enableManualWeightTuning: true,
        failClosed: true,
        maxManualWeightDelta: 0.3,
        helpfulSignalBoost: 0.08,
        failureSignalPenalty: 0.2,
        retrievalReheatBoost: 0.035,
        timeDecayFactor: 0.025,
        halfLifeDays: 21,
      },
    },
  });

  await assert.rejects(
    () =>
      Effect.runPromise(
        service.ingestFeedback({
          event: {
            feedbackId: "fb-blocked-1",
            spaceId: "tenant_alpha",
            memoryId: "mem-blocked-1",
            source: "human_feedback",
            signal: "helpful",
            occurredAtMillis: 1_700_400_000_000,
            provenance: {
              tenantId: "tenant_alpha",
            },
          },
          currentWeight: 0.4,
          nowMillis: 1_700_400_000_000,
          existingEvents: [],
          existingTransitions: [],
        })
      ),
    (error) => {
      const candidate = error as {
        readonly _tag?: any;
        readonly contract?: any;
      };
      return (
        candidate._tag === "ContractValidationError" &&
        candidate.contract === "NcmFeedbackIngestionRequest"
      );
    }
  );
});
