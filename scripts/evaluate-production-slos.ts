import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DASHBOARD_SCHEMA_VERSION = "pilot_kpi_dashboard.v1";
const TUNING_SCHEMA_VERSION = "pilot_ranking_decay_tuning.v1";
const SLO_EVALUATION_SCHEMA_VERSION = "production_slo_evaluation.v1";
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

const BASE_THRESHOLDS = Object.freeze({
  successRate: 0.995,
  failureRate: 0.005,
  p95LatencyMs: 250,
  incidentsPer1kRequests: 2,
  recallFailureRate: 0.04,
  anomaliesPer1kRequests: 4,
  policyReviewRate: 0.06,
});

const OBJECTIVES = Object.freeze([
  {
    key: "successRate",
    description: "Global success rate",
  },
  {
    key: "failureRate",
    description: "Global failure rate",
  },
  {
    key: "p95LatencyMs",
    description: "Global p95 latency (ms)",
  },
  {
    key: "incidentsPer1kRequests",
    description: "Incidents per 1k requests",
  },
  {
    key: "recallFailureRate",
    description: "Recall failure rate",
  },
  {
    key: "anomaliesPer1kRequests",
    description: "Anomaly safety signal (per 1k requests)",
  },
  {
    key: "policyReviewRate",
    description: "Policy review/deny safety rate",
  },
]);

const ACTION_BY_OBJECTIVE = Object.freeze({
  successRate:
    "Hold rollout expansion and investigate top failure drivers until successRate meets objective.",
  failureRate:
    "Triage error budget burn, patch dominant failure modes, and rerun SLO evaluation after mitigation.",
  p95LatencyMs:
    "Profile slow paths, reduce tail latency hotspots, and verify p95 latency objective before promotion.",
  incidentsPer1kRequests:
    "Pause production expansion, complete incident postmortems, and require a clean window before continuing.",
  recallFailureRate:
    "Revisit retrieval/ranking behavior and validate recall failure improvements before rollout continuation.",
  anomaliesPer1kRequests:
    "Audit anomaly categories, resolve unstable signals, and enforce containment before enabling broader traffic.",
  policyReviewRate:
    "Review policy decisions, tighten policy guardrails, and ensure review/deny rates return within objective.",
});

interface EvaluateProductionSloOptions {
  readonly tuningRecommendation?: unknown;
  readonly evaluatedAt?: string;
  readonly dashboardSources?: readonly string[];
  readonly tuningSource?: string | null;
}

interface ParsedArgs {
  dashboard: string[];
  tuning: string;
  output: string;
  compact: boolean;
  evaluatedAt: string;
  help: boolean;
}

type JsonObject = Record<string, unknown>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function roundRateOrNull(count: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }
  return round(count / total);
}

function roundPerThousandOrNull(count: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }
  return round((count * 1000) / total);
}

function readRequiredField(
  record: JsonObject,
  key: string,
  label: string
): unknown {
  if (!(key in record)) {
    throw new Error(`Missing required field: ${label}.`);
  }
  return record[key];
}

function readNonNegativeInteger(value: unknown, label: string): number {
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

function readNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Missing required numeric field: ${label}.`);
  }
  return round(value);
}

function readRate(value: unknown, label: string): number {
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

function readLatency(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid latency field: ${label}.`);
  }
  return round(value, 3);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Missing required boolean field: ${label}.`);
  }
  return value;
}

function readHistogram(value: unknown, label: string): Map<string, number> {
  if (!isRecord(value)) {
    throw new Error(`Missing required histogram field: ${label}.`);
  }
  const histogram = new Map();
  for (const [key, rawCount] of Object.entries(value)) {
    histogram.set(
      String(key),
      readNonNegativeInteger(rawCount, `${label}.${key}`)
    );
  }
  return histogram;
}

function normalizeToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
}

function isPolicyReviewOrDeny(policyDecision: unknown): boolean {
  const normalized = normalizeToken(policyDecision);
  return (
    normalized === "review" || normalized === "deny" || normalized === "denied"
  );
}

function assertApproxEqual(
  actual: number,
  expected: number,
  label: string,
  tolerance = 1e-6
) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `Inconsistent derived field: ${label}. Expected ${expected}, received ${actual}.`
    );
  }
}

function toIsoTimestamp(value: unknown): string | null {
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

function sumHistogramValues(histogram: Map<string, number>): number {
  let total = 0;
  for (const count of histogram.values()) {
    total += count;
  }
  return total;
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

  const requestVolume = readNonNegativeInteger(
    readRequiredField(
      adoption,
      "requestVolume",
      `${sourceLabel}.adoption.requestVolume`
    ),
    `${sourceLabel}.adoption.requestVolume`
  );
  const successCount = readNonNegativeInteger(
    readRequiredField(
      adoption,
      "successCount",
      `${sourceLabel}.adoption.successCount`
    ),
    `${sourceLabel}.adoption.successCount`
  );
  const failureCount = readNonNegativeInteger(
    readRequiredField(
      adoption,
      "failureCount",
      `${sourceLabel}.adoption.failureCount`
    ),
    `${sourceLabel}.adoption.failureCount`
  );
  if (successCount + failureCount !== requestVolume) {
    throw new Error(`Adoption totals mismatch (${sourceLabel}).`);
  }

  const successRate = readRate(
    readRequiredField(
      adoption,
      "successRate",
      `${sourceLabel}.adoption.successRate`
    ),
    `${sourceLabel}.adoption.successRate`
  );
  const failureRate = readRate(
    readRequiredField(
      adoption,
      "failureRate",
      `${sourceLabel}.adoption.failureRate`
    ),
    `${sourceLabel}.adoption.failureRate`
  );
  const expectedSuccessRate =
    requestVolume > 0 ? round(successCount / requestVolume) : 0;
  const expectedFailureRate =
    requestVolume > 0 ? round(failureCount / requestVolume) : 0;
  assertApproxEqual(
    successRate,
    expectedSuccessRate,
    `${sourceLabel}.adoption.successRate`
  );
  assertApproxEqual(
    failureRate,
    expectedFailureRate,
    `${sourceLabel}.adoption.failureRate`
  );

  const p95LatencyMs = readLatency(
    readRequiredField(
      quality,
      "p95LatencyMs",
      `${sourceLabel}.quality.p95LatencyMs`
    ),
    `${sourceLabel}.quality.p95LatencyMs`
  );
  const p95LatencyEstimateMs = readLatency(
    readRequiredField(
      quality,
      "p95LatencyEstimateMs",
      `${sourceLabel}.quality.p95LatencyEstimateMs`
    ),
    `${sourceLabel}.quality.p95LatencyEstimateMs`
  );
  const anomalyHistogram = readHistogram(
    readRequiredField(
      quality,
      "anomalyHistogram",
      `${sourceLabel}.quality.anomalyHistogram`
    ),
    `${sourceLabel}.quality.anomalyHistogram`
  );
  const policyDecisionHistogram = readHistogram(
    readRequiredField(
      quality,
      "policyDecisionHistogram",
      `${sourceLabel}.quality.policyDecisionHistogram`
    ),
    `${sourceLabel}.quality.policyDecisionHistogram`
  );

  const incidentCount = readNonNegativeInteger(
    readRequiredField(
      incidentRate,
      "incidentCount",
      `${sourceLabel}.incidentRate.incidentCount`
    ),
    `${sourceLabel}.incidentRate.incidentCount`
  );
  const incidentsPer1kRequests = readNonNegativeNumber(
    readRequiredField(
      incidentRate,
      "incidentsPer1kRequests",
      `${sourceLabel}.incidentRate.incidentsPer1kRequests`
    ),
    `${sourceLabel}.incidentRate.incidentsPer1kRequests`
  );
  const expectedIncidentsPer1k =
    requestVolume > 0 ? round((incidentCount * 1000) / requestVolume) : 0;
  assertApproxEqual(
    incidentsPer1kRequests,
    expectedIncidentsPer1k,
    `${sourceLabel}.incidentRate.incidentsPer1kRequests`
  );

  const recallRequestVolume = readNonNegativeInteger(
    readRequiredField(
      recallQuality,
      "recallRequestVolume",
      `${sourceLabel}.recallQuality.recallRequestVolume`
    ),
    `${sourceLabel}.recallQuality.recallRequestVolume`
  );
  const recallFailureCount = readNonNegativeInteger(
    readRequiredField(
      recallQuality,
      "recallFailureCount",
      `${sourceLabel}.recallQuality.recallFailureCount`
    ),
    `${sourceLabel}.recallQuality.recallFailureCount`
  );
  if (recallFailureCount > recallRequestVolume) {
    throw new Error(`Recall totals mismatch (${sourceLabel}).`);
  }
  const recallFailureRate = readRate(
    readRequiredField(
      recallQuality,
      "recallFailureRate",
      `${sourceLabel}.recallQuality.recallFailureRate`
    ),
    `${sourceLabel}.recallQuality.recallFailureRate`
  );
  const expectedRecallFailureRate =
    recallRequestVolume > 0
      ? round(recallFailureCount / recallRequestVolume)
      : 0;
  assertApproxEqual(
    recallFailureRate,
    expectedRecallFailureRate,
    `${sourceLabel}.recallQuality.recallFailureRate`
  );

  let policyReviewOrDenyCount = 0;
  for (const [decision, count] of policyDecisionHistogram.entries()) {
    if (isPolicyReviewOrDeny(decision)) {
      policyReviewOrDenyCount += count;
    }
  }

  return {
    requestVolume,
    successCount,
    failureCount,
    p95LatencyMs,
    p95LatencyEstimateMs,
    incidentCount,
    recallRequestVolume,
    recallFailureCount,
    anomalyCount: sumHistogramValues(anomalyHistogram),
    policyReviewOrDenyCount,
  };
}

function readTuningRecommendation(
  recommendation: unknown,
  sourceLabel: string
) {
  if (!isRecord(recommendation)) {
    throw new Error(`${sourceLabel} must be a JSON object.`);
  }

  const schemaVersion = readRequiredField(
    recommendation,
    "schemaVersion",
    `${sourceLabel}.schemaVersion`
  );
  if (schemaVersion !== TUNING_SCHEMA_VERSION) {
    throw new Error(
      `${sourceLabel}.schemaVersion must equal "${TUNING_SCHEMA_VERSION}", received "${String(schemaVersion)}".`
    );
  }

  const guardrails = readRequiredField(
    recommendation,
    "guardrails",
    `${sourceLabel}.guardrails`
  );
  if (!isRecord(guardrails)) {
    throw new Error(
      `Missing required object field: ${sourceLabel}.guardrails.`
    );
  }

  return {
    maxFailureRate: readRate(
      readRequiredField(
        guardrails,
        "maxFailureRate",
        `${sourceLabel}.guardrails.maxFailureRate`
      ),
      `${sourceLabel}.guardrails.maxFailureRate`
    ),
    maxRecallFailureRate: readRate(
      readRequiredField(
        guardrails,
        "maxRecallFailureRate",
        `${sourceLabel}.guardrails.maxRecallFailureRate`
      ),
      `${sourceLabel}.guardrails.maxRecallFailureRate`
    ),
    maxP95LatencyMs: readNonNegativeNumber(
      readRequiredField(
        guardrails,
        "maxP95LatencyMs",
        `${sourceLabel}.guardrails.maxP95LatencyMs`
      ),
      `${sourceLabel}.guardrails.maxP95LatencyMs`
    ),
    maxIncidentsPer1kRequests: readNonNegativeNumber(
      readRequiredField(
        guardrails,
        "maxIncidentsPer1kRequests",
        `${sourceLabel}.guardrails.maxIncidentsPer1kRequests`
      ),
      `${sourceLabel}.guardrails.maxIncidentsPer1kRequests`
    ),
    maxAnomaliesPer1kRequests: readNonNegativeNumber(
      readRequiredField(
        guardrails,
        "maxAnomaliesPer1kRequests",
        `${sourceLabel}.guardrails.maxAnomaliesPer1kRequests`
      ),
      `${sourceLabel}.guardrails.maxAnomaliesPer1kRequests`
    ),
    maxPolicyReviewRate: readRate(
      readRequiredField(
        guardrails,
        "maxPolicyReviewRate",
        `${sourceLabel}.guardrails.maxPolicyReviewRate`
      ),
      `${sourceLabel}.guardrails.maxPolicyReviewRate`
    ),
    abortOnRollbackSignal: readBoolean(
      readRequiredField(
        guardrails,
        "abortOnRollbackSignal",
        `${sourceLabel}.guardrails.abortOnRollbackSignal`
      ),
      `${sourceLabel}.guardrails.abortOnRollbackSignal`
    ),
  };
}

function buildThresholds(
  tuningRecommendation: ReturnType<typeof readTuningRecommendation> | null
) {
  const maxFailureRate = tuningRecommendation
    ? Math.min(BASE_THRESHOLDS.failureRate, tuningRecommendation.maxFailureRate)
    : BASE_THRESHOLDS.failureRate;
  const minSuccessRate = tuningRecommendation
    ? Math.max(
        BASE_THRESHOLDS.successRate,
        round(1 - tuningRecommendation.maxFailureRate)
      )
    : BASE_THRESHOLDS.successRate;
  const maxP95LatencyMs = tuningRecommendation
    ? Math.min(
        BASE_THRESHOLDS.p95LatencyMs,
        tuningRecommendation.maxP95LatencyMs
      )
    : BASE_THRESHOLDS.p95LatencyMs;
  const maxIncidentsPer1kRequests = tuningRecommendation
    ? Math.min(
        BASE_THRESHOLDS.incidentsPer1kRequests,
        tuningRecommendation.maxIncidentsPer1kRequests
      )
    : BASE_THRESHOLDS.incidentsPer1kRequests;
  const maxRecallFailureRate = tuningRecommendation
    ? Math.min(
        BASE_THRESHOLDS.recallFailureRate,
        tuningRecommendation.maxRecallFailureRate
      )
    : BASE_THRESHOLDS.recallFailureRate;
  const maxAnomaliesPer1kRequests = tuningRecommendation
    ? Math.min(
        BASE_THRESHOLDS.anomaliesPer1kRequests,
        tuningRecommendation.maxAnomaliesPer1kRequests
      )
    : BASE_THRESHOLDS.anomaliesPer1kRequests;
  const maxPolicyReviewRate = tuningRecommendation
    ? Math.min(
        BASE_THRESHOLDS.policyReviewRate,
        tuningRecommendation.maxPolicyReviewRate
      )
    : BASE_THRESHOLDS.policyReviewRate;

  const source = tuningRecommendation
    ? "baseline_and_tuning_guardrails"
    : "baseline";

  return {
    successRate: {
      operator: ">=",
      value: round(minSuccessRate),
      baseline: BASE_THRESHOLDS.successRate,
      tuningDerivedFromMaxFailureRate: tuningRecommendation
        ? tuningRecommendation.maxFailureRate
        : null,
      source,
    },
    failureRate: {
      operator: "<=",
      value: round(maxFailureRate),
      baseline: BASE_THRESHOLDS.failureRate,
      tuning: tuningRecommendation ? tuningRecommendation.maxFailureRate : null,
      source,
    },
    p95LatencyMs: {
      operator: "<=",
      value: round(maxP95LatencyMs, 3),
      baseline: BASE_THRESHOLDS.p95LatencyMs,
      tuning: tuningRecommendation
        ? tuningRecommendation.maxP95LatencyMs
        : null,
      source,
    },
    incidentsPer1kRequests: {
      operator: "<=",
      value: round(maxIncidentsPer1kRequests),
      baseline: BASE_THRESHOLDS.incidentsPer1kRequests,
      tuning: tuningRecommendation
        ? tuningRecommendation.maxIncidentsPer1kRequests
        : null,
      source,
    },
    recallFailureRate: {
      operator: "<=",
      value: round(maxRecallFailureRate),
      baseline: BASE_THRESHOLDS.recallFailureRate,
      tuning: tuningRecommendation
        ? tuningRecommendation.maxRecallFailureRate
        : null,
      source,
    },
    anomaliesPer1kRequests: {
      operator: "<=",
      value: round(maxAnomaliesPer1kRequests),
      baseline: BASE_THRESHOLDS.anomaliesPer1kRequests,
      tuning: tuningRecommendation
        ? tuningRecommendation.maxAnomaliesPer1kRequests
        : null,
      source,
    },
    policyReviewRate: {
      operator: "<=",
      value: round(maxPolicyReviewRate),
      baseline: BASE_THRESHOLDS.policyReviewRate,
      tuning: tuningRecommendation
        ? tuningRecommendation.maxPolicyReviewRate
        : null,
      source,
    },
  };
}

function aggregateMeasurements(
  dashboards: readonly ReturnType<typeof readDashboard>[]
) {
  let requestVolume = 0;
  let successCount = 0;
  let failureCount = 0;
  let incidentCount = 0;
  let recallRequestVolume = 0;
  let recallFailureCount = 0;
  let anomalyCount = 0;
  let policyReviewOrDenyCount = 0;
  let p95LatencyMs = null;
  let latencyContributors = 0;

  for (const dashboard of dashboards) {
    requestVolume += dashboard.requestVolume;
    successCount += dashboard.successCount;
    failureCount += dashboard.failureCount;
    incidentCount += dashboard.incidentCount;
    recallRequestVolume += dashboard.recallRequestVolume;
    recallFailureCount += dashboard.recallFailureCount;
    anomalyCount += dashboard.anomalyCount;
    policyReviewOrDenyCount += dashboard.policyReviewOrDenyCount;

    const candidateLatency =
      dashboard.p95LatencyMs ?? dashboard.p95LatencyEstimateMs;
    if (candidateLatency !== null) {
      latencyContributors += 1;
      p95LatencyMs =
        p95LatencyMs === null
          ? candidateLatency
          : Math.max(p95LatencyMs, candidateLatency);
    }
  }

  return {
    dashboardCount: dashboards.length,
    requestVolume,
    successCount,
    failureCount,
    successRate: roundRateOrNull(successCount, requestVolume),
    failureRate: roundRateOrNull(failureCount, requestVolume),
    p95LatencyMs: p95LatencyMs === null ? null : round(p95LatencyMs, 3),
    latencyContributorCount: latencyContributors,
    incidentCount,
    incidentsPer1kRequests: roundPerThousandOrNull(
      incidentCount,
      requestVolume
    ),
    recallRequestVolume,
    recallFailureCount,
    recallFailureRate: roundRateOrNull(recallFailureCount, recallRequestVolume),
    anomalyCount,
    anomaliesPer1kRequests: roundPerThousandOrNull(anomalyCount, requestVolume),
    policyReviewOrDenyCount,
    policyReviewRate: roundRateOrNull(policyReviewOrDenyCount, requestVolume),
  };
}

function evaluateObjectives(
  measurements: ReturnType<typeof aggregateMeasurements>,
  thresholds: ReturnType<typeof buildThresholds>
) {
  const failures: Array<{
    objective: string;
    description: string;
    operator: "<=" | ">=";
    threshold: number;
    actual: number | null;
    reason: "missing_measurement" | "threshold_breach";
  }> = [];

  for (const objective of OBJECTIVES) {
    const objectiveKey = objective.key as keyof typeof thresholds &
      keyof typeof measurements;
    const threshold = thresholds[objectiveKey];
    const actual = measurements[objectiveKey];
    let passed = false;

    if (actual !== null) {
      if (threshold.operator === "<=") {
        passed = actual <= threshold.value + 1e-9;
      } else if (threshold.operator === ">=") {
        passed = actual + 1e-9 >= threshold.value;
      } else {
        throw new Error(
          `Unsupported threshold operator: ${threshold.operator}`
        );
      }
    }

    if (!passed) {
      failures.push({
        objective: objective.key,
        description: objective.description,
        operator: threshold.operator as "<=" | ">=",
        threshold: threshold.value,
        actual,
        reason: actual === null ? "missing_measurement" : "threshold_breach",
      });
    }
  }

  return failures;
}

function buildActionPlan(
  failedObjectives: readonly {
    readonly objective: string;
  }[]
) {
  if (failedObjectives.length === 0) {
    return [
      {
        priority: 1,
        objective: "all",
        action:
          "SLO objectives are met. Continue daily evaluation and monitor trend drift.",
      },
    ];
  }

  return failedObjectives.map((failure, index: number) => {
    const objectiveKey = String(
      failure.objective
    ) as keyof typeof ACTION_BY_OBJECTIVE;
    return {
      priority: index + 1,
      objective: failure.objective,
      action: ACTION_BY_OBJECTIVE[objectiveKey],
    };
  });
}

export function evaluateProductionSlos(
  dashboards: readonly unknown[],
  {
    tuningRecommendation = null,
    evaluatedAt,
    dashboardSources = [],
    tuningSource = null,
  }: EvaluateProductionSloOptions = {}
) {
  if (!Array.isArray(dashboards) || dashboards.length === 0) {
    throw new Error("Expected at least one pilot KPI dashboard object.");
  }

  const normalizedEvaluatedAt = toIsoTimestamp(evaluatedAt);
  if (!normalizedEvaluatedAt) {
    throw new Error("evaluatedAt must be an RFC3339 timestamp.");
  }

  if (!Array.isArray(dashboardSources)) {
    throw new Error("dashboardSources must be an array when provided.");
  }
  if (
    dashboardSources.length > 0 &&
    dashboardSources.length !== dashboards.length
  ) {
    throw new Error(
      "dashboardSources length must match dashboards length when provided."
    );
  }

  const normalizedDashboards = dashboards.map((dashboard, index) =>
    readDashboard(dashboard, `dashboards[${index}]`)
  );
  const normalizedTuning = tuningRecommendation
    ? readTuningRecommendation(tuningRecommendation, "tuningRecommendation")
    : null;

  const thresholds = buildThresholds(normalizedTuning);
  const measurements = aggregateMeasurements(normalizedDashboards);
  const failedObjectives = evaluateObjectives(measurements, thresholds);
  const verdict = failedObjectives.length === 0 ? "pass" : "fail";
  const actionPlan = buildActionPlan(failedObjectives);

  const sortedSources =
    dashboardSources.length > 0
      ? [...dashboardSources].sort(compareStrings)
      : [];

  return {
    schemaVersion: SLO_EVALUATION_SCHEMA_VERSION,
    evaluatedAt: normalizedEvaluatedAt,
    inputs: {
      dashboardCount: dashboards.length,
      dashboardSources: sortedSources,
      dashboardSchemaVersion: DASHBOARD_SCHEMA_VERSION,
      tuningProvided: Boolean(normalizedTuning),
      tuningSource: normalizedTuning ? (tuningSource ?? "inline") : null,
      tuningSchemaVersion: normalizedTuning ? TUNING_SCHEMA_VERSION : null,
    },
    thresholds,
    measurements,
    verdict,
    failedObjectives,
    actionPlan,
  };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dashboard: [],
    tuning: "",
    output: "",
    compact: false,
    evaluatedAt: "",
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
    if (token === "--dashboard" || token === "--input") {
      const value = (args.shift() ?? "").trim();
      if (!value) {
        throw new Error(`Missing value for ${token}.`);
      }
      parsed.dashboard.push(value);
      continue;
    }
    if (token === "--tuning") {
      parsed.tuning = (args.shift() ?? "").trim();
      if (!parsed.tuning) {
        throw new Error("Missing value for --tuning.");
      }
      continue;
    }
    if (token === "--evaluated-at") {
      parsed.evaluatedAt = (args.shift() ?? "").trim();
      if (!parsed.evaluatedAt) {
        throw new Error("Missing value for --evaluated-at.");
      }
      continue;
    }
    if (token === "--output") {
      parsed.output = (args.shift() ?? "").trim();
      if (!parsed.output) {
        throw new Error("Missing value for --output.");
      }
      continue;
    }
    if (token === "--compact") {
      parsed.compact = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!parsed.help && parsed.dashboard.length === 0) {
    throw new Error(
      "Missing required --dashboard <path> argument (repeat for multiple dashboard files)."
    );
  }
  if (!parsed.help && !parsed.evaluatedAt) {
    throw new Error("Missing required --evaluated-at <RFC3339> argument.");
  }

  return parsed;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/evaluate-production-slos.ts --dashboard <dashboard.json> [--dashboard <dashboard.json> ...]",
      "    [--tuning <ranking-decay-tuning.json>] --evaluated-at <RFC3339> [--output <path>] [--compact]",
      "",
      "Notes:",
      "  - --dashboard expects one or more pilot KPI dashboard JSON files.",
      "  - --tuning is optional and expects pilot ranking/decay tuning JSON.",
      "  - --evaluated-at is required to keep output deterministic.",
      "",
      "Example:",
      "  bun scripts/evaluate-production-slos.ts --dashboard docs/reports/pilot-rollout/pilot-a-kpi-dashboard.json \\",
      "    --tuning docs/reports/pilot-rollout/pilot-a-ranking-decay-tuning.json \\",
      "    --evaluated-at 2026-03-02T18:30:00Z --output docs/reports/pilot-rollout/pilot-a-production-slo-eval.json",
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
  ioState: {
    stdinConsumed: boolean;
    stdinCache: string;
  }
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
): JsonObject {
  let parsed;
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

export async function main(argv = process.argv.slice(2)) {
  const parsedArgs = parseArgs(argv);
  if (parsedArgs.help) {
    printUsage();
    return 0;
  }

  const ioState = { stdinConsumed: false, stdinCache: "" };
  const dashboards: JsonObject[] = [];
  for (const dashboardPath of parsedArgs.dashboard) {
    const rawDashboard = await readInput(dashboardPath, ioState);
    dashboards.push(parseJsonObject(rawDashboard, dashboardPath, "dashboard"));
  }

  let tuningRecommendation = null;
  if (parsedArgs.tuning) {
    const rawTuning = await readInput(parsedArgs.tuning, ioState);
    tuningRecommendation = parseJsonObject(
      rawTuning,
      parsedArgs.tuning,
      "tuning recommendation"
    );
  }

  const evaluation = evaluateProductionSlos(dashboards, {
    tuningRecommendation,
    evaluatedAt: parsedArgs.evaluatedAt,
    dashboardSources: parsedArgs.dashboard,
    tuningSource: parsedArgs.tuning || null,
  });
  const output = `${JSON.stringify(evaluation, null, parsedArgs.compact ? 0 : 2)}\n`;

  if (parsedArgs.output) {
    const resolvedPath = resolve(process.cwd(), parsedArgs.output);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, output, "utf8");
  }

  process.stdout.write(output);
  return evaluation.verdict === "pass" ? 0 : 2;
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
        `evaluate-production-slos failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
