import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PILOT_SUMMARY_SCHEMA_VERSION = "pilot_rollout_report.v1";
const DASHBOARD_SCHEMA_VERSION = "pilot_kpi_dashboard.v1";
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const RECALL_KEY_PATTERN = /(recall|retriev|context|memory)/iu;

interface GeneratePilotKpiDashboardOptions {
  readonly allowInvalid?: boolean;
}

interface ParsedArgs {
  input: string[];
  feedback: string[];
  output: string;
  compact: boolean;
  allowInvalid: boolean;
  help: boolean;
}

type JsonRecord = Record<string, unknown>;

interface PerOperationMetrics {
  requestVolume: number;
  successCount: number;
  failureCount: number;
  p95LatencyMs: number | null;
  latencySampleSize: number;
  failureCodeHistogram: Map<string, number>;
}

interface ParsedPilotSummary {
  requestVolume: number;
  successCount: number;
  failureCount: number;
  p95LatencyMs: number | null;
  latencySampleSize: number;
  invalidEventCount: number;
  operationHistogram: Map<string, number>;
  failureCodeHistogram: Map<string, number>;
  policyDecisionHistogram: Map<string, number>;
  anomalyHistogram: Map<string, number>;
  teamHistogram: Map<string, number>;
  projectHistogram: Map<string, number>;
  perOperation: Map<string, PerOperationMetrics>;
  telemetryWindow: { start: string | null; end: string | null };
}

interface FeedbackEvent {
  timestamp: string;
  category: string;
  severity: string;
  action: string;
}

interface IoState {
  stdinConsumed: boolean;
  stdinCache: string;
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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeToken(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
}

function normalizeSliceLabel(value: unknown, fallback: string) {
  const token = normalizeToken(value);
  return token || fallback;
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

function attachInvalidCount<T>(
  records: T[],
  invalidCount: number
): T[] & { invalidCount: number } {
  Object.defineProperty(records, "invalidCount", {
    value: invalidCount,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return records as T[] & { invalidCount: number };
}

function readRequiredField(record: JsonRecord, key: string, label: string) {
  if (!(key in record)) {
    throw new Error(`Missing required field: ${label}.`);
  }
  return record[key];
}

function readNonNegativeInteger(value: unknown, label: string) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`Missing required integer field: ${label}.`);
  }
  return value;
}

function readRate(value: unknown, label: string) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`Missing required rate field: ${label}.`);
  }
  return Number(value.toFixed(6));
}

function readLatency(value: unknown, label: string) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid latency field: ${label}.`);
  }
  return Number(value.toFixed(3));
}

function readHistogram(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new Error(`Missing required histogram field: ${label}.`);
  }
  const histogram = new Map<string, number>();
  for (const [key, rawCount] of Object.entries(value)) {
    histogram.set(
      String(key),
      readNonNegativeInteger(rawCount, `${label}.${key}`)
    );
  }
  return histogram;
}

function readTimestampOrNull(value: unknown, label: string) {
  if (value === null) {
    return null;
  }
  const timestamp = toIsoTimestamp(value);
  if (!timestamp) {
    throw new Error(`Invalid timestamp field: ${label}.`);
  }
  return timestamp;
}

function readTelemetryWindow(
  value: unknown,
  label: string,
  requestVolume: number
) {
  if (!isRecord(value)) {
    throw new Error(`Missing required object field: ${label}.`);
  }

  const start = readTimestampOrNull(
    readRequiredField(value, "start", `${label}.start`),
    `${label}.start`
  );
  const end = readTimestampOrNull(
    readRequiredField(value, "end", `${label}.end`),
    `${label}.end`
  );

  if ((start === null) !== (end === null)) {
    throw new Error(
      `Telemetry window must contain both start and end timestamps or both null (${label}).`
    );
  }
  if (start && end && compareStrings(start, end) > 0) {
    throw new Error(`Telemetry window start must be <= end (${label}).`);
  }
  if (requestVolume > 0 && (!start || !end)) {
    throw new Error(
      `Telemetry window cannot be null when requestVolume > 0 (${label}).`
    );
  }
  if (requestVolume === 0 && (start || end)) {
    throw new Error(
      `Telemetry window must be null when requestVolume is 0 (${label}).`
    );
  }
  return { start, end };
}

function readPerOperation(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new Error(`Missing required object field: ${label}.`);
  }
  const perOperation = new Map<string, PerOperationMetrics>();
  for (const [operation, stats] of Object.entries(value)) {
    const prefix = `${label}.${operation}`;
    if (!isRecord(stats)) {
      throw new Error(`Per-operation entry must be an object (${prefix}).`);
    }

    const requestVolume = readNonNegativeInteger(
      readRequiredField(stats, "requestVolume", `${prefix}.requestVolume`),
      `${prefix}.requestVolume`
    );
    const successCount = readNonNegativeInteger(
      readRequiredField(stats, "successCount", `${prefix}.successCount`),
      `${prefix}.successCount`
    );
    const failureCount = readNonNegativeInteger(
      readRequiredField(stats, "failureCount", `${prefix}.failureCount`),
      `${prefix}.failureCount`
    );
    if (successCount + failureCount !== requestVolume) {
      throw new Error(`Per-operation totals mismatch (${prefix}).`);
    }

    readRate(
      readRequiredField(stats, "successRate", `${prefix}.successRate`),
      `${prefix}.successRate`
    );
    readRate(
      readRequiredField(stats, "failureRate", `${prefix}.failureRate`),
      `${prefix}.failureRate`
    );

    const p95LatencyMs = readLatency(
      readRequiredField(stats, "p95LatencyMs", `${prefix}.p95LatencyMs`),
      `${prefix}.p95LatencyMs`
    );
    const latencySampleSize = readNonNegativeInteger(
      readRequiredField(
        stats,
        "latencySampleSize",
        `${prefix}.latencySampleSize`
      ),
      `${prefix}.latencySampleSize`
    );
    const failureCodeHistogram = readHistogram(
      readRequiredField(
        stats,
        "failureCodeHistogram",
        `${prefix}.failureCodeHistogram`
      ),
      `${prefix}.failureCodeHistogram`
    );

    perOperation.set(operation, {
      requestVolume,
      successCount,
      failureCount,
      p95LatencyMs,
      latencySampleSize,
      failureCodeHistogram,
    });
  }
  return perOperation;
}

function readPilotSummary(
  summary: unknown,
  sourceLabel: string
): ParsedPilotSummary {
  if (!isRecord(summary)) {
    throw new Error(`${sourceLabel} must be a JSON object.`);
  }

  const schemaVersion = readRequiredField(
    summary,
    "schemaVersion",
    `${sourceLabel}.schemaVersion`
  );
  if (schemaVersion !== PILOT_SUMMARY_SCHEMA_VERSION) {
    throw new Error(
      `${sourceLabel}.schemaVersion must equal "${PILOT_SUMMARY_SCHEMA_VERSION}", received "${String(schemaVersion)}".`
    );
  }

  const requestVolume = readNonNegativeInteger(
    readRequiredField(summary, "requestVolume", `${sourceLabel}.requestVolume`),
    `${sourceLabel}.requestVolume`
  );
  const successCount = readNonNegativeInteger(
    readRequiredField(summary, "successCount", `${sourceLabel}.successCount`),
    `${sourceLabel}.successCount`
  );
  const failureCount = readNonNegativeInteger(
    readRequiredField(summary, "failureCount", `${sourceLabel}.failureCount`),
    `${sourceLabel}.failureCount`
  );
  if (successCount + failureCount !== requestVolume) {
    throw new Error(`${sourceLabel} has inconsistent request totals.`);
  }

  readRate(
    readRequiredField(summary, "successRate", `${sourceLabel}.successRate`),
    `${sourceLabel}.successRate`
  );
  readRate(
    readRequiredField(summary, "failureRate", `${sourceLabel}.failureRate`),
    `${sourceLabel}.failureRate`
  );

  const p95LatencyMs = readLatency(
    readRequiredField(summary, "p95LatencyMs", `${sourceLabel}.p95LatencyMs`),
    `${sourceLabel}.p95LatencyMs`
  );
  const latencySampleSize = readNonNegativeInteger(
    readRequiredField(
      summary,
      "latencySampleSize",
      `${sourceLabel}.latencySampleSize`
    ),
    `${sourceLabel}.latencySampleSize`
  );
  const invalidEventCount = readNonNegativeInteger(
    readRequiredField(
      summary,
      "invalidEventCount",
      `${sourceLabel}.invalidEventCount`
    ),
    `${sourceLabel}.invalidEventCount`
  );

  const operationHistogram = readHistogram(
    readRequiredField(
      summary,
      "operationHistogram",
      `${sourceLabel}.operationHistogram`
    ),
    `${sourceLabel}.operationHistogram`
  );
  const failureCodeHistogram = readHistogram(
    readRequiredField(
      summary,
      "failureCodeHistogram",
      `${sourceLabel}.failureCodeHistogram`
    ),
    `${sourceLabel}.failureCodeHistogram`
  );
  const policyDecisionHistogram = readHistogram(
    readRequiredField(
      summary,
      "policyDecisionHistogram",
      `${sourceLabel}.policyDecisionHistogram`
    ),
    `${sourceLabel}.policyDecisionHistogram`
  );
  const anomalyHistogram = readHistogram(
    readRequiredField(
      summary,
      "anomalyHistogram",
      `${sourceLabel}.anomalyHistogram`
    ),
    `${sourceLabel}.anomalyHistogram`
  );
  const teamHistogram = readHistogram(
    readRequiredField(summary, "teamHistogram", `${sourceLabel}.teamHistogram`),
    `${sourceLabel}.teamHistogram`
  );
  const projectHistogram = readHistogram(
    readRequiredField(
      summary,
      "projectHistogram",
      `${sourceLabel}.projectHistogram`
    ),
    `${sourceLabel}.projectHistogram`
  );
  const perOperation = readPerOperation(
    readRequiredField(summary, "perOperation", `${sourceLabel}.perOperation`),
    `${sourceLabel}.perOperation`
  );
  const telemetryWindow = readTelemetryWindow(
    readRequiredField(
      summary,
      "telemetryWindow",
      `${sourceLabel}.telemetryWindow`
    ),
    `${sourceLabel}.telemetryWindow`,
    requestVolume
  );

  return {
    requestVolume,
    successCount,
    failureCount,
    p95LatencyMs,
    latencySampleSize,
    invalidEventCount,
    operationHistogram,
    failureCodeHistogram,
    policyDecisionHistogram,
    anomalyHistogram,
    teamHistogram,
    projectHistogram,
    perOperation,
    telemetryWindow,
  };
}

function parseFeedbackObject(
  record: unknown,
  index: number,
  sourceLabel: string
): FeedbackEvent {
  if (!isRecord(record)) {
    throw new Error(
      `${sourceLabel} feedback entry ${index} must be a JSON object.`
    );
  }

  const timestamp = toIsoTimestamp(record["timestamp"]);
  if (!timestamp) {
    throw new Error(
      `${sourceLabel} feedback entry ${index} is missing required RFC3339 timestamp.`
    );
  }

  const category = normalizeSliceLabel(record["category"], "");
  if (!category) {
    throw new Error(
      `${sourceLabel} feedback entry ${index} is missing required field: category.`
    );
  }

  const severity = normalizeSliceLabel(record["severity"], "");
  if (!severity) {
    throw new Error(
      `${sourceLabel} feedback entry ${index} is missing required field: severity.`
    );
  }

  const action = normalizeSliceLabel(record["action"], "none");

  return {
    timestamp,
    category,
    severity,
    action,
  };
}

function parseFeedbackLine(
  line: string,
  lineNumber: number,
  sourceLabel: string
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JSON feedback entry on line ${lineNumber} (${sourceLabel}): ${message}`
    );
  }
  return parseFeedbackObject(parsed, lineNumber - 1, sourceLabel);
}

export function parseFeedbackEvents(
  source: unknown,
  {
    allowInvalid = false,
    sourceLabel = "feedback",
  }: { allowInvalid?: boolean; sourceLabel?: string } = {}
) {
  if (typeof allowInvalid !== "boolean") {
    throw new Error("allowInvalid option must be a boolean.");
  }

  if (Array.isArray(source)) {
    const records: FeedbackEvent[] = [];
    let invalidCount = 0;
    for (let index = 0; index < source.length; index += 1) {
      try {
        records.push(parseFeedbackObject(source[index], index, sourceLabel));
      } catch (error) {
        if (!allowInvalid) {
          throw error;
        }
        invalidCount += 1;
      }
    }
    return attachInvalidCount(records, invalidCount);
  }

  const text = String(source ?? "");
  const trimmed = text.trim();
  if (!trimmed) {
    return attachInvalidCount([], 0);
  }

  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid JSON feedback array (${sourceLabel}): ${message}`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Feedback input must be an array or NDJSON stream of objects (${sourceLabel}).`
      );
    }
    return parseFeedbackEvents(parsed, { allowInvalid, sourceLabel });
  }

  const records: FeedbackEvent[] = [];
  let invalidCount = 0;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) {
      continue;
    }
    try {
      records.push(parseFeedbackLine(line, index + 1, sourceLabel));
    } catch (error) {
      if (!allowInvalid) {
        throw error;
      }
      invalidCount += 1;
    }
  }
  return attachInvalidCount(records, invalidCount);
}

function mergeHistogram(
  target: Map<string, number>,
  source: Map<string, number>,
  filter?: (key: string, count: number) => boolean
) {
  for (const [key, count] of source.entries()) {
    if (filter && !filter(key, count)) {
      continue;
    }
    target.set(key, (target.get(key) || 0) + count);
  }
}

function histogramToSortedObject(histogram: Map<string, number>) {
  const entries = [...histogram.entries()].sort((left, right) =>
    compareStrings(left[0], right[0])
  );
  return Object.fromEntries(entries);
}

function roundRate(count: number, total: number) {
  if (total <= 0) {
    return 0;
  }
  return Number((count / total).toFixed(6));
}

function roundPerThousand(count: number, total: number) {
  if (total <= 0) {
    return 0;
  }
  return Number(((count * 1000) / total).toFixed(6));
}

function mergeWindow(
  currentStart: string | null,
  currentEnd: string | null,
  nextStart: string | null,
  nextEnd: string | null
) {
  let start = currentStart;
  let end = currentEnd;

  if (nextStart && (!start || compareStrings(nextStart, start) < 0)) {
    start = nextStart;
  }
  if (nextEnd && (!end || compareStrings(nextEnd, end) > 0)) {
    end = nextEnd;
  }

  return { start, end };
}

function isRecallKey(key: string) {
  return RECALL_KEY_PATTERN.test(key);
}

export function generatePilotKpiDashboard(
  summaries: readonly unknown[],
  feedbackRecords: readonly unknown[] & { invalidCount?: number } = [],
  { allowInvalid = false }: GeneratePilotKpiDashboardOptions = {}
) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    throw new Error("Expected at least one pilot summary object.");
  }
  if (!Array.isArray(feedbackRecords)) {
    throw new Error("Expected feedback records to be an array.");
  }
  if (typeof allowInvalid !== "boolean") {
    throw new Error("allowInvalid option must be a boolean.");
  }

  let requestVolume = 0;
  let successCount = 0;
  let failureCount = 0;
  let invalidEventCount = 0;
  let latencySampleSize = 0;
  let p95WeightedNumerator = 0;
  let p95WeightedDenominator = 0;
  let maxP95LatencyMs = null;

  let telemetryStart = null;
  let telemetryEnd = null;
  let feedbackStart = null;
  let feedbackEnd = null;

  const operationHistogram = new Map<string, number>();
  const failureCodeHistogram = new Map<string, number>();
  const policyDecisionHistogram = new Map<string, number>();
  const anomalyHistogram = new Map<string, number>();
  const teamHistogram = new Map<string, number>();
  const projectHistogram = new Map<string, number>();

  const recallFailureCodeHistogram = new Map<string, number>();
  const recallAnomalyHistogram = new Map<string, number>();
  let recallRequestVolume = 0;
  let recallSuccessCount = 0;
  let recallFailureCount = 0;

  for (let index = 0; index < summaries.length; index += 1) {
    const summary = readPilotSummary(summaries[index], `summaries[${index}]`);

    requestVolume += summary.requestVolume;
    successCount += summary.successCount;
    failureCount += summary.failureCount;
    invalidEventCount += summary.invalidEventCount;
    latencySampleSize += summary.latencySampleSize;

    if (summary.p95LatencyMs !== null && summary.latencySampleSize > 0) {
      p95WeightedNumerator += summary.p95LatencyMs * summary.latencySampleSize;
      p95WeightedDenominator += summary.latencySampleSize;
      maxP95LatencyMs =
        maxP95LatencyMs === null
          ? summary.p95LatencyMs
          : Math.max(maxP95LatencyMs, summary.p95LatencyMs);
    }

    mergeHistogram(operationHistogram, summary.operationHistogram);
    mergeHistogram(failureCodeHistogram, summary.failureCodeHistogram);
    mergeHistogram(policyDecisionHistogram, summary.policyDecisionHistogram);
    mergeHistogram(anomalyHistogram, summary.anomalyHistogram);
    mergeHistogram(teamHistogram, summary.teamHistogram);
    mergeHistogram(projectHistogram, summary.projectHistogram);
    mergeHistogram(
      recallAnomalyHistogram,
      summary.anomalyHistogram,
      (key: string) => isRecallKey(key)
    );

    for (const [operation, stats] of summary.perOperation.entries()) {
      if (!isRecallKey(operation)) {
        continue;
      }
      recallRequestVolume += stats.requestVolume;
      recallSuccessCount += stats.successCount;
      recallFailureCount += stats.failureCount;
      mergeHistogram(recallFailureCodeHistogram, stats.failureCodeHistogram);
    }

    const mergedWindow = mergeWindow(
      telemetryStart,
      telemetryEnd,
      summary.telemetryWindow.start,
      summary.telemetryWindow.end
    );
    telemetryStart = mergedWindow.start;
    telemetryEnd = mergedWindow.end;
  }

  let feedbackCount = 0;
  const feedbackInvalidCountRaw = Number(
    (feedbackRecords as { invalidCount?: number }).invalidCount ?? 0
  );
  let invalidFeedbackCount =
    Number.isInteger(feedbackInvalidCountRaw) && feedbackInvalidCountRaw > 0
      ? feedbackInvalidCountRaw
      : 0;
  let highSeverityCount = 0;
  let incidentCount = 0;
  let highSeverityIncidentCount = 0;
  let rollbackIncidentCount = 0;
  let qualityFeedbackCount = 0;

  const categoryHistogram = new Map<string, number>();
  const severityHistogram = new Map<string, number>();
  const actionHistogram = new Map<string, number>();

  for (let index = 0; index < feedbackRecords.length; index += 1) {
    let parsedFeedback: FeedbackEvent;
    try {
      parsedFeedback = parseFeedbackObject(
        feedbackRecords[index],
        index,
        "feedback"
      );
    } catch (error) {
      if (!allowInvalid) {
        throw error;
      }
      invalidFeedbackCount += 1;
      continue;
    }

    feedbackCount += 1;
    if (parsedFeedback.severity === "high") {
      highSeverityCount += 1;
    }
    if (parsedFeedback.category === "incident") {
      incidentCount += 1;
      if (parsedFeedback.severity === "high") {
        highSeverityIncidentCount += 1;
      }
      if (parsedFeedback.action === "rollback") {
        rollbackIncidentCount += 1;
      }
    }
    if (
      parsedFeedback.category === "quality" ||
      parsedFeedback.category === "ux"
    ) {
      qualityFeedbackCount += 1;
    }

    mergeHistogram(categoryHistogram, new Map([[parsedFeedback.category, 1]]));
    mergeHistogram(severityHistogram, new Map([[parsedFeedback.severity, 1]]));
    mergeHistogram(actionHistogram, new Map([[parsedFeedback.action, 1]]));

    const mergedFeedbackWindow = mergeWindow(
      feedbackStart,
      feedbackEnd,
      parsedFeedback.timestamp,
      parsedFeedback.timestamp
    );
    feedbackStart = mergedFeedbackWindow.start;
    feedbackEnd = mergedFeedbackWindow.end;
  }

  const weightedP95LatencyEstimateMs =
    p95WeightedDenominator > 0
      ? Number((p95WeightedNumerator / p95WeightedDenominator).toFixed(3))
      : null;

  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    adoption: {
      summaryCount: summaries.length,
      requestVolume,
      successCount,
      failureCount,
      successRate: roundRate(successCount, requestVolume),
      failureRate: roundRate(failureCount, requestVolume),
      activeTeams: teamHistogram.size,
      activeProjects: projectHistogram.size,
      operationHistogram: histogramToSortedObject(operationHistogram),
      teamHistogram: histogramToSortedObject(teamHistogram),
      projectHistogram: histogramToSortedObject(projectHistogram),
    },
    quality: {
      latencySampleSize,
      // Summary-level p95 values cannot be merged into an exact global percentile without raw latency samples.
      // Use conservative max-day p95 for alerting and expose weighted estimate explicitly for trend review.
      p95LatencyMs: maxP95LatencyMs,
      p95LatencyEstimateMs: weightedP95LatencyEstimateMs,
      maxP95LatencyMs,
      invalidEventCount,
      failureCodeHistogram: histogramToSortedObject(failureCodeHistogram),
      anomalyHistogram: histogramToSortedObject(anomalyHistogram),
      policyDecisionHistogram: histogramToSortedObject(policyDecisionHistogram),
    },
    usefulness: {
      feedbackCount,
      invalidFeedbackCount,
      highSeverityCount,
      categoryHistogram: histogramToSortedObject(categoryHistogram),
      severityHistogram: histogramToSortedObject(severityHistogram),
      actionHistogram: histogramToSortedObject(actionHistogram),
    },
    incidentRate: {
      incidentCount,
      highSeverityIncidentCount,
      rollbackIncidentCount,
      incidentsPer1kRequests: roundPerThousand(incidentCount, requestVolume),
    },
    recallQuality: {
      recallRequestVolume,
      recallSuccessCount,
      recallFailureCount,
      recallSuccessRate: roundRate(recallSuccessCount, recallRequestVolume),
      recallFailureRate: roundRate(recallFailureCount, recallRequestVolume),
      recallFailureCodeHistogram: histogramToSortedObject(
        recallFailureCodeHistogram
      ),
      recallAnomalyHistogram: histogramToSortedObject(recallAnomalyHistogram),
      qualityFeedbackCount,
    },
    telemetryWindow: {
      start: telemetryStart,
      end: telemetryEnd,
      feedbackStart,
      feedbackEnd,
    },
  };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    input: [],
    feedback: [],
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
      const value = (args.shift() ?? "").trim();
      if (!value) {
        throw new Error("Missing value for --input.");
      }
      parsed.input.push(value);
      continue;
    }
    if (token === "--feedback") {
      const value = (args.shift() ?? "").trim();
      if (!value) {
        throw new Error("Missing value for --feedback.");
      }
      parsed.feedback.push(value);
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

  if (!parsed.help && parsed.input.length === 0) {
    throw new Error(
      "Missing required --input <path> argument (repeat for multiple summary files)."
    );
  }

  return parsed;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/generate-pilot-kpi-dashboard.ts --input <summary.json> [--input <summary.json> ...]",
      "    [--feedback <feedback.ndjson>] [--output <path>] [--compact] [--allow-invalid]",
      "",
      "Notes:",
      "  - --input must point to one or more pilot rollout summary JSON files.",
      "  - --feedback accepts NDJSON feedback files and may be repeated.",
      "  - --allow-invalid skips malformed feedback records and malformed NDJSON lines.",
      "",
      "Example:",
      "  bun scripts/generate-pilot-kpi-dashboard.ts --input day1-summary.json --input day2-summary.json \\",
      "    --feedback feedback.ndjson --output docs/reports/pilot-kpi-dashboard.json --compact",
    ].join("\n") + "\n"
  );
}

async function readStdin(): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
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

async function readInput(inputPath: string, ioState: IoState) {
  if (inputPath !== "-") {
    return readFileSync(resolve(process.cwd(), inputPath), "utf8");
  }
  if (ioState.stdinConsumed) {
    throw new Error("Standard input can only be used once.");
  }
  ioState.stdinConsumed = true;
  ioState.stdinCache = await readStdin();
  return ioState.stdinCache;
}

function parseSummaryInput(content: string, sourceLabel: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid summary JSON (${sourceLabel}): ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Summary input must be a JSON object (${sourceLabel}).`);
  }
  return parsed;
}

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const parsedArgs = parseArgs(argv);
  if (parsedArgs.help) {
    printUsage();
    return 0;
  }

  const ioState: IoState = { stdinConsumed: false, stdinCache: "" };
  const summaries: JsonRecord[] = [];
  for (const inputPath of parsedArgs.input) {
    const rawSummary = await readInput(inputPath, ioState);
    summaries.push(parseSummaryInput(rawSummary, inputPath));
  }

  const feedbackRecords: FeedbackEvent[] = [];
  let feedbackInvalidCount = 0;
  for (const feedbackPath of parsedArgs.feedback) {
    const rawFeedback = await readInput(feedbackPath, ioState);
    const parsedFeedback = parseFeedbackEvents(rawFeedback, {
      allowInvalid: parsedArgs.allowInvalid,
      sourceLabel: feedbackPath,
    });
    feedbackInvalidCount +=
      Number.isInteger(parsedFeedback.invalidCount) &&
      parsedFeedback.invalidCount > 0
        ? parsedFeedback.invalidCount
        : 0;
    feedbackRecords.push(...parsedFeedback);
  }
  attachInvalidCount(feedbackRecords, feedbackInvalidCount);

  const dashboard = generatePilotKpiDashboard(summaries, feedbackRecords, {
    allowInvalid: parsedArgs.allowInvalid,
  });
  const output = `${JSON.stringify(dashboard, null, parsedArgs.compact ? 0 : 2)}\n`;

  if (parsedArgs.output) {
    const resolvedPath = resolve(process.cwd(), parsedArgs.output);
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
        `generate-pilot-kpi-dashboard failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
