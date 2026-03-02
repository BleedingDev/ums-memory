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
]);
const FAILURE_TOKENS = new Set(["error", "failed", "failure", "timeout", "exception"]);

const OPERATION_KEYS = ["operation", "op", "action", "eventType", "event_type", "type", "name"];
const LATENCY_KEYS = ["latencyMs", "latency_ms", "durationMs", "duration_ms", "elapsedMs", "elapsed_ms", "latency"];
const FAILURE_CODE_KEYS = [
  "failureCode",
  "failure_code",
  "errorCode",
  "error_code",
  "code",
  ["error", "code"],
];
const POLICY_KEYS = ["policyDecision", "policyOutcome", ["policy", "decision"], ["policy", "outcome"]];
const ANOMALY_KEYS = ["anomalyType", "anomaly_type", ["anomaly", "type"], "anomalyCode", "anomaly_code"];
const TIMESTAMP_KEYS = ["timestamp", "time", "ts", "createdAt", "created_at"];
const OUTCOME_KEYS = ["status", "result", "requestStatus", "request_status", "outcome"];
const TEAM_KEYS = ["team", "teamId", "team_id"];
const PROJECT_KEYS = ["project", "projectId", "project_id"];

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
}

function normalizeOperation(value) {
  const token = normalizeToken(value);
  return token || "unknown";
}

function normalizeFailureCode(value) {
  const token = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
  return token || "UNKNOWN_FAILURE";
}

function normalizeSliceLabel(value, fallback) {
  const token = normalizeToken(value);
  return token || fallback;
}

function toNumber(value) {
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

function toIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function getValue(record, key) {
  if (Array.isArray(key)) {
    let current = record;
    for (const segment of key) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }
  return record[key];
}

function pickFirst(record, keys) {
  for (const key of keys) {
    const value = getValue(record, key);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function parseTelemetryEvent(line, lineNumber) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON telemetry event on line ${lineNumber}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Telemetry event on line ${lineNumber} must be a JSON object.`);
  }
  return parsed;
}

export function parseTelemetryEvents(source) {
  if (Array.isArray(source)) {
    return source.map((event, index) => {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new Error(`Telemetry array entry ${index} must be a JSON object.`);
      }
      return event;
    });
  }

  const text = String(source ?? "");
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON telemetry array: ${message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Telemetry input must be a JSON array or NDJSON stream of objects.");
    }
    return parseTelemetryEvents(parsed);
  }

  const events = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) {
      continue;
    }
    events.push(parseTelemetryEvent(line, index + 1));
  }
  return events;
}

function parseOutcomeToken(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value !== 0;
  }
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

function classifySuccess(record, index) {
  const explicit = pickFirst(record, ["success", "ok", "isSuccess", "is_success"]);
  const explicitOutcome = parseOutcomeToken(explicit);
  if (explicitOutcome !== null) {
    return explicitOutcome;
  }
  if (explicit !== undefined && explicit !== null) {
    throw new Error(
      `Telemetry event at index ${index} has unsupported explicit outcome value: ${JSON.stringify(explicit)}`,
    );
  }

  const outcomeRaw = pickFirst(record, OUTCOME_KEYS);
  const parsedOutcome = parseOutcomeToken(outcomeRaw);
  if (parsedOutcome !== null) {
    return parsedOutcome;
  }
  if (outcomeRaw !== undefined && outcomeRaw !== null) {
    throw new Error(
      `Telemetry event at index ${index} has unsupported outcome token: ${JSON.stringify(outcomeRaw)}`,
    );
  }

  const failureCode = pickFirst(record, FAILURE_CODE_KEYS);
  if (typeof failureCode === "string" && failureCode.trim()) {
    throw new Error(
      `Telemetry event at index ${index} is missing outcome indicator (success/ok/status/result).`,
    );
  }

  const errorObject = pickFirst(record, ["error"]);
  if (errorObject && typeof errorObject === "object") {
    throw new Error(
      `Telemetry event at index ${index} is missing outcome indicator (success/ok/status/result).`,
    );
  }

  throw new Error(
    `Telemetry event at index ${index} is missing outcome indicator (success/ok/status/result).`,
  );
}

function extractLatencyMs(record, index) {
  const raw = pickFirst(record, LATENCY_KEYS);
  const parsed = toNumber(raw);
  if (parsed === null || parsed < 0) {
    throw new Error(`Telemetry event at index ${index} must include a non-negative latency field.`);
  }
  return Number(parsed.toFixed(3));
}

function extractFailureCode(record, success) {
  if (success) {
    return null;
  }
  return normalizeFailureCode(pickFirst(record, FAILURE_CODE_KEYS));
}

function extractOperation(record, index) {
  const operation = normalizeOperation(pickFirst(record, OPERATION_KEYS));
  if (operation === "unknown") {
    throw new Error(`Telemetry event at index ${index} is missing required field: operation.`);
  }
  return operation;
}

function extractPolicyDecision(record) {
  const value = pickFirst(record, POLICY_KEYS);
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeSliceLabel(value, "unknown_policy");
}

function extractAnomalyType(record) {
  const value = pickFirst(record, ANOMALY_KEYS);
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeSliceLabel(value, "unknown_anomaly");
}

function extractTimestamp(record, index) {
  const timestamp = toIsoTimestamp(pickFirst(record, TIMESTAMP_KEYS));
  if (!timestamp) {
    throw new Error(`Telemetry event at index ${index} is missing required field: timestamp.`);
  }
  return timestamp;
}

function extractTeam(record, index) {
  const team = normalizeSliceLabel(pickFirst(record, TEAM_KEYS), "");
  if (!team) {
    throw new Error(`Telemetry event at index ${index} is missing required field: team.`);
  }
  return team;
}

function extractProject(record, index) {
  const project = normalizeSliceLabel(pickFirst(record, PROJECT_KEYS), "");
  if (!project) {
    throw new Error(`Telemetry event at index ${index} is missing required field: project.`);
  }
  return project;
}

function incrementHistogram(histogram, key) {
  histogram.set(key, (histogram.get(key) || 0) + 1);
}

function histogramToSortedObject(histogram) {
  const entries = [...histogram.entries()].sort((a, b) => compareStrings(a[0], b[0]));
  return Object.fromEntries(entries);
}

function roundRate(count, total) {
  if (total <= 0) {
    return 0;
  }
  return Number((count / total).toFixed(6));
}

function computeP95(latencies) {
  if (latencies.length === 0) {
    return null;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function computeWindow(timestamps) {
  if (timestamps.length === 0) {
    return { start: null, end: null };
  }
  const sorted = [...timestamps].sort((a, b) => compareStrings(a, b));
  return {
    start: sorted[0],
    end: sorted[sorted.length - 1],
  };
}

function summarizePerOperation(operationTotals) {
  const entries = [...operationTotals.entries()].sort((a, b) => compareStrings(a[0], b[0]));
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
        failureCodeHistogram: histogramToSortedObject(stats.failureCodeHistogram),
      },
    ]),
  );
}

export function generatePilotRolloutReport(events) {
  if (!Array.isArray(events)) {
    throw new Error("Expected telemetry events to be an array.");
  }

  let successCount = 0;
  let failureCount = 0;

  const operationHistogram = new Map();
  const failureCodeHistogram = new Map();
  const policyDecisionHistogram = new Map();
  const anomalyHistogram = new Map();
  const teamHistogram = new Map();
  const projectHistogram = new Map();
  const perOperation = new Map();

  const latencies = [];
  const timestamps = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`Telemetry event at index ${index} must be a JSON object.`);
    }

    const success = classifySuccess(event, index);
    const operation = extractOperation(event, index);
    const failureCode = extractFailureCode(event, success);
    const policyDecision = extractPolicyDecision(event);
    const anomalyType = extractAnomalyType(event);
    const latencyMs = extractLatencyMs(event, index);
    const timestamp = extractTimestamp(event, index);
    const team = extractTeam(event, index);
    const project = extractProject(event, index);

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
        failureCodeHistogram: new Map(),
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
      incrementHistogram(failureCodeHistogram, failureCode ?? "UNKNOWN_FAILURE");
      opTotals.failureCount += 1;
      incrementHistogram(opTotals.failureCodeHistogram, failureCode ?? "UNKNOWN_FAILURE");
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

  const requestVolume = events.length;
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
    invalidEventCount: 0,
    telemetryWindow: window,
  };
}

function parseArgs(argv) {
  const parsed = {
    input: "",
    output: "",
    compact: false,
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
      "  node scripts/generate-pilot-rollout-report.mjs --input <path|-> [--output <path>] [--compact]",
      "",
      "Input formats:",
      "  - NDJSON (one telemetry object per line)",
      "  - JSON array of telemetry objects",
      "",
      "Examples:",
      "  node scripts/generate-pilot-rollout-report.mjs --input ops/pilot-rollout/pilot-a/telemetry.ndjson",
      "  node scripts/generate-pilot-rollout-report.mjs --input telemetry.json --output docs/reports/pilot-summary.json",
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

async function readInput(inputPath) {
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
  const events = parseTelemetryEvents(rawInput);
  const report = generatePilotRolloutReport(events);
  const output = `${JSON.stringify(report, null, parsed.compact ? 0 : 2)}\n`;

  if (parsed.output) {
    const resolvedPath = resolve(process.cwd(), parsed.output);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, output, "utf8");
  }

  process.stdout.write(output);
  return 0;
}

const IS_ENTRYPOINT = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (IS_ENTRYPOINT) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `generate-pilot-rollout-report failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
