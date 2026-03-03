import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Effect, Schema } from "effect";

import {
  AgentIdSchema,
  MemoryIdSchema,
  SourceIdSchema,
  SpaceIdSchema,
  UserIdSchema,
  type MemoryId,
  type SpaceId,
} from "../libs/shared/src/effect/contracts/index.js";
import {
  makeDeterministicNcmHybridService,
  type NcmDecayTransitionRecord,
  type NcmFeedbackEvent,
} from "../libs/shared/src/effect/services/ncm-hybrid-service.js";

export interface NcmBenchmarkScenario {
  readonly scenarioId: string;
  readonly spaceId: SpaceId;
  readonly memoryId: MemoryId;
  readonly currentWeight: number;
  readonly recentRetrievalCount: number;
  readonly lastRetrievedAtMillis: number;
  readonly nowMillis: number;
  readonly feedbackEvents: readonly NcmFeedbackEvent[];
}

export interface NcmBenchmarkSummary {
  readonly scenarioCount: number;
  readonly meanWeight: number;
  readonly highValueCount: number;
  readonly decayActionCount: number;
  readonly reheatActionCount: number;
}

export interface NcmHybridBenchmarkReport {
  readonly schemaVersion: "ncm_hybrid_benchmark.v1";
  readonly generatedAt: string;
  readonly baseline: NcmBenchmarkSummary;
  readonly hybrid: NcmBenchmarkSummary;
  readonly deltas: {
    readonly meanWeightDelta: number;
    readonly highValueCountDelta: number;
    readonly decayActionDelta: number;
    readonly reheatActionDelta: number;
  };
  readonly scenarios: readonly {
    readonly scenarioId: string;
    readonly baselineWeight: number;
    readonly hybridWeight: number;
    readonly netDelta: number;
    readonly action: "decay" | "reheat" | "stable";
  }[];
}

interface EvaluatedScenario {
  readonly scenarioId: string;
  readonly baselineWeight: number;
  readonly hybridWeight: number;
  readonly netDelta: number;
  readonly action: "decay" | "reheat" | "stable";
}

const decodeSpaceId = Schema.decodeUnknownSync(SpaceIdSchema);
const decodeMemoryId = Schema.decodeUnknownSync(MemoryIdSchema);
const decodeUserId = Schema.decodeUnknownSync(UserIdSchema);
const decodeAgentId = Schema.decodeUnknownSync(AgentIdSchema);
const decodeSourceId = Schema.decodeUnknownSync(SourceIdSchema);

const asSpaceId = (value: string): SpaceId => decodeSpaceId(value);
const asMemoryId = (value: string): MemoryId => decodeMemoryId(value);
const asUserId = (value: string) => decodeUserId(value);
const asAgentId = (value: string) => decodeAgentId(value);
const asSourceId = (value: string) => decodeSourceId(value);

const benchmarkScenarios: readonly NcmBenchmarkScenario[] = Object.freeze([
  {
    scenarioId: "scenario-helpful-retrieval",
    spaceId: asSpaceId("tenant_alpha"),
    memoryId: asMemoryId("mem_alpha_1"),
    currentWeight: 0.48,
    recentRetrievalCount: 4,
    lastRetrievedAtMillis: 1_700_000_000_000,
    nowMillis: 1_700_050_000_000,
    feedbackEvents: [
      {
        feedbackId: "fb-alpha-1",
        spaceId: asSpaceId("tenant_alpha"),
        memoryId: asMemoryId("mem_alpha_1"),
        source: "human_feedback",
        signal: "helpful",
        occurredAtMillis: 1_700_010_000_000,
        provenance: {
          tenantId: asSpaceId("tenant_alpha"),
          userId: asUserId("user_alpha_1"),
          sourceId: asSourceId("chat_export"),
        },
      },
      {
        feedbackId: "fb-alpha-2",
        spaceId: asSpaceId("tenant_alpha"),
        memoryId: asMemoryId("mem_alpha_1"),
        source: "agent_outcome",
        signal: "helpful",
        occurredAtMillis: 1_700_020_000_000,
        provenance: {
          tenantId: asSpaceId("tenant_alpha"),
          agentId: asAgentId("agent_codex_1"),
          sourceId: asSourceId("runtime_outcome"),
        },
      },
    ],
  },
  {
    scenarioId: "scenario-failure-heavy",
    spaceId: asSpaceId("tenant_alpha"),
    memoryId: asMemoryId("mem_alpha_2"),
    currentWeight: 0.71,
    recentRetrievalCount: 1,
    lastRetrievedAtMillis: 1_699_000_000_000,
    nowMillis: 1_700_050_000_000,
    feedbackEvents: [
      {
        feedbackId: "fb-beta-1",
        spaceId: asSpaceId("tenant_alpha"),
        memoryId: asMemoryId("mem_alpha_2"),
        source: "agent_outcome",
        signal: "failure",
        occurredAtMillis: 1_700_030_000_000,
        provenance: {
          tenantId: asSpaceId("tenant_alpha"),
          agentId: asAgentId("agent_gemini_1"),
          sourceId: asSourceId("runtime_outcome"),
        },
      },
      {
        feedbackId: "fb-beta-2",
        spaceId: asSpaceId("tenant_alpha"),
        memoryId: asMemoryId("mem_alpha_2"),
        source: "human_feedback",
        signal: "failure",
        occurredAtMillis: 1_700_040_000_000,
        provenance: {
          tenantId: asSpaceId("tenant_alpha"),
          userId: asUserId("user_alpha_2"),
          sourceId: asSourceId("manual_review"),
        },
      },
    ],
  },
  {
    scenarioId: "scenario-mixed",
    spaceId: asSpaceId("tenant_alpha"),
    memoryId: asMemoryId("mem_alpha_3"),
    currentWeight: 0.59,
    recentRetrievalCount: 2,
    lastRetrievedAtMillis: 1_700_020_000_000,
    nowMillis: 1_700_050_000_000,
    feedbackEvents: [
      {
        feedbackId: "fb-gamma-1",
        spaceId: asSpaceId("tenant_alpha"),
        memoryId: asMemoryId("mem_alpha_3"),
        source: "agent_outcome",
        signal: "helpful",
        occurredAtMillis: 1_700_025_000_000,
        provenance: {
          tenantId: asSpaceId("tenant_alpha"),
          agentId: asAgentId("agent_codex_2"),
          sourceId: asSourceId("runtime_outcome"),
        },
      },
      {
        feedbackId: "fb-gamma-2",
        spaceId: asSpaceId("tenant_alpha"),
        memoryId: asMemoryId("mem_alpha_3"),
        source: "agent_outcome",
        signal: "failure",
        occurredAtMillis: 1_700_035_000_000,
        provenance: {
          tenantId: asSpaceId("tenant_alpha"),
          agentId: asAgentId("agent_codex_2"),
          sourceId: asSourceId("runtime_outcome"),
        },
      },
    ],
  },
]);

const round6 = (value: number): number => Number(value.toFixed(6));

const summarize = (
  items: readonly {
    readonly hybridWeight: number;
    readonly action: "decay" | "reheat" | "stable";
  }[]
): NcmBenchmarkSummary => {
  const scenarioCount = items.length;
  const meanWeight =
    scenarioCount === 0
      ? 0
      : round6(
          items.reduce((total, item) => total + item.hybridWeight, 0) /
            scenarioCount
        );
  const highValueCount = items.filter(
    (item) => item.hybridWeight >= 0.6
  ).length;
  const decayActionCount = items.filter(
    (item) => item.action === "decay"
  ).length;
  const reheatActionCount = items.filter(
    (item) => item.action === "reheat"
  ).length;

  return Object.freeze({
    scenarioCount,
    meanWeight,
    highValueCount,
    decayActionCount,
    reheatActionCount,
  });
};

export const runCassVsNcmHybridBenchmark = async (
  scenarios: readonly NcmBenchmarkScenario[] = benchmarkScenarios
): Promise<NcmHybridBenchmarkReport> => {
  const service = makeDeterministicNcmHybridService();

  const evaluated: EvaluatedScenario[] = [];
  for (const scenario of scenarios) {
    let events: readonly NcmFeedbackEvent[] = [];
    let transitions: readonly NcmDecayTransitionRecord[] = [];
    let currentWeight = scenario.currentWeight;
    for (const event of scenario.feedbackEvents) {
      const response = await Effect.runPromise(
        service.ingestFeedback({
          event,
          currentWeight,
          recentRetrievalCount: scenario.recentRetrievalCount,
          lastRetrievedAtMillis: scenario.lastRetrievedAtMillis,
          nowMillis: scenario.nowMillis,
          existingEvents: events,
          existingTransitions: transitions,
        })
      );
      events = response.events;
      transitions = response.transitions;
      currentWeight = response.computedWeight;
    }

    const transition = transitions.at(-1) ?? null;
    evaluated.push(
      Object.freeze({
        scenarioId: scenario.scenarioId,
        baselineWeight: round6(scenario.currentWeight),
        hybridWeight: round6(currentWeight),
        netDelta: round6(currentWeight - scenario.currentWeight),
        action: transition?.action ?? "stable",
      })
    );
  }

  const baselineSummary = summarize(
    evaluated.map((entry) =>
      Object.freeze({
        hybridWeight: entry.baselineWeight,
        action: "stable" as const,
      })
    )
  );
  const hybridSummary = summarize(evaluated);

  return Object.freeze({
    schemaVersion: "ncm_hybrid_benchmark.v1",
    generatedAt: new Date(0).toISOString(),
    baseline: baselineSummary,
    hybrid: hybridSummary,
    deltas: Object.freeze({
      meanWeightDelta: round6(
        hybridSummary.meanWeight - baselineSummary.meanWeight
      ),
      highValueCountDelta:
        hybridSummary.highValueCount - baselineSummary.highValueCount,
      decayActionDelta: hybridSummary.decayActionCount,
      reheatActionDelta: hybridSummary.reheatActionCount,
    }),
    scenarios: Object.freeze(
      [...evaluated].sort((left, right) =>
        left.scenarioId.localeCompare(right.scenarioId)
      )
    ),
  });
};

interface ParsedArgs {
  readonly outputPath: string | null;
  readonly compact: boolean;
  readonly help: boolean;
}

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let outputPath: string | null = null;
  let compact = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--output") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --output.");
      }
      outputPath = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (token === "--compact") {
      compact = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return Object.freeze({
    outputPath,
    compact,
    help,
  });
};

const usage = (): string =>
  [
    "Usage:",
    "  node --import tsx scripts/benchmark-cass-vs-ncm-hybrid.ts [--output <path>] [--compact]",
    "",
    "Options:",
    "  --output <path>   Write benchmark report JSON to a file.",
    "  --compact         Emit compact JSON.",
    "  --help, -h        Show this help.",
  ].join("\n");

export const main = async (
  argv: readonly string[] = process.argv.slice(2)
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = await runCassVsNcmHybridBenchmark();
  const payload = args.compact
    ? JSON.stringify(report)
    : `${JSON.stringify(report, null, 2)}\n`;

  if (args.outputPath !== null) {
    await writeFile(args.outputPath, payload, "utf8");
    process.stdout.write(`${args.outputPath}\n`);
    return;
  }
  process.stdout.write(payload);
};

const importMeta = import.meta as ImportMeta & { main?: boolean };
const isMainModule =
  (typeof importMeta.main === "boolean" && importMeta.main) ||
  importMeta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
