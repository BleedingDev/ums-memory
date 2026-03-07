import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SUCCESS_TOKENS = new Set([
  "ok",
  "success",
  "succeeded",
  "accepted",
  "created",
  "updated",
  "noop",
  "done",
  "allow",
  "deny",
  "review",
  "pass",
  "allowed",
  "denied",
  "not_found",
]);
const FAILURE_TOKENS = new Set([
  "error",
  "failed",
  "failure",
  "timeout",
  "exception",
]);

const OPERATION_KEYS = [
  "operation",
  "op",
  "action",
  "eventType",
  "event_type",
  "type",
  "name",
];
const LATENCY_KEYS = [
  "latencyMs",
  "latency_ms",
  "durationMs",
  "duration_ms",
  "elapsedMs",
  "elapsed_ms",
  "latency",
];
const FAILURE_CODE_KEYS = [
  "failureCode",
  "failure_code",
  "errorCode",
  "error_code",
  "code",
  ["error", "code"],
];
const POLICY_KEYS = [
  "policyDecision",
  "policyOutcome",
  ["policy", "decision"],
  ["policy", "outcome"],
];
const ANOMALY_KEYS = [
  "anomalyType",
  "anomaly_type",
  ["anomaly", "type"],
  "anomalyCode",
  "anomaly_code",
];
const TIMESTAMP_KEYS = ["timestamp", "time", "ts", "createdAt", "created_at"];
const OUTCOME_KEYS = [
  "status",
  "result",
  "requestStatus",
  "request_status",
  "outcome",
];
const TEAM_KEYS = ["team", "teamId", "team_id"];
const PROJECT_KEYS = ["project", "projectId", "project_id"];
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;

type JsonRecord = Record<string, unknown>;
type KeyPath = string | readonly string[];
type TelemetryEvents = JsonRecord[] & { invalidCount?: number };

interface PerOperationTotals {
  requestVolume: number;
  successCount: number;
  failureCount: number;
  latencies: number[];
  failureCodeHistogram: Map<string, number>;
}

function compareStrings(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeToken(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
}

function normalizeOperation(value: unknown) {
  const token = normalizeToken(value);
  return token || "any";
}

function normalizeFailureCode(value: unknown) {
  const token = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
  return token || "UNKNOWN_FAILURE";
}

function normalizeSliceLabel(value: unknown, fallback: string) {
  const token = normalizeToken(value);
  return token || fallback;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toIsoTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const normalized = value.trim();
  if (!ISO_TIMESTAMP_PATTERN.test(normalized)) {
    return null;
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function getValue(record: JsonRecord, key: KeyPath) {
  if (Array.isArray(key)) {
    let current: unknown = record;
    for (const segment of key) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return;
      }
      current = (current as JsonRecord)[segment];
    }
    return current;
  }
  if (typeof key === "string") {
    return record[key];
  }
  return;
}

function pickFirst(record: JsonRecord, keys: readonly KeyPath[]) {
  for (const key of keys) {
    const value = getValue(record, key);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return;
}

function parseTelemetryEvent(line: string, lineNumber: number): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JSON telemetry event on line ${lineNumber}: ${message}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Telemetry event on line ${lineNumber} must be a JSON object.`
    );
  }
  return parsed as JsonRecord;
}

function attachInvalidCount<T>(
  events: T[],
  invalidCount: number
): T[] & { invalidCount: number } {
  Object.defineProperty(events, "invalidCount", {
    value: invalidCount,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return events as T[] & { invalidCount: number };
}

export function parseTelemetryEvents(
  source: unknown,
  { allowInvalid = false }: { allowInvalid?: boolean } = {}
): TelemetryEvents {
  if (Array.isArray(source)) {
    const events: JsonRecord[] = [];
    let invalidCount = 0;
    for (let index = 0; index < source.length; index += 1) {
      const event = source[index];
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        if (allowInvalid) {
          invalidCount += 1;
          continue;
        }
        throw new Error(
          `Telemetry array entry ${index} must be a JSON object.`
        );
      }
      events.push(event as JsonRecord);
    }
    return attachInvalidCount(events, invalidCount);
  }

  const text = String(source ?? "");
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON telemetry array: ${message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        "Telemetry input must be a JSON array or NDJSON stream of objects."
      );
    }
    return parseTelemetryEvents(parsed, { allowInvalid });
  }

  const events: JsonRecord[] = [];
  let invalidCount = 0;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    if (!line) {
      continue;
    }
    try {
      events.push(parseTelemetryEvent(line, index + 1));
    } catch (error) {
      if (!allowInvalid) {
        throw error;
      }
      invalidCount += 1;
    }
  }
  return attachInvalidCount(events, invalidCount);
}

function parseOutcomeToken(value: unknown) {
  if (typeof value === "string") {
    const token = normalizeToken(value);
    if (!token) {
      return null;
    }
    if (token === "true" || token === "1") {
      return true;
    }
    if (token === "false" || token === "0") {
      return false;
    }
    if (SUCCESS_TOKENS.has(token)) {
      return true;
    }
    if (FAILURE_TOKENS.has(token)) {
      return false;
    }
  }
  return null;
}

function classifySuccess(record: JsonRecord, index: number) {
  const explicit = pickFirst(record, [
    "success",
    "ok",
    "isSuccess",
    "is_success",
  ]);
  if (typeof explicit === "boolean") {
    return explicit;
  }
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    if (explicit === 1) {
      return true;
    }
    if (explicit === 0) {
      return false;
    }
    throw new Error(
      `Telemetry event at index ${index} has unsupported explicit outcome value: ${JSON.stringify(explicit)}`
    );
  }
  if (typeof explicit === "string") {
    const parsedExplicit = parseOutcomeToken(explicit);
    if (typeof parsedExplicit === "boolean") {
      return parsedExplicit;
    }
    throw new Error(
      `Telemetry event at index ${index} has unsupported explicit outcome value: ${JSON.stringify(explicit)}`
    );
  }
  if (explicit !== undefined && explicit !== null) {
    throw new Error(
      `Telemetry event at index ${index} has unsupported explicit outcome value: ${JSON.stringify(explicit)}`
    );
  }

  const outcomeRaw = pickFirst(record, OUTCOME_KEYS);
  if (typeof outcomeRaw === "boolean") {
    return outcomeRaw;
  }
  if (typeof outcomeRaw === "number" && Number.isFinite(outcomeRaw)) {
    if (outcomeRaw === 1) {
      return true;
    }
    if (outcomeRaw === 0) {
      return false;
    }
    if (outcomeRaw >= 200 && outcomeRaw < 400) {
      return true;
    }
    if (outcomeRaw >= 400) {
      return false;
    }
    throw new Error(
      `Telemetry event at index ${index} has unsupported outcome token: ${JSON.stringify(outcomeRaw)}`
    );
  }
  const parsedOutcome = parseOutcomeToken(outcomeRaw);
  if (typeof parsedOutcome === "boolean") {
    return parsedOutcome;
  }
  if (outcomeRaw !== undefined && outcomeRaw !== null) {
    throw new Error(
      `Telemetry event at index ${index} has unsupported outcome token: ${JSON.stringify(outcomeRaw)}`
    );
  }

  const failureCode = pickFirst(record, FAILURE_CODE_KEYS);
  if (typeof failureCode === "string" && failureCode.trim()) {
    throw new Error(
      `Telemetry event at index ${index} is missing outcome indicator (success/ok/status/result).`
    );
  }

  const errorObject = pickFirst(record, ["error"]);
  if (errorObject && typeof errorObject === "object") {
    throw new Error(
      `Telemetry event at index ${index} is missing outcome indicator (success/ok/status/result).`
    );
  }

  throw new Error(
    `Telemetry event at index ${index} is missing outcome indicator (success/ok/status/result).`
  );
}

function extractLatencyMs(record: JsonRecord, index: number) {
  const raw = pickFirst(record, LATENCY_KEYS);
  const parsed = toNumber(raw);
  if (parsed === null || parsed < 0) {
    throw new Error(
      `Telemetry event at index ${index} must include a non-negative latency field.`
    );
  }
  return Number(parsed.toFixed(3));
}

function extractFailureCode(record: JsonRecord, success: boolean) {
  if (success) {
    return null;
  }
  return normalizeFailureCode(pickFirst(record, FAILURE_CODE_KEYS));
}

function extractOperation(record: JsonRecord, index: number) {
  const operation = normalizeOperation(pickFirst(record, OPERATION_KEYS));
  if (operation === "any") {
    throw new Error(
      `Telemetry event at index ${index} is missing required field: operation.`
    );
  }
  return operation;
}

function extractPolicyDecision(record: JsonRecord) {
  const value = pickFirst(record, POLICY_KEYS);
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeSliceLabel(value, "unknown_policy");
}

function extractAnomalyType(record: JsonRecord) {
  const value = pickFirst(record, ANOMALY_KEYS);
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeSliceLabel(value, "unknown_anomaly");
}

function extractTimestamp(record: JsonRecord, index: number) {
  const timestamp = toIsoTimestamp(pickFirst(record, TIMESTAMP_KEYS));
  if (!timestamp) {
    throw new Error(
      `Telemetry event at index ${index} is missing required field: timestamp (RFC3339 format required).`
    );
  }
  return timestamp;
}

function extractTeam(record: JsonRecord, index: number) {
  const team = normalizeSliceLabel(pickFirst(record, TEAM_KEYS), "");
  if (!team) {
    throw new Error(
      `Telemetry event at index ${index} is missing required field: team.`
    );
  }
  return team;
}

function extractProject(record: JsonRecord, index: number) {
  const project = normalizeSliceLabel(pickFirst(record, PROJECT_KEYS), "");
  if (!project) {
    throw new Error(
      `Telemetry event at index ${index} is missing required field: project.`
    );
  }
  return project;
}

function incrementHistogram(histogram: Map<string, number>, key: string) {
  histogram.set(key, (histogram.get(key) || 0) + 1);
}

function histogramToSortedObject(histogram: Map<string, number>) {
  const entries = [...histogram.entries()].sort((a, b) =>
    compareStrings(a[0], b[0])
  );
  return Object.fromEntries(entries);
}

function roundRate(count: number, total: number) {
  if (total <= 0) {
    return 0;
  }
  return Number((count / total).toFixed(6));
}

function computeP95(latencies: number[]) {
  if (latencies.length === 0) {
    return null;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function computeWindow(timestamps: string[]) {
  if (timestamps.length === 0) {
    return { start: null, end: null };
  }
  const sorted = [...timestamps].sort((a, b) => compareStrings(a, b));
  return {
    start: sorted[0],
    end: sorted.at(-1),
  };
}

function summarizePerOperation(
  operationTotals: Map<string, PerOperationTotals>
) {
  const entries = [...operationTotals.entries()].sort((a, b) =>
    compareStrings(a[0], b[0])
  );
  return Object.fromEntries(
    entries.map(([operation, stats]) => [
      operation,
      {
        requestVolume: stats.requestVolume,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        successRate: roundRate(stats.successCount, stats.requestVolume),
        failureRate: roundRate(stats.failureCount, stats.requestVolume),
        p95LatencyMs: computeP95(stats.latencies),
        latencySampleSize: stats.latencies.length,
        failureCodeHistogram: histogramToSortedObject(
          stats.failureCodeHistogram
        ),
      },
    ])
  );
}

export function generatePilotRolloutReport(
  events: readonly unknown[] & { invalidCount?: number },
  { allowInvalid = false } = {}
) {
  if (!Array.isArray(events)) {
    throw new Error("Expected telemetry events to be an array.");
  }
  if (typeof allowInvalid !== "boolean") {
    throw new Error("allowInvalid option must be a boolean.");
  }

  let successCount = 0;
  let failureCount = 0;

  const operationHistogram = new Map<string, number>();
  const failureCodeHistogram = new Map<string, number>();
  const policyDecisionHistogram = new Map<string, number>();
  const anomalyHistogram = new Map<string, number>();
  const teamHistogram = new Map<string, number>();
  const projectHistogram = new Map<string, number>();
  const perOperation = new Map<string, PerOperationTotals>();

  const latencies: number[] = [];
  const timestamps: string[] = [];
  const eventsInvalidCountRaw = Number(
    (events as { invalidCount?: number }).invalidCount ?? 0
  );
  const parsedInvalidCount =
    Number.isInteger(eventsInvalidCountRaw) && eventsInvalidCountRaw > 0
      ? eventsInvalidCountRaw
      : 0;
  let invalidEventCount = parsedInvalidCount;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(
        `Telemetry event at index ${index} must be a JSON object.`
      );
    }

    let success;
    let operation;
    let failureCode;
    let policyDecision;
    let anomalyType;
    let latencyMs;
    let timestamp;
    let team;
    let project;
    try {
      success = classifySuccess(event, index);
      operation = extractOperation(event, index);
      failureCode = extractFailureCode(event, success);
      policyDecision = extractPolicyDecision(event);
      anomalyType = extractAnomalyType(event);
      latencyMs = extractLatencyMs(event, index);
      timestamp = extractTimestamp(event, index);
      team = extractTeam(event, index);
      project = extractProject(event, index);
    } catch (error) {
      if (!allowInvalid) {
        throw error;
      }
      invalidEventCount += 1;
      continue;
    }

    incrementHistogram(operationHistogram, operation);
    incrementHistogram(teamHistogram, team);
    incrementHistogram(projectHistogram, project);

    let opTotals = perOperation.get(operation);
    if (!opTotals) {
      opTotals = {
        requestVolume: 0,
        successCount: 0,
        failureCount: 0,
        latencies: [],
        failureCodeHistogram: new Map<string, number>(),
      };
      perOperation.set(operation, opTotals);
    }
    opTotals.requestVolume += 1;
    opTotals.latencies.push(latencyMs);

    if (success) {
      successCount += 1;
      opTotals.successCount += 1;
    } else {
      failureCount += 1;
      incrementHistogram(
        failureCodeHistogram,
        failureCode ?? "UNKNOWN_FAILURE"
      );
      opTotals.failureCount += 1;
      incrementHistogram(
        opTotals.failureCodeHistogram,
        failureCode ?? "UNKNOWN_FAILURE"
      );
    }
    if (policyDecision) {
      incrementHistogram(policyDecisionHistogram, policyDecision);
    }
    if (anomalyType) {
      incrementHistogram(anomalyHistogram, anomalyType);
    }
    latencies.push(latencyMs);
    timestamps.push(timestamp);
  }

  const requestVolume = successCount + failureCount;
  const p95LatencyMs = computeP95(latencies);
  const window = computeWindow(timestamps);

  return {
    schemaVersion: "pilot_rollout_report.v1",
    requestVolume,
    successCount,
    failureCount,
    successRate: roundRate(successCount, requestVolume),
    failureRate: roundRate(failureCount, requestVolume),
    p95LatencyMs,
    latencySampleSize: latencies.length,
    operationHistogram: histogramToSortedObject(operationHistogram),
    failureCodeHistogram: histogramToSortedObject(failureCodeHistogram),
    policyDecisionHistogram: histogramToSortedObject(policyDecisionHistogram),
    anomalyHistogram: histogramToSortedObject(anomalyHistogram),
    teamHistogram: histogramToSortedObject(teamHistogram),
    projectHistogram: histogramToSortedObject(projectHistogram),
    perOperation: summarizePerOperation(perOperation),
    invalidEventCount,
    telemetryWindow: window,
  };
}

function parseArgs(argv: readonly string[]) {
  const parsed = {
    input: "",
    output: "",
    compact: false,
    allowInvalid: false,
    help: false,
  };

  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--input") {
      parsed.input = (args.shift() ?? "").trim();
      continue;
    }
    if (token === "--output") {
      parsed.output = (args.shift() ?? "").trim();
      continue;
    }
    if (token === "--compact") {
      parsed.compact = true;
      continue;
    }
    if (token === "--allow-invalid") {
      parsed.allowInvalid = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!parsed.help && !parsed.input) {
    throw new Error("Missing required --input <path|-> argument.");
  }

  return parsed;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/generate-pilot-rollout-report.ts --input <path|-> [--output <path>] [--compact]",
      "  bun scripts/generate-pilot-rollout-report.ts --input <path|-> [--output <path>] [--compact] [--allow-invalid]",
      "",
      "Input formats:",
      "  - NDJSON (one telemetry object per line)",
      "  - JSON array of telemetry objects",
      "",
      "Notes:",
      "  --allow-invalid skips malformed NDJSON lines and invalid event records.",
      "  Malformed top-level JSON arrays are always treated as fatal input errors.",
      "",
      "Examples:",
      "  bun scripts/generate-pilot-rollout-report.ts --input ops/pilot-rollout/pilot-a/telemetry.ndjson",
      "  bun scripts/generate-pilot-rollout-report.ts --input telemetry.json --output docs/reports/pilot-summary.json",
      "  bun scripts/generate-pilot-rollout-report.ts --input telemetry.ndjson --allow-invalid",
    ].join("\n") + "\n"
  );
}

async function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      content += chunk;
    });
    process.stdin.on("end", () => {
      resolvePromise(content);
    });
    process.stdin.on("error", (error) => {
      reject(error);
    });
  });
}

async function readInput(inputPath: string) {
  if (inputPath === "-") {
    return readStdin();
  }
  return readFileSync(resolve(process.cwd(), inputPath), "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const rawInput = await readInput(parsed.input);
  const events = parseTelemetryEvents(rawInput, {
    allowInvalid: parsed.allowInvalid,
  });
  const report = generatePilotRolloutReport(events, {
    allowInvalid: parsed.allowInvalid,
  });
  const output = `${JSON.stringify(report, null, parsed.compact ? 0 : 2)}\n`;

  if (parsed.output) {
    const resolvedPath = resolve(process.cwd(), parsed.output);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, output, "utf8");
  }

  process.stdout.write(output);
  return 0;
}

const IS_ENTRYPOINT = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (IS_ENTRYPOINT) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `generate-pilot-rollout-report failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
