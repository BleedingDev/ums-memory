import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseFeedbackEvents } from "./generate-pilot-kpi-dashboard.ts";

const PILOT_SUMMARY_SCHEMA_VERSION = "pilot_rollout_report.v1";
const DASHBOARD_SCHEMA_VERSION = "pilot_kpi_dashboard.v1";
const TUNING_SCHEMA_VERSION = "pilot_ranking_decay_tuning.v1";
const RECALL_KEY_PATTERN = /(recall|retriev|context|memory)/iu;

const BASELINE_RANKING_WEIGHTS = Object.freeze({
  recency: 0.35,
  semanticSimilarity: 0.4,
  reliability: 0.15,
  policySafety: 0.1,
});

const BASELINE_DECAY_POLICY = Object.freeze({
  halfLifeDays: 21,
  minRetentionDays: 3,
  staleAfterDays: 45,
  maxRetentionDays: 120,
  recencyBoostWindowDays: 7,
});

const RANKING_WEIGHT_ORDER = Object.freeze([
  "recency",
  "semanticSimilarity",
  "reliability",
  "policySafety",
] as const);

interface RankingDecayTuningOptions {
  readonly dashboards?: readonly unknown[];
  readonly feedbackRecords?: readonly unknown[];
}

interface ParsedArgs {
  input: string[];
  dashboard: string[];
  feedback: string[];
  output: string;
  compact: boolean;
  help: boolean;
}

type JsonRecord = Record<string, unknown>;
type RankingWeightKey = (typeof RANKING_WEIGHT_ORDER)[number];
type RankingWeights = Record<RankingWeightKey, number>;

const RANKING_WEIGHT_BOUNDS = Object.freeze({
  min: 0.05,
  max: 0.7,
});

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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 6) {
  return Number(value.toFixed(digits));
}

function roundRate(count: number, total: number) {
  if (total <= 0) {
    return 0;
  }
  return round(count / total);
}

function roundPerThousand(count: number, total: number) {
  if (total <= 0) {
    return 0;
  }
  return round((count * 1000) / total);
}

function normalizeToken(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
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
  return round(value);
}

function readLatency(value: unknown, label: string) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid latency field: ${label}.`);
  }
  return round(value, 3);
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
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid timestamp field: ${label}.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid timestamp field: ${label}.`);
  }
  return new Date(parsed).toISOString();
}

function mergeWindows(
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

function isRecallOperation(operation: string) {
  return RECALL_KEY_PATTERN.test(operation);
}

function readPerOperation(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new Error(`Missing required object field: ${label}.`);
  }
  const perOperation = new Map<
    string,
    {
      requestVolume: number;
      successCount: number;
      failureCount: number;
      failureCodeHistogram: Map<string, number>;
    }
  >();
  for (const [operation, stats] of Object.entries(value)) {
    const operationLabel = `${label}.${operation}`;
    if (!isRecord(stats)) {
      throw new Error(
        `Per-operation entry must be an object (${operationLabel}).`
      );
    }
    const requestVolume = readNonNegativeInteger(
      readRequiredField(
        stats,
        "requestVolume",
        `${operationLabel}.requestVolume`
      ),
      `${operationLabel}.requestVolume`
    );
    const successCount = readNonNegativeInteger(
      readRequiredField(
        stats,
        "successCount",
        `${operationLabel}.successCount`
      ),
      `${operationLabel}.successCount`
    );
    const failureCount = readNonNegativeInteger(
      readRequiredField(
        stats,
        "failureCount",
        `${operationLabel}.failureCount`
      ),
      `${operationLabel}.failureCount`
    );
    if (successCount + failureCount !== requestVolume) {
      throw new Error(`Per-operation totals mismatch (${operationLabel}).`);
    }
    readRate(
      readRequiredField(stats, "successRate", `${operationLabel}.successRate`),
      `${operationLabel}.successRate`
    );
    readRate(
      readRequiredField(stats, "failureRate", `${operationLabel}.failureRate`),
      `${operationLabel}.failureRate`
    );
    readLatency(
      readRequiredField(
        stats,
        "p95LatencyMs",
        `${operationLabel}.p95LatencyMs`
      ),
      `${operationLabel}.p95LatencyMs`
    );
    readNonNegativeInteger(
      readRequiredField(
        stats,
        "latencySampleSize",
        `${operationLabel}.latencySampleSize`
      ),
      `${operationLabel}.latencySampleSize`
    );
    const failureCodeHistogram = readHistogram(
      readRequiredField(
        stats,
        "failureCodeHistogram",
        `${operationLabel}.failureCodeHistogram`
      ),
      `${operationLabel}.failureCodeHistogram`
    );
    perOperation.set(operation, {
      requestVolume,
      successCount,
      failureCount,
      failureCodeHistogram,
    });
  }
  return perOperation;
}

function readPilotSummary(summary: unknown, sourceLabel: string) {
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

  const anomalyHistogram = readHistogram(
    readRequiredField(
      summary,
      "anomalyHistogram",
      `${sourceLabel}.anomalyHistogram`
    ),
    `${sourceLabel}.anomalyHistogram`
  );
  const policyDecisionHistogram = readHistogram(
    readRequiredField(
      summary,
      "policyDecisionHistogram",
      `${sourceLabel}.policyDecisionHistogram`
    ),
    `${sourceLabel}.policyDecisionHistogram`
  );
  const perOperation = readPerOperation(
    readRequiredField(summary, "perOperation", `${sourceLabel}.perOperation`),
    `${sourceLabel}.perOperation`
  );

  const telemetryWindowRaw = readRequiredField(
    summary,
    "telemetryWindow",
    `${sourceLabel}.telemetryWindow`
  );
  if (!isRecord(telemetryWindowRaw)) {
    throw new Error(
      `Missing required object field: ${sourceLabel}.telemetryWindow.`
    );
  }
  const telemetryStart = readTimestampOrNull(
    readRequiredField(
      telemetryWindowRaw,
      "start",
      `${sourceLabel}.telemetryWindow.start`
    ),
    `${sourceLabel}.telemetryWindow.start`
  );
  const telemetryEnd = readTimestampOrNull(
    readRequiredField(
      telemetryWindowRaw,
      "end",
      `${sourceLabel}.telemetryWindow.end`
    ),
    `${sourceLabel}.telemetryWindow.end`
  );
  if ((telemetryStart === null) !== (telemetryEnd === null)) {
    throw new Error(
      `Telemetry window must contain both start and end timestamps or both null (${sourceLabel}).`
    );
  }
  if (
    telemetryStart &&
    telemetryEnd &&
    compareStrings(telemetryStart, telemetryEnd) > 0
  ) {
    throw new Error(`Telemetry window start must be <= end (${sourceLabel}).`);
  }
  if (requestVolume > 0 && (!telemetryStart || !telemetryEnd)) {
    throw new Error(
      `Telemetry window cannot be null when requestVolume > 0 (${sourceLabel}).`
    );
  }
  if (requestVolume === 0 && (telemetryStart || telemetryEnd)) {
    throw new Error(
      `Telemetry window must be null when requestVolume is 0 (${sourceLabel}).`
    );
  }

  return {
    requestVolume,
    successCount,
    failureCount,
    p95LatencyMs,
    latencySampleSize,
    anomalyHistogram,
    policyDecisionHistogram,
    perOperation,
    telemetryWindow: {
      start: telemetryStart,
      end: telemetryEnd,
    },
  };
}

function readDashboard(dashboard: unknown, sourceLabel: string) {
  if (!isRecord(dashboard)) {
    throw new Error(`${sourceLabel} must be a JSON object.`);
  }
  const schemaVersion = readRequiredField(
    dashboard,
    "schemaVersion",
    `${sourceLabel}.schemaVersion`
  );
  if (schemaVersion !== DASHBOARD_SCHEMA_VERSION) {
    throw new Error(
      `${sourceLabel}.schemaVersion must equal "${DASHBOARD_SCHEMA_VERSION}", received "${String(schemaVersion)}".`
    );
  }

  const adoption = readRequiredField(
    dashboard,
    "adoption",
    `${sourceLabel}.adoption`
  );
  if (!isRecord(adoption)) {
    throw new Error(`Missing required object field: ${sourceLabel}.adoption.`);
  }
  const quality = readRequiredField(
    dashboard,
    "quality",
    `${sourceLabel}.quality`
  );
  if (!isRecord(quality)) {
    throw new Error(`Missing required object field: ${sourceLabel}.quality.`);
  }
  const incidentRate = readRequiredField(
    dashboard,
    "incidentRate",
    `${sourceLabel}.incidentRate`
  );
  if (!isRecord(incidentRate)) {
    throw new Error(
      `Missing required object field: ${sourceLabel}.incidentRate.`
    );
  }
  const recallQuality = readRequiredField(
    dashboard,
    "recallQuality",
    `${sourceLabel}.recallQuality`
  );
  if (!isRecord(recallQuality)) {
    throw new Error(
      `Missing required object field: ${sourceLabel}.recallQuality.`
    );
  }
  const usefulness = readRequiredField(
    dashboard,
    "usefulness",
    `${sourceLabel}.usefulness`
  );
  if (!isRecord(usefulness)) {
    throw new Error(
      `Missing required object field: ${sourceLabel}.usefulness.`
    );
  }

  return {
    requestVolume: readNonNegativeInteger(
      readRequiredField(
        adoption,
        "requestVolume",
        `${sourceLabel}.adoption.requestVolume`
      ),
      `${sourceLabel}.adoption.requestVolume`
    ),
    failureRate: readRate(
      readRequiredField(
        adoption,
        "failureRate",
        `${sourceLabel}.adoption.failureRate`
      ),
      `${sourceLabel}.adoption.failureRate`
    ),
    p95LatencyMs: readLatency(
      readRequiredField(
        quality,
        "p95LatencyMs",
        `${sourceLabel}.quality.p95LatencyMs`
      ),
      `${sourceLabel}.quality.p95LatencyMs`
    ),
    p95LatencyEstimateMs: readLatency(
      readRequiredField(
        quality,
        "p95LatencyEstimateMs",
        `${sourceLabel}.quality.p95LatencyEstimateMs`
      ),
      `${sourceLabel}.quality.p95LatencyEstimateMs`
    ),
    incidentsPer1kRequests: readNonNegativeNumber(
      readRequiredField(
        incidentRate,
        "incidentsPer1kRequests",
        `${sourceLabel}.incidentRate.incidentsPer1kRequests`
      ),
      `${sourceLabel}.incidentRate.incidentsPer1kRequests`
    ),
    incidentCount: readNonNegativeInteger(
      readRequiredField(
        incidentRate,
        "incidentCount",
        `${sourceLabel}.incidentRate.incidentCount`
      ),
      `${sourceLabel}.incidentRate.incidentCount`
    ),
    rollbackIncidentCount: readNonNegativeInteger(
      readRequiredField(
        incidentRate,
        "rollbackIncidentCount",
        `${sourceLabel}.incidentRate.rollbackIncidentCount`
      ),
      `${sourceLabel}.incidentRate.rollbackIncidentCount`
    ),
    recallFailureRate: readRate(
      readRequiredField(
        recallQuality,
        "recallFailureRate",
        `${sourceLabel}.recallQuality.recallFailureRate`
      ),
      `${sourceLabel}.recallQuality.recallFailureRate`
    ),
    qualityFeedbackCount: readNonNegativeInteger(
      readRequiredField(
        recallQuality,
        "qualityFeedbackCount",
        `${sourceLabel}.recallQuality.qualityFeedbackCount`
      ),
      `${sourceLabel}.recallQuality.qualityFeedbackCount`
    ),
    feedbackCount: readNonNegativeInteger(
      readRequiredField(
        usefulness,
        "feedbackCount",
        `${sourceLabel}.usefulness.feedbackCount`
      ),
      `${sourceLabel}.usefulness.feedbackCount`
    ),
    highSeverityCount: readNonNegativeInteger(
      readRequiredField(
        usefulness,
        "highSeverityCount",
        `${sourceLabel}.usefulness.highSeverityCount`
      ),
      `${sourceLabel}.usefulness.highSeverityCount`
    ),
  };
}

function readNonNegativeNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Missing required numeric field: ${label}.`);
  }
  return round(value);
}

function aggregateSummaries(summaries: ReturnType<typeof readPilotSummary>[]) {
  let requestVolume = 0;
  let successCount = 0;
  let failureCount = 0;

  let latencySampleSize = 0;
  let weightedP95LatencyNumerator = 0;
  let weightedP95LatencyDenominator = 0;
  let p95LatencyMs = null;

  let recallRequestVolume = 0;
  let recallFailureCount = 0;
  let anomalyCount = 0;
  let policyReviewOrDenyCount = 0;

  let telemetryStart = null;
  let telemetryEnd = null;

  for (const summary of summaries) {
    requestVolume += summary.requestVolume;
    successCount += summary.successCount;
    failureCount += summary.failureCount;

    latencySampleSize += summary.latencySampleSize;
    if (summary.p95LatencyMs !== null && summary.latencySampleSize > 0) {
      weightedP95LatencyNumerator +=
        summary.p95LatencyMs * summary.latencySampleSize;
      weightedP95LatencyDenominator += summary.latencySampleSize;
      p95LatencyMs =
        p95LatencyMs === null
          ? summary.p95LatencyMs
          : Math.max(p95LatencyMs, summary.p95LatencyMs);
    }

    for (const count of summary.anomalyHistogram.values()) {
      anomalyCount += count;
    }
    for (const [
      policyDecision,
      count,
    ] of summary.policyDecisionHistogram.entries()) {
      const normalizedDecision = normalizeToken(policyDecision);
      if (
        normalizedDecision === "review" ||
        normalizedDecision === "deny" ||
        normalizedDecision === "denied"
      ) {
        policyReviewOrDenyCount += count;
      }
    }
    for (const [operation, stats] of summary.perOperation.entries()) {
      if (!isRecallOperation(operation)) {
        continue;
      }
      recallRequestVolume += stats.requestVolume;
      recallFailureCount += stats.failureCount;
    }

    const mergedWindow = mergeWindows(
      telemetryStart,
      telemetryEnd,
      summary.telemetryWindow.start,
      summary.telemetryWindow.end
    );
    telemetryStart = mergedWindow.start;
    telemetryEnd = mergedWindow.end;
  }

  return {
    requestVolume,
    successCount,
    failureCount,
    failureRate: roundRate(failureCount, requestVolume),
    latencySampleSize,
    p95LatencyMs,
    p95LatencyEstimateMs:
      weightedP95LatencyDenominator > 0
        ? round(weightedP95LatencyNumerator / weightedP95LatencyDenominator, 3)
        : null,
    recallRequestVolume,
    recallFailureCount,
    recallFailureRate: roundRate(recallFailureCount, recallRequestVolume),
    anomalyCount,
    anomalyPer1kRequests: roundPerThousand(anomalyCount, requestVolume),
    policyReviewOrDenyCount,
    policyReviewRate: roundRate(policyReviewOrDenyCount, requestVolume),
    telemetryWindow: {
      start: telemetryStart,
      end: telemetryEnd,
    },
  };
}

function aggregateDashboards(dashboards: ReturnType<typeof readDashboard>[]) {
  if (dashboards.length === 0) {
    return null;
  }

  let requestVolume = 0;
  let failureRate = 0;
  let p95LatencyMs = null;
  let recallFailureRate = 0;
  let incidentsPer1kRequests = 0;
  let incidentCount = 0;
  let rollbackIncidentCount = 0;
  let feedbackCount = 0;
  let highSeverityCount = 0;
  let qualityFeedbackCount = 0;

  for (const dashboard of dashboards) {
    requestVolume = Math.max(requestVolume, dashboard.requestVolume);
    failureRate = Math.max(failureRate, dashboard.failureRate);
    if (dashboard.p95LatencyMs !== null) {
      p95LatencyMs =
        p95LatencyMs === null
          ? dashboard.p95LatencyMs
          : Math.max(p95LatencyMs, dashboard.p95LatencyMs);
    }
    if (dashboard.p95LatencyEstimateMs !== null) {
      p95LatencyMs =
        p95LatencyMs === null
          ? dashboard.p95LatencyEstimateMs
          : Math.max(p95LatencyMs, dashboard.p95LatencyEstimateMs);
    }
    recallFailureRate = Math.max(
      recallFailureRate,
      dashboard.recallFailureRate
    );
    incidentsPer1kRequests = Math.max(
      incidentsPer1kRequests,
      dashboard.incidentsPer1kRequests
    );
    incidentCount = Math.max(incidentCount, dashboard.incidentCount);
    rollbackIncidentCount = Math.max(
      rollbackIncidentCount,
      dashboard.rollbackIncidentCount
    );
    feedbackCount = Math.max(feedbackCount, dashboard.feedbackCount);
    highSeverityCount = Math.max(
      highSeverityCount,
      dashboard.highSeverityCount
    );
    qualityFeedbackCount = Math.max(
      qualityFeedbackCount,
      dashboard.qualityFeedbackCount
    );
  }

  return {
    requestVolume,
    failureRate,
    p95LatencyMs,
    recallFailureRate,
    incidentsPer1kRequests,
    incidentCount,
    rollbackIncidentCount,
    feedbackCount,
    highSeverityCount,
    highSeverityFeedbackRate: roundRate(highSeverityCount, feedbackCount),
    qualityFeedbackCount,
    qualityFeedbackRate: roundRate(qualityFeedbackCount, feedbackCount),
    rollbackSignalRate: roundRate(rollbackIncidentCount, feedbackCount),
  };
}

function normalizeFeedbackRecord(record: unknown, index: number) {
  if (!isRecord(record)) {
    throw new Error(`feedbackRecords[${index}] must be a JSON object.`);
  }
  const category = normalizeToken(
    readRequiredField(record, "category", `feedbackRecords[${index}].category`)
  );
  const severity = normalizeToken(
    readRequiredField(record, "severity", `feedbackRecords[${index}].severity`)
  );
  const action = normalizeToken(record["action"] ?? "none");
  if (!category) {
    throw new Error(
      `feedbackRecords[${index}] is missing required field: category.`
    );
  }
  if (!severity) {
    throw new Error(
      `feedbackRecords[${index}] is missing required field: severity.`
    );
  }
  return { category, severity, action };
}

function aggregateFeedback(
  feedbackRecords: readonly unknown[],
  requestVolume: number
) {
  let feedbackCount = 0;
  let incidentCount = 0;
  let highSeverityCount = 0;
  let rollbackIncidentCount = 0;
  let qualityFeedbackCount = 0;

  for (let index = 0; index < feedbackRecords.length; index += 1) {
    const feedback = normalizeFeedbackRecord(feedbackRecords[index], index);
    feedbackCount += 1;
    if (feedback.severity === "high") {
      highSeverityCount += 1;
    }
    if (feedback.category === "incident") {
      incidentCount += 1;
      if (feedback.action === "rollback") {
        rollbackIncidentCount += 1;
      }
    }
    if (
      feedback.category === "quality" ||
      feedback.category === "ux" ||
      feedback.category === "recall"
    ) {
      qualityFeedbackCount += 1;
    }
  }

  return {
    feedbackCount,
    incidentCount,
    highSeverityCount,
    rollbackIncidentCount,
    qualityFeedbackCount,
    incidentsPer1kRequests: roundPerThousand(incidentCount, requestVolume),
    highSeverityFeedbackRate: roundRate(highSeverityCount, feedbackCount),
    qualityFeedbackRate: roundRate(qualityFeedbackCount, feedbackCount),
    rollbackSignalRate: roundRate(rollbackIncidentCount, feedbackCount),
  };
}

function maxNullable(left: number | null, right: number | null) {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

function mergeObservedMetrics(
  summarySignals: ReturnType<typeof aggregateSummaries> & {
    summaryCount: number;
  },
  dashboardSignals:
    | (ReturnType<typeof aggregateDashboards> & { dashboardCount: number })
    | null,
  feedbackSignals: ReturnType<typeof aggregateFeedback>
) {
  const requestVolume = Math.max(
    summarySignals.requestVolume,
    dashboardSignals?.requestVolume ?? 0
  );
  const failureRate = Math.max(
    summarySignals.failureRate,
    dashboardSignals?.failureRate ?? 0
  );
  const recallFailureRate = Math.max(
    summarySignals.recallFailureRate,
    dashboardSignals?.recallFailureRate ?? 0
  );
  const p95LatencyMs = maxNullable(
    summarySignals.p95LatencyMs,
    dashboardSignals?.p95LatencyMs ?? null
  );
  const incidentsPer1kRequests = Math.max(
    feedbackSignals.incidentsPer1kRequests,
    dashboardSignals?.incidentsPer1kRequests ?? 0
  );
  const incidentCount = Math.max(
    feedbackSignals.incidentCount,
    dashboardSignals?.incidentCount ?? 0
  );
  const rollbackIncidentCount = Math.max(
    feedbackSignals.rollbackIncidentCount,
    dashboardSignals?.rollbackIncidentCount ?? 0
  );
  const feedbackCount = Math.max(
    feedbackSignals.feedbackCount,
    dashboardSignals?.feedbackCount ?? 0
  );
  const highSeverityCount = Math.max(
    feedbackSignals.highSeverityCount,
    dashboardSignals?.highSeverityCount ?? 0
  );
  const qualityFeedbackCount = Math.max(
    feedbackSignals.qualityFeedbackCount,
    dashboardSignals?.qualityFeedbackCount ?? 0
  );

  return {
    summaryCount: summarySignals.summaryCount,
    dashboardCount: dashboardSignals ? dashboardSignals.dashboardCount : 0,
    requestVolume,
    successCount: summarySignals.successCount,
    failureCount: summarySignals.failureCount,
    failureRate,
    p95LatencyMs,
    p95LatencyEstimateMs: summarySignals.p95LatencyEstimateMs,
    recallRequestVolume: summarySignals.recallRequestVolume,
    recallFailureCount: summarySignals.recallFailureCount,
    recallFailureRate,
    anomalyCount: summarySignals.anomalyCount,
    anomalyPer1kRequests: summarySignals.anomalyPer1kRequests,
    policyReviewOrDenyCount: summarySignals.policyReviewOrDenyCount,
    policyReviewRate: summarySignals.policyReviewRate,
    feedbackCount,
    highSeverityCount,
    highSeverityFeedbackRate: roundRate(highSeverityCount, feedbackCount),
    qualityFeedbackCount,
    qualityFeedbackRate: roundRate(qualityFeedbackCount, feedbackCount),
    incidentCount,
    incidentsPer1kRequests,
    rollbackIncidentCount,
    rollbackSignalRate: roundRate(rollbackIncidentCount, feedbackCount),
    telemetryWindow: summarySignals.telemetryWindow,
  };
}

function computePressures(
  observedMetrics: ReturnType<typeof mergeObservedMetrics>
) {
  const failurePressure = clamp(
    (observedMetrics.failureRate - 0.005) / 0.025,
    0,
    1
  );
  const latencyPressure = clamp(
    ((observedMetrics.p95LatencyMs ?? 0) - 250) / 350,
    0,
    1
  );
  const recallPressure = clamp(
    (observedMetrics.recallFailureRate - 0.02) / 0.18,
    0,
    1
  );
  const anomalyPressure = clamp(
    observedMetrics.anomalyPer1kRequests / 15,
    0,
    1
  );
  const incidentPressure = clamp(
    observedMetrics.incidentsPer1kRequests / 8,
    0,
    1
  );
  const feedbackPressure = clamp(
    (observedMetrics.highSeverityFeedbackRate +
      observedMetrics.rollbackSignalRate) /
      0.2,
    0,
    1
  );

  return {
    failurePressure: round(failurePressure),
    latencyPressure: round(latencyPressure),
    recallPressure: round(recallPressure),
    anomalyPressure: round(anomalyPressure),
    incidentPressure: round(incidentPressure),
    feedbackPressure: round(feedbackPressure),
  };
}

function boundedNormalizeWeights(rawWeights: RankingWeights) {
  const weights = new Map<RankingWeightKey, number>(
    RANKING_WEIGHT_ORDER.map((key) => [key, rawWeights[key] ?? 0])
  );
  const fixed = new Map<RankingWeightKey, number>();
  const epsilon = 1e-12;

  while (true) {
    const freeKeys = RANKING_WEIGHT_ORDER.filter((key) => !fixed.has(key));
    if (freeKeys.length === 0) {
      break;
    }

    const fixedSum = [...fixed.values()].reduce((sum, value) => sum + value, 0);
    const remaining = Math.max(0, 1 - fixedSum);
    const freeRawSum = freeKeys.reduce(
      (sum, key) => sum + Math.max(0, weights.get(key) ?? 0),
      0
    );
    const denominator = freeRawSum > 0 ? freeRawSum : freeKeys.length;

    for (const key of freeKeys) {
      const raw = freeRawSum > 0 ? Math.max(0, weights.get(key) ?? 0) : 1;
      weights.set(key, (remaining * raw) / denominator);
    }

    let changed = false;
    for (const key of freeKeys) {
      const value = weights.get(key) ?? 0;
      if (value < RANKING_WEIGHT_BOUNDS.min - epsilon) {
        fixed.set(key, RANKING_WEIGHT_BOUNDS.min);
        weights.set(key, RANKING_WEIGHT_BOUNDS.min);
        changed = true;
      } else if (value > RANKING_WEIGHT_BOUNDS.max + epsilon) {
        fixed.set(key, RANKING_WEIGHT_BOUNDS.max);
        weights.set(key, RANKING_WEIGHT_BOUNDS.max);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  const sum = RANKING_WEIGHT_ORDER.reduce(
    (total, key) => total + (weights.get(key) ?? 0),
    0
  );
  if (sum <= 0) {
    const equalWeight = 1 / RANKING_WEIGHT_ORDER.length;
    for (const key of RANKING_WEIGHT_ORDER) {
      weights.set(key, equalWeight);
    }
  } else {
    for (const key of RANKING_WEIGHT_ORDER) {
      weights.set(key, (weights.get(key) ?? 0) / sum);
    }
  }

  const normalized: Partial<RankingWeights> = {};
  let running = 0;
  for (let index = 0; index < RANKING_WEIGHT_ORDER.length; index += 1) {
    const key = RANKING_WEIGHT_ORDER[index];
    if (key === undefined) {
      continue;
    }
    if (index === RANKING_WEIGHT_ORDER.length - 1) {
      normalized[key] = round(1 - running);
      continue;
    }
    normalized[key] = round(weights.get(key) ?? 0);
    running += normalized[key] ?? 0;
  }
  return normalized as RankingWeights;
}

function recommendRankingWeights(
  pressures: ReturnType<typeof computePressures>
) {
  const recencyDelta =
    0.1 * pressures.latencyPressure + 0.06 * pressures.anomalyPressure;
  const reliabilityDelta =
    0.12 * pressures.recallPressure +
    0.08 * pressures.failurePressure +
    0.05 * pressures.incidentPressure;
  const policySafetyDelta =
    0.08 * pressures.incidentPressure + 0.05 * pressures.feedbackPressure;
  const semanticSimilarityDelta = -(
    recencyDelta +
    reliabilityDelta +
    policySafetyDelta
  );

  const rawWeights = {
    recency: BASELINE_RANKING_WEIGHTS.recency + recencyDelta,
    semanticSimilarity:
      BASELINE_RANKING_WEIGHTS.semanticSimilarity + semanticSimilarityDelta,
    reliability: BASELINE_RANKING_WEIGHTS.reliability + reliabilityDelta,
    policySafety: BASELINE_RANKING_WEIGHTS.policySafety + policySafetyDelta,
  };

  return boundedNormalizeWeights(rawWeights);
}

function recommendDecayPolicy(pressures: ReturnType<typeof computePressures>) {
  const halfLifeDays = clamp(
    Math.round(
      BASELINE_DECAY_POLICY.halfLifeDays +
        8 * pressures.recallPressure -
        6 * pressures.anomalyPressure -
        5 * pressures.incidentPressure -
        4 * pressures.latencyPressure
    ),
    7,
    45
  );
  const minRetentionDays = clamp(
    Math.round(
      BASELINE_DECAY_POLICY.minRetentionDays +
        2 * pressures.recallPressure -
        2 * pressures.incidentPressure
    ),
    1,
    14
  );
  const maxRetentionDays = clamp(
    Math.round(
      BASELINE_DECAY_POLICY.maxRetentionDays +
        30 * pressures.recallPressure -
        25 * pressures.incidentPressure -
        20 * pressures.latencyPressure
    ),
    45,
    180
  );
  const staleAfterDays = clamp(
    Math.round(
      BASELINE_DECAY_POLICY.staleAfterDays +
        12 * pressures.recallPressure -
        15 * pressures.incidentPressure -
        10 * pressures.latencyPressure
    ),
    14,
    90
  );
  const recencyBoostWindowDays = clamp(
    Math.round(
      BASELINE_DECAY_POLICY.recencyBoostWindowDays +
        3 * pressures.latencyPressure +
        2 * pressures.recallPressure
    ),
    3,
    14
  );

  const boundedStaleAfter = clamp(
    staleAfterDays,
    minRetentionDays,
    maxRetentionDays
  );

  return {
    halfLifeDays,
    minRetentionDays,
    staleAfterDays: boundedStaleAfter,
    maxRetentionDays,
    recencyBoostWindowDays,
  };
}

function buildGuardrails(
  observedMetrics: ReturnType<typeof mergeObservedMetrics>,
  pressures: ReturnType<typeof computePressures>
) {
  return {
    minObservationRequests: 500,
    minFeedbackSamples: 10,
    maxFailureRate: round(
      clamp(
        0.0075 +
          0.004 * Math.max(pressures.failurePressure, pressures.recallPressure),
        0.005,
        0.015
      )
    ),
    maxRecallFailureRate: round(
      clamp(0.04 + 0.04 * pressures.recallPressure, 0.03, 0.12)
    ),
    maxP95LatencyMs: Math.round(
      clamp(
        275 + 100 * pressures.latencyPressure + 75 * pressures.incidentPressure,
        250,
        450
      )
    ),
    maxIncidentsPer1kRequests: round(
      clamp(1.5 + 1.5 * pressures.incidentPressure, 1, 4)
    ),
    maxAnomaliesPer1kRequests: round(
      clamp(4 + 4 * pressures.anomalyPressure, 3, 10)
    ),
    maxPolicyReviewRate: round(
      clamp(0.06 + 0.08 * pressures.incidentPressure, 0.05, 0.2)
    ),
    abortOnRollbackSignal: true,
    rollbackSignalDetected: observedMetrics.rollbackIncidentCount > 0,
  };
}

function buildRationale(
  observedMetrics: ReturnType<typeof mergeObservedMetrics>,
  pressures: ReturnType<typeof computePressures>,
  rankingWeights: RankingWeights,
  decayPolicy: ReturnType<typeof recommendDecayPolicy>
) {
  const reasonCodes: Array<{ code: string } & Record<string, unknown>> = [];

  function pushReason(
    code: string,
    condition: boolean,
    details: Record<string, unknown>
  ) {
    if (!condition) {
      return;
    }
    reasonCodes.push({ code, ...details });
  }

  pushReason(
    "RECALL_FAILURE_ELEVATED",
    observedMetrics.recallFailureRate > 0.05,
    {
      severity: observedMetrics.recallFailureRate > 0.1 ? "high" : "medium",
      metric: "recallFailureRate",
      observed: observedMetrics.recallFailureRate,
      threshold: 0.05,
      impact:
        "Increase reliability weight and adjust retention window for recall stability.",
    }
  );
  pushReason("FAILURE_RATE_ELEVATED", observedMetrics.failureRate > 0.01, {
    severity: observedMetrics.failureRate > 0.02 ? "high" : "medium",
    metric: "failureRate",
    observed: observedMetrics.failureRate,
    threshold: 0.01,
    impact: "Shift rank budget toward reliability and tighten guardrails.",
  });
  pushReason("LATENCY_ELEVATED", (observedMetrics.p95LatencyMs ?? 0) > 300, {
    severity: (observedMetrics.p95LatencyMs ?? 0) > 400 ? "high" : "medium",
    metric: "p95LatencyMs",
    observed: observedMetrics.p95LatencyMs ?? 0,
    threshold: 300,
    impact:
      "Increase recency contribution and shorten stale horizon under load.",
  });
  pushReason(
    "ANOMALY_RATE_ELEVATED",
    observedMetrics.anomalyPer1kRequests > 4,
    {
      severity: observedMetrics.anomalyPer1kRequests > 8 ? "high" : "medium",
      metric: "anomalyPer1kRequests",
      observed: observedMetrics.anomalyPer1kRequests,
      threshold: 4,
      impact: "Increase recency pressure and decay stale memories earlier.",
    }
  );
  pushReason(
    "INCIDENT_RATE_ELEVATED",
    observedMetrics.incidentsPer1kRequests > 2,
    {
      severity: observedMetrics.incidentsPer1kRequests > 4 ? "high" : "medium",
      metric: "incidentsPer1kRequests",
      observed: observedMetrics.incidentsPer1kRequests,
      threshold: 2,
      impact:
        "Increase policy safety weight and reduce retention aggressiveness ceiling.",
    }
  );
  pushReason(
    "HIGH_SEVERITY_FEEDBACK_ELEVATED",
    observedMetrics.highSeverityFeedbackRate > 0.2,
    {
      severity:
        observedMetrics.highSeverityFeedbackRate > 0.35 ? "high" : "medium",
      metric: "highSeverityFeedbackRate",
      observed: observedMetrics.highSeverityFeedbackRate,
      threshold: 0.2,
      impact:
        "Bias ranking toward safer matches and stricter rollout guardrails.",
    }
  );
  pushReason(
    "ROLLBACK_SIGNAL_PRESENT",
    observedMetrics.rollbackIncidentCount > 0,
    {
      severity: "high",
      metric: "rollbackIncidentCount",
      observed: observedMetrics.rollbackIncidentCount,
      threshold: 0,
      impact: "Require rollback-aware guardrails and conservative rollout.",
    }
  );

  if (reasonCodes.length === 0) {
    reasonCodes.push({
      code: "NO_SIGNIFICANT_DEVIATION",
      severity: "low",
      metric: "composite",
      observed: 0,
      threshold: 0,
      impact:
        "Keep recommendations near baseline while maintaining standard guardrails.",
    });
  }

  return {
    reasonCodes,
    pressureScores: pressures,
    rankingDelta: {
      recency: round(rankingWeights.recency - BASELINE_RANKING_WEIGHTS.recency),
      semanticSimilarity: round(
        rankingWeights.semanticSimilarity -
          BASELINE_RANKING_WEIGHTS.semanticSimilarity
      ),
      reliability: round(
        rankingWeights.reliability - BASELINE_RANKING_WEIGHTS.reliability
      ),
      policySafety: round(
        rankingWeights.policySafety - BASELINE_RANKING_WEIGHTS.policySafety
      ),
    },
    decayDelta: {
      halfLifeDays:
        decayPolicy.halfLifeDays - BASELINE_DECAY_POLICY.halfLifeDays,
      minRetentionDays:
        decayPolicy.minRetentionDays - BASELINE_DECAY_POLICY.minRetentionDays,
      staleAfterDays:
        decayPolicy.staleAfterDays - BASELINE_DECAY_POLICY.staleAfterDays,
      maxRetentionDays:
        decayPolicy.maxRetentionDays - BASELINE_DECAY_POLICY.maxRetentionDays,
      recencyBoostWindowDays:
        decayPolicy.recencyBoostWindowDays -
        BASELINE_DECAY_POLICY.recencyBoostWindowDays,
    },
  };
}

export function generateRankingDecayTuning(
  summaries: readonly unknown[],
  { dashboards = [], feedbackRecords = [] }: RankingDecayTuningOptions = {}
) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    throw new Error("Expected at least one pilot summary object.");
  }
  if (!Array.isArray(dashboards)) {
    throw new Error("Expected dashboards to be an array.");
  }
  if (!Array.isArray(feedbackRecords)) {
    throw new Error("Expected feedbackRecords to be an array.");
  }

  const normalizedSummaries = summaries.map((summary, index) =>
    readPilotSummary(summary, `summaries[${index}]`)
  );
  const normalizedDashboards = dashboards.map((dashboard, index) =>
    readDashboard(dashboard, `dashboards[${index}]`)
  );

  const summarySignals = {
    ...aggregateSummaries(normalizedSummaries),
    summaryCount: normalizedSummaries.length,
  };

  const dashboardAggregate = aggregateDashboards(normalizedDashboards);
  const dashboardSignals = dashboardAggregate
    ? {
        ...dashboardAggregate,
        dashboardCount: normalizedDashboards.length,
      }
    : null;
  const feedbackSignals = aggregateFeedback(
    feedbackRecords,
    summarySignals.requestVolume
  );

  const observedMetrics = mergeObservedMetrics(
    summarySignals,
    dashboardSignals,
    feedbackSignals
  );
  const pressures = computePressures(observedMetrics);
  const recommendedRankingWeights = recommendRankingWeights(pressures);
  const recommendedDecayPolicy = recommendDecayPolicy(pressures);
  const guardrails = buildGuardrails(observedMetrics, pressures);

  return {
    schemaVersion: TUNING_SCHEMA_VERSION,
    baseline: {
      rankingWeights: BASELINE_RANKING_WEIGHTS,
      decayPolicy: BASELINE_DECAY_POLICY,
    },
    observedMetrics,
    recommendedRankingWeights,
    recommendedDecayPolicy,
    guardrails,
    rationale: buildRationale(
      observedMetrics,
      pressures,
      recommendedRankingWeights,
      recommendedDecayPolicy
    ),
  };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    input: [],
    dashboard: [],
    feedback: [],
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
      const value = (args.shift() ?? "").trim();
      if (!value) {
        throw new Error("Missing value for --input.");
      }
      parsed.input.push(value);
      continue;
    }
    if (token === "--dashboard") {
      const value = (args.shift() ?? "").trim();
      if (!value) {
        throw new Error("Missing value for --dashboard.");
      }
      parsed.dashboard.push(value);
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
      "  bun scripts/generate-ranking-decay-tuning.ts --input <summary.json> [--input <summary.json> ...]",
      "    [--dashboard <dashboard.json>] [--feedback <feedback.ndjson>] [--output <path>] [--compact]",
      "",
      "Notes:",
      "  - --input must point to one or more pilot rollout summary JSON files.",
      "  - --dashboard accepts optional pilot KPI dashboard JSON files (repeatable).",
      "  - --feedback accepts optional NDJSON feedback files (repeatable).",
      "",
      "Example:",
      "  bun scripts/generate-ranking-decay-tuning.ts --input docs/reports/pilot-rollout/final-summary.json \\",
      "    --dashboard docs/reports/pilot-rollout/kpi-dashboard.json \\",
      "    --feedback ops/pilot-rollout/pilot-alpha/feedback.ndjson --compact",
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

async function readInput(
  inputPath: string,
  ioState: { stdinConsumed: boolean; stdinCache: string }
) {
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

function parseJsonObject(
  content: string,
  sourceLabel: string,
  artifactLabel: string
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid ${artifactLabel} JSON (${sourceLabel}): ${message}`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `${artifactLabel} input must be a JSON object (${sourceLabel}).`
    );
  }
  return parsed;
}

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const parsedArgs = parseArgs(argv);
  if (parsedArgs.help) {
    printUsage();
    return 0;
  }

  const ioState: { stdinConsumed: boolean; stdinCache: string } = {
    stdinConsumed: false,
    stdinCache: "",
  };
  const summaries: JsonRecord[] = [];
  for (const inputPath of parsedArgs.input) {
    const rawSummary = await readInput(inputPath, ioState);
    summaries.push(parseJsonObject(rawSummary, inputPath, "summary"));
  }

  const dashboards: JsonRecord[] = [];
  for (const dashboardPath of parsedArgs.dashboard) {
    const rawDashboard = await readInput(dashboardPath, ioState);
    dashboards.push(parseJsonObject(rawDashboard, dashboardPath, "dashboard"));
  }

  const feedbackRecords: unknown[] = [];
  for (const feedbackPath of parsedArgs.feedback) {
    const rawFeedback = await readInput(feedbackPath, ioState);
    const parsedFeedback = parseFeedbackEvents(rawFeedback, {
      allowInvalid: false,
      sourceLabel: feedbackPath,
    });
    feedbackRecords.push(...parsedFeedback);
  }

  const recommendation = generateRankingDecayTuning(summaries, {
    dashboards,
    feedbackRecords,
  });
  const output = `${JSON.stringify(recommendation, null, parsedArgs.compact ? 0 : 2)}\n`;

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
        `generate-ranking-decay-tuning failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
