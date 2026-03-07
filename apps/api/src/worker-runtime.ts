import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Predicate,
  Schema,
} from "effect";

import {
  DEFAULT_RUNTIME_STATE_FILE,
  executeRuntimeOperation,
  loadRuntimeStoreSnapshot,
} from "./runtime-service.ts";

const DEFAULT_REPLAY_EVAL_MAX_PER_PROFILE = 5;
const DEFAULT_MAX_ERROR_ENTRIES = 25;
const DEFAULT_WORKER_INTERVAL_MS = 30_000;
const DEFAULT_RESTART_LIMIT = 3;
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_STORE_ID = "coding-agent";

interface StoreProfilePair {
  storeId: string;
  profile: string;
}

interface WorkerProfileSnapshot extends Record<string, unknown> {
  shadowCandidates?: unknown[];
  outcomes?: unknown[];
  feedback?: unknown[];
  replayEvaluations?: unknown[];
}

interface WorkerStoreEntrySnapshot extends Record<string, unknown> {
  profiles?: Record<string, unknown>;
}

interface WorkerStoreSnapshot extends Record<string, unknown> {
  stores?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
}

interface WorkerOperationRequestBody extends Record<string, unknown> {
  storeId: string;
  profile: string;
  timestamp: string;
  candidateId?: string;
}

interface ReplayEvalAutopilotMetrics {
  successRateDelta: number;
  reopenRateDelta: number;
  latencyP95DeltaMs: number;
  tokenCostDelta: number;
  policyViolationsDelta: number;
  hallucinationFlagDelta: number;
  canarySuccessRateDelta: number;
  canaryErrorRateDelta: number;
  canaryLatencyP95DeltaMs: number;
  canaryPolicyViolationsDelta: number;
  canaryHallucinationFlagDelta: number;
  metadata: Record<string, unknown>;
}

interface RunOperationInput {
  operation: string;
  requestBody: unknown;
  stateFile?: string | null | undefined;
}

interface LoadSnapshotInput {
  stateFile?: string | null | undefined;
}

type RunOperation = (input: RunOperationInput) => Promise<unknown>;
type LoadSnapshot = (input: LoadSnapshotInput) => Promise<WorkerStoreSnapshot>;

interface WorkerCycleErrorEntry {
  storeId: string;
  profile: string;
  operation: string;
  candidateId: string | null;
  code: string | null;
  message: string;
}

interface WorkerCycleErrorInput {
  storeId: string;
  profile: string;
  operation: string;
  candidateId?: string | null;
  error: unknown;
}

interface WorkerCycleCounter {
  attempted: number;
  succeeded: number;
  failed: number;
}

interface WorkerReplayEvalCounter extends WorkerCycleCounter {
  candidatesSeen: number;
  skippedByLimit: number;
}

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ErrorWithMessageSchema = Schema.Struct({
  message: Schema.String,
});

const isString = Schema.is(Schema.String);
const isUnknownRecord = Schema.is(UnknownRecordSchema);
const isErrorWithMessage = Schema.is(ErrorWithMessageSchema);

export interface WorkerCycleSummary {
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  stateFile: string | null;
  profileCount: number;
  replayEvalMaxPerProfile: number;
  reviewScheduleClock: WorkerCycleCounter;
  replayEval: WorkerReplayEvalCounter;
  doctor: WorkerCycleCounter;
  errorCount: number;
  errorOverflowCount: number;
  errors: WorkerCycleErrorEntry[];
}

interface CreateEmptyCycleSummaryInput {
  startedAt: string;
  stateFile?: string | null | undefined;
  replayEvalMaxPerProfile: number;
}

export interface RunBackgroundWorkerCycleOptions {
  stateFile?: string | null | undefined;
  replayEvalMaxPerProfile?: unknown;
  maxErrorEntries?: unknown;
  timestamp?: unknown;
  runOperation?: RunOperation;
  loadSnapshot?: LoadSnapshot;
}

type RunCycle = (
  options?: Partial<RunBackgroundWorkerCycleOptions>
) => Promise<WorkerCycleSummary>;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isUnknownRecord(value) && !Array.isArray(value);
}

function toErrorMessage(cause: unknown): string {
  if (Predicate.isError(cause) || isErrorWithMessage(cause)) {
    return cause.message;
  }
  return String(cause);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (!isString(value)) {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeNonNegativeInteger(
  value: unknown,
  fallback: number,
  fieldName: string
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0) {
    throw new Error(`${fieldName} must be >= 0.`);
  }
  return parsed;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  fieldName: string
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed <= 0) {
    throw new Error(`${fieldName} must be > 0.`);
  }
  return parsed;
}

function loadSnapshotFromStateFile(
  stateFile: string | null | undefined = DEFAULT_RUNTIME_STATE_FILE
): Promise<WorkerStoreSnapshot> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => loadRuntimeStoreSnapshot({ stateFile }),
      catch: (cause) =>
        Predicate.isError(cause) ? cause : new Error(toErrorMessage(cause)),
    }).pipe(
      Effect.flatMap((snapshot) =>
        isRecord(snapshot)
          ? Effect.succeed(snapshot as WorkerStoreSnapshot)
          : Effect.fail(
              new Error("State file must contain a top-level object.")
            )
      )
    )
  );
}

function listStoreProfilePairs(
  snapshot: WorkerStoreSnapshot | null | undefined
): StoreProfilePair[] {
  const pairs: StoreProfilePair[] = [];
  if (!isRecord(snapshot)) {
    return pairs;
  }

  if (isRecord(snapshot.stores)) {
    const stores = snapshot.stores;
    for (const storeId of Object.keys(stores).sort((left, right) =>
      left.localeCompare(right)
    )) {
      const storeEntry = stores[storeId];
      const profiles = isRecord(storeEntry)
        ? (storeEntry as WorkerStoreEntrySnapshot).profiles
        : undefined;
      const profileMap = isRecord(profiles) ? profiles : {};
      const sortedProfiles = Object.keys(profileMap).sort((left, right) =>
        left.localeCompare(right)
      );
      const nonDefaultProfiles = sortedProfiles.filter(
        (profile) => profile !== "__store_default__"
      );
      const profilesToVisit =
        nonDefaultProfiles.length > 0 ? nonDefaultProfiles : sortedProfiles;
      for (const profile of profilesToVisit) {
        pairs.push({ storeId, profile });
      }
    }
    return pairs;
  }

  if (isRecord(snapshot["profiles"])) {
    const sortedProfiles = Object.keys(snapshot["profiles"]).sort(
      (left, right) => left.localeCompare(right)
    );
    const nonDefaultProfiles = sortedProfiles.filter(
      (profile) => profile !== "__store_default__"
    );
    const profilesToVisit =
      nonDefaultProfiles.length > 0 ? nonDefaultProfiles : sortedProfiles;
    for (const profile of profilesToVisit) {
      pairs.push({ storeId: DEFAULT_STORE_ID, profile });
    }
  }

  return pairs;
}

function getProfileSnapshot(
  snapshot: WorkerStoreSnapshot | null | undefined,
  storeId: string,
  profile: string
): WorkerProfileSnapshot | null {
  if (!isRecord(snapshot)) {
    return null;
  }

  if (isRecord(snapshot.stores)) {
    const storeEntry = snapshot.stores[storeId];
    if (isRecord(storeEntry) && isRecord(storeEntry["profiles"])) {
      const profileEntry = storeEntry["profiles"][profile];
      return isRecord(profileEntry)
        ? (profileEntry as WorkerProfileSnapshot)
        : null;
    }
    return null;
  }

  if (isRecord(snapshot["profiles"])) {
    const profileEntry = snapshot["profiles"][profile];
    return isRecord(profileEntry)
      ? (profileEntry as WorkerProfileSnapshot)
      : null;
  }

  return null;
}

function listShadowCandidateIds(
  profileState: WorkerProfileSnapshot | null
): string[] {
  if (profileState === null || !Array.isArray(profileState.shadowCandidates)) {
    return [];
  }
  const ids = new Set<string>();
  for (const candidate of profileState.shadowCandidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const candidateId = normalizeNonEmptyString(candidate["candidateId"]);
    if (!candidateId) {
      continue;
    }
    const status = normalizeNonEmptyString(candidate["status"])?.toLowerCase();
    if (status && status !== "shadow") {
      continue;
    }
    ids.add(candidateId);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function roundNumber(value: number, precision = 6): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (!Predicate.isNumber(value) || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeIsoMillis(value: unknown): number | null {
  if (!isString(value)) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeNonEmptyString(entry);
    if (normalized) {
      values.add(normalized);
    }
  }
  return [...values];
}

function resolveCandidateSnapshot(
  profileState: WorkerProfileSnapshot | null,
  candidateId: string
): Record<string, unknown> | null {
  if (profileState === null || !Array.isArray(profileState.shadowCandidates)) {
    return null;
  }
  for (const entry of profileState.shadowCandidates) {
    if (!isRecord(entry)) {
      continue;
    }
    const currentCandidateId = normalizeNonEmptyString(entry["candidateId"]);
    if (currentCandidateId === candidateId) {
      return entry;
    }
  }
  return null;
}

function resolveLatestReplayEvalMillisForCandidate(
  profileState: WorkerProfileSnapshot | null,
  candidateId: string
): number | null {
  if (profileState === null || !Array.isArray(profileState.replayEvaluations)) {
    return null;
  }
  let latest: number | null = null;
  for (const entry of profileState.replayEvaluations) {
    if (!isRecord(entry)) {
      continue;
    }
    const currentCandidateId = normalizeNonEmptyString(entry["candidateId"]);
    if (currentCandidateId !== candidateId) {
      continue;
    }
    const evaluatedAtMillis = normalizeIsoMillis(entry["evaluatedAt"]);
    if (evaluatedAtMillis === null) {
      continue;
    }
    if (latest === null || evaluatedAtMillis > latest) {
      latest = evaluatedAtMillis;
    }
  }
  return latest;
}

function resolveCandidateUtilityBaseline(
  candidate: Record<string, unknown> | null
): number {
  if (candidate === null) {
    return 0.5;
  }
  const metadata = isRecord(candidate["metadata"])
    ? candidate["metadata"]
    : null;
  const utilitySignal =
    metadata !== null && isRecord(metadata["utilitySignal"])
      ? metadata["utilitySignal"]
      : null;
  const utilityScore = normalizeFiniteNumber(
    utilitySignal !== null ? utilitySignal["score"] : undefined
  );
  if (utilityScore !== null) {
    return clamp(utilityScore, 0, 1);
  }
  const candidateConfidence = normalizeFiniteNumber(candidate["confidence"]);
  if (candidateConfidence !== null) {
    return clamp(candidateConfidence, 0, 1);
  }
  return 0.5;
}

function isEventAfterReference(
  eventMillis: number | null,
  referenceMillis: number | null
): boolean {
  if (referenceMillis === null) {
    return true;
  }
  if (eventMillis === null) {
    return true;
  }
  return eventMillis >= referenceMillis;
}

function deriveReplayEvalAutopilotMetrics(
  profileState: WorkerProfileSnapshot | null,
  candidateId: string
): ReplayEvalAutopilotMetrics {
  const candidate = resolveCandidateSnapshot(profileState, candidateId);
  const ruleId =
    candidate !== null ? normalizeNonEmptyString(candidate["ruleId"]) : null;
  const replayReferenceMillis = resolveLatestReplayEvalMillisForCandidate(
    profileState,
    candidateId
  );
  const replayReferenceIso =
    replayReferenceMillis === null
      ? null
      : new Date(replayReferenceMillis).toISOString();

  let globalOutcomeTotal = 0;
  let globalOutcomeSuccess = 0;
  let globalOutcomeFailure = 0;
  let candidateOutcomeTotal = 0;
  let candidateOutcomeSuccess = 0;
  let candidateOutcomeFailure = 0;

  if (profileState !== null && Array.isArray(profileState.outcomes)) {
    for (const entry of profileState.outcomes) {
      if (!isRecord(entry)) {
        continue;
      }
      const eventMillis = normalizeIsoMillis(entry["recordedAt"]);
      if (!isEventAfterReference(eventMillis, replayReferenceMillis)) {
        continue;
      }
      const outcomeValue = normalizeNonEmptyString(
        entry["outcome"]
      )?.toLowerCase();
      if (outcomeValue !== "success" && outcomeValue !== "failure") {
        continue;
      }
      globalOutcomeTotal += 1;
      if (outcomeValue === "success") {
        globalOutcomeSuccess += 1;
      } else {
        globalOutcomeFailure += 1;
      }

      if (!ruleId) {
        continue;
      }
      const usedRuleIds = parseStringArray(entry["usedRuleIds"]);
      if (!usedRuleIds.includes(ruleId)) {
        continue;
      }
      candidateOutcomeTotal += 1;
      if (outcomeValue === "success") {
        candidateOutcomeSuccess += 1;
      } else {
        candidateOutcomeFailure += 1;
      }
    }
  }

  const globalSuccessRate =
    globalOutcomeTotal > 0 ? globalOutcomeSuccess / globalOutcomeTotal : 0.5;
  const globalFailureRate =
    globalOutcomeTotal > 0 ? globalOutcomeFailure / globalOutcomeTotal : 0.5;
  const utilityBaseline = resolveCandidateUtilityBaseline(candidate);
  const candidateSuccessRate =
    candidateOutcomeTotal > 0
      ? candidateOutcomeSuccess / candidateOutcomeTotal
      : utilityBaseline;
  const candidateFailureRate =
    candidateOutcomeTotal > 0
      ? candidateOutcomeFailure / candidateOutcomeTotal
      : 1 - utilityBaseline;

  let globalFeedbackTotal = 0;
  let globalHarmfulFeedbackTotal = 0;
  let candidateFeedbackTotal = 0;
  let candidateHarmfulFeedbackTotal = 0;

  if (profileState !== null && Array.isArray(profileState.feedback)) {
    for (const entry of profileState.feedback) {
      if (!isRecord(entry)) {
        continue;
      }
      const eventMillis = normalizeIsoMillis(entry["recordedAt"]);
      if (!isEventAfterReference(eventMillis, replayReferenceMillis)) {
        continue;
      }
      const signal = normalizeNonEmptyString(entry["signal"])?.toLowerCase();
      if (signal !== "helpful" && signal !== "harmful") {
        continue;
      }

      globalFeedbackTotal += 1;
      if (signal === "harmful") {
        globalHarmfulFeedbackTotal += 1;
      }

      const targetCandidateId = normalizeNonEmptyString(
        entry["targetCandidateId"]
      );
      const targetRuleId = normalizeNonEmptyString(entry["targetRuleId"]);
      const candidateMatch =
        targetCandidateId === candidateId ||
        (Boolean(ruleId) && targetRuleId === ruleId);
      if (!candidateMatch) {
        continue;
      }
      candidateFeedbackTotal += 1;
      if (signal === "harmful") {
        candidateHarmfulFeedbackTotal += 1;
      }
    }
  }

  const globalHarmfulRate =
    globalFeedbackTotal > 0
      ? globalHarmfulFeedbackTotal / globalFeedbackTotal
      : 0;
  const candidateHarmfulRate =
    candidateFeedbackTotal > 0
      ? candidateHarmfulFeedbackTotal / candidateFeedbackTotal
      : 0;
  const harmfulRateDelta = clamp(
    candidateHarmfulRate - globalHarmfulRate,
    -1,
    1
  );

  const successRateDelta = roundNumber(
    clamp(candidateSuccessRate - globalSuccessRate, -1, 1)
  );
  const reopenRateDelta = roundNumber(
    clamp(candidateFailureRate - globalFailureRate, -1, 1)
  );
  const policyViolationsDelta = roundNumber(Math.max(0, harmfulRateDelta));
  const hallucinationFlagDelta = roundNumber(
    Math.max(0, harmfulRateDelta * 0.5)
  );

  return {
    successRateDelta,
    reopenRateDelta,
    latencyP95DeltaMs: 0,
    tokenCostDelta: 0,
    policyViolationsDelta,
    hallucinationFlagDelta,
    canarySuccessRateDelta: roundNumber(clamp(successRateDelta * 0.5, -1, 1)),
    canaryErrorRateDelta: reopenRateDelta,
    canaryLatencyP95DeltaMs: 0,
    canaryPolicyViolationsDelta: policyViolationsDelta,
    canaryHallucinationFlagDelta: hallucinationFlagDelta,
    metadata: {
      source: "worker_outcome_autopilot",
      referenceEvaluatedAt: replayReferenceIso,
      observedGlobalOutcomes: globalOutcomeTotal,
      observedCandidateOutcomes: candidateOutcomeTotal,
      observedGlobalFeedback: globalFeedbackTotal,
      observedCandidateFeedback: candidateFeedbackTotal,
      candidateRuleId: ruleId,
      utilityBaseline: roundNumber(utilityBaseline),
    },
  };
}

function runOperationWithRuntimeService({
  operation,
  requestBody,
  stateFile = DEFAULT_RUNTIME_STATE_FILE,
}: RunOperationInput): Promise<unknown> {
  return executeRuntimeOperation({
    operation,
    stateFile,
    requestBody,
  });
}

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return structuredClone(value) as T;
}

function createEmptyCycleSummary({
  startedAt,
  stateFile,
  replayEvalMaxPerProfile,
}: CreateEmptyCycleSummaryInput): WorkerCycleSummary {
  return {
    startedAt,
    completedAt: null,
    durationMs: 0,
    stateFile: stateFile ?? null,
    profileCount: 0,
    replayEvalMaxPerProfile,
    reviewScheduleClock: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    replayEval: {
      candidatesSeen: 0,
      skippedByLimit: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    doctor: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    errorCount: 0,
    errorOverflowCount: 0,
    errors: [] as WorkerCycleErrorEntry[],
  };
}

function finalizeCycleSummary(summary: WorkerCycleSummary): WorkerCycleSummary {
  const completedAt = nowIso();
  summary.completedAt = completedAt;
  summary.durationMs = Math.max(
    0,
    Date.parse(completedAt) - Date.parse(summary.startedAt)
  );
  return summary;
}

export async function runBackgroundWorkerCycle(
  options: RunBackgroundWorkerCycleOptions = {}
): Promise<WorkerCycleSummary> {
  const stateFile = Object.hasOwn(options, "stateFile")
    ? options.stateFile
    : DEFAULT_RUNTIME_STATE_FILE;
  const replayEvalMaxPerProfile = normalizeNonNegativeInteger(
    options.replayEvalMaxPerProfile,
    DEFAULT_REPLAY_EVAL_MAX_PER_PROFILE,
    "replayEvalMaxPerProfile"
  );
  const maxErrorEntries = normalizePositiveInteger(
    options.maxErrorEntries,
    DEFAULT_MAX_ERROR_ENTRIES,
    "maxErrorEntries"
  );
  const runOperation = Predicate.isFunction(options.runOperation)
    ? options.runOperation
    : runOperationWithRuntimeService;
  const loadSnapshot = Predicate.isFunction(options.loadSnapshot)
    ? options.loadSnapshot
    : ({ stateFile: currentStateFile }: LoadSnapshotInput) =>
        loadSnapshotFromStateFile(currentStateFile);

  const startedAt = nowIso();
  const timestamp = normalizeNonEmptyString(options.timestamp) ?? startedAt;
  const summary = createEmptyCycleSummary({
    startedAt,
    stateFile: stateFile ?? null,
    replayEvalMaxPerProfile,
  });
  const snapshot = await loadSnapshot({ stateFile });
  const pairs = listStoreProfilePairs(snapshot);
  summary.profileCount = pairs.length;

  const appendError = ({
    storeId,
    profile,
    operation,
    candidateId = null,
    error,
  }: WorkerCycleErrorInput): void => {
    summary.errorCount += 1;
    if (summary.errors.length < maxErrorEntries) {
      const code =
        isRecord(error) && "code" in error && isString(error["code"])
          ? error["code"]
          : null;
      summary.errors.push({
        storeId,
        profile,
        operation,
        candidateId,
        code,
        message: toErrorMessage(error),
      });
      return;
    }
    summary.errorOverflowCount += 1;
  };

  for (const { storeId, profile } of pairs) {
    const profileSnapshot = getProfileSnapshot(snapshot, storeId, profile);
    const baseRequest: WorkerOperationRequestBody = {
      storeId,
      profile,
      timestamp,
    };

    summary.reviewScheduleClock.attempted += 1;
    try {
      await runOperation({
        operation: "review_schedule_clock",
        requestBody: baseRequest,
        stateFile,
      });
      summary.reviewScheduleClock.succeeded += 1;
    } catch (error) {
      summary.reviewScheduleClock.failed += 1;
      appendError({
        storeId,
        profile,
        operation: "review_schedule_clock",
        error,
      });
    }

    const candidateIds = listShadowCandidateIds(profileSnapshot);
    summary.replayEval.candidatesSeen += candidateIds.length;
    const selectedCandidateIds = candidateIds.slice(0, replayEvalMaxPerProfile);
    summary.replayEval.skippedByLimit += Math.max(
      0,
      candidateIds.length - selectedCandidateIds.length
    );

    for (const candidateId of selectedCandidateIds) {
      summary.replayEval.attempted += 1;
      const replayEvalMetrics = deriveReplayEvalAutopilotMetrics(
        profileSnapshot,
        candidateId
      );
      try {
        await runOperation({
          operation: "replay_eval",
          requestBody: {
            ...baseRequest,
            candidateId,
            successRateDelta: replayEvalMetrics.successRateDelta,
            reopenRateDelta: replayEvalMetrics.reopenRateDelta,
            latencyP95DeltaMs: replayEvalMetrics.latencyP95DeltaMs,
            tokenCostDelta: replayEvalMetrics.tokenCostDelta,
            policyViolationsDelta: replayEvalMetrics.policyViolationsDelta,
            hallucinationFlagDelta: replayEvalMetrics.hallucinationFlagDelta,
            canarySuccessRateDelta: replayEvalMetrics.canarySuccessRateDelta,
            canaryErrorRateDelta: replayEvalMetrics.canaryErrorRateDelta,
            canaryLatencyP95DeltaMs: replayEvalMetrics.canaryLatencyP95DeltaMs,
            canaryPolicyViolationsDelta:
              replayEvalMetrics.canaryPolicyViolationsDelta,
            canaryHallucinationFlagDelta:
              replayEvalMetrics.canaryHallucinationFlagDelta,
            metadata: replayEvalMetrics.metadata,
          },
          stateFile,
        });
        summary.replayEval.succeeded += 1;
      } catch (error) {
        summary.replayEval.failed += 1;
        appendError({
          storeId,
          profile,
          operation: "replay_eval",
          candidateId,
          error,
        });
      }
    }

    summary.doctor.attempted += 1;
    try {
      await runOperation({
        operation: "doctor",
        requestBody: baseRequest,
        stateFile,
      });
      summary.doctor.succeeded += 1;
    } catch (error) {
      summary.doctor.failed += 1;
      appendError({
        storeId,
        profile,
        operation: "doctor",
        error,
      });
    }
  }

  return finalizeCycleSummary(summary);
}

type WorkerServicePhase =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "stopping"
  | "stopped"
  | "failed";

interface WorkerLastCycleSnapshot {
  startedAt: string;
  completedAt: string;
  summary: WorkerCycleSummary | null;
}

export interface SupervisedWorkerStatusSnapshot {
  phase: WorkerServicePhase;
  stateFile: string | null;
  intervalMs: number;
  restartCount: number;
  restartLimit: number;
  cycleCount: number;
  lastCycle: WorkerLastCycleSnapshot | null;
  lastError: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

interface SupervisedWorkerStatusState extends SupervisedWorkerStatusSnapshot {}

interface WorkerReadinessSnapshot {
  cycleCount: number;
  lastCycle: WorkerLastCycleSnapshot | null;
}

export interface SupervisedWorkerService {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  ready: () => Promise<WorkerReadinessSnapshot>;
  status: () => SupervisedWorkerStatusSnapshot;
}

interface CreateSupervisedWorkerServiceOptions {
  stateFile?: string | null | undefined;
  intervalMs?: unknown;
  restartLimit?: unknown;
  restartDelayMs?: unknown;
  replayEvalMaxPerProfile?: unknown;
  maxErrorEntries?: unknown;
  captureProcessSignals?: boolean;
  runCycle?: RunCycle;
  runOperation?: RunOperation;
}

interface StartSupervisedWorkerServiceResult extends WorkerReadinessSnapshot {
  service: SupervisedWorkerService;
}

interface CycleResultSuccess {
  status: "success";
  summary: WorkerCycleSummary;
}

interface CycleResultFailure {
  status: "failure";
  error: Error;
}

type WorkerCycleResult = CycleResultSuccess | CycleResultFailure;

export function createSupervisedWorkerService(
  options: CreateSupervisedWorkerServiceOptions = {}
): SupervisedWorkerService {
  const stateFile = Object.hasOwn(options, "stateFile")
    ? options.stateFile
    : (process.env["UMS_WORKER_STATE_FILE"] ?? DEFAULT_RUNTIME_STATE_FILE);
  const intervalMs = normalizePositiveInteger(
    options.intervalMs ?? process.env["UMS_WORKER_INTERVAL_MS"],
    DEFAULT_WORKER_INTERVAL_MS,
    "intervalMs"
  );
  const restartLimit = normalizeNonNegativeInteger(
    options.restartLimit ?? process.env["UMS_WORKER_RESTART_LIMIT"],
    DEFAULT_RESTART_LIMIT,
    "restartLimit"
  );
  const restartDelayMs = normalizePositiveInteger(
    options.restartDelayMs ?? process.env["UMS_WORKER_RESTART_DELAY_MS"],
    DEFAULT_RESTART_DELAY_MS,
    "restartDelayMs"
  );
  const replayEvalMaxPerProfile = normalizeNonNegativeInteger(
    options.replayEvalMaxPerProfile ??
      process.env["UMS_WORKER_REPLAY_EVAL_MAX_PER_PROFILE"],
    DEFAULT_REPLAY_EVAL_MAX_PER_PROFILE,
    "replayEvalMaxPerProfile"
  );
  const maxErrorEntries = normalizePositiveInteger(
    options.maxErrorEntries ?? process.env["UMS_WORKER_MAX_ERROR_ENTRIES"],
    DEFAULT_MAX_ERROR_ENTRIES,
    "maxErrorEntries"
  );
  const captureProcessSignals = options.captureProcessSignals !== false;
  const runCycle: RunCycle = Predicate.isFunction(options.runCycle)
    ? options.runCycle
    : (cycleOptions: Partial<RunBackgroundWorkerCycleOptions> = {}) =>
        runBackgroundWorkerCycle({
          stateFile,
          replayEvalMaxPerProfile,
          maxErrorEntries,
          ...(Predicate.isFunction(options.runOperation)
            ? { runOperation: options.runOperation }
            : {}),
          ...cycleOptions,
        });

  const runtime = ManagedRuntime.make(Layer.empty);
  const readySignal = runtime.runSync(
    Deferred.make<WorkerReadinessSnapshot, Error>()
  );
  const shutdownSignal = runtime.runSync(Deferred.make<boolean>());

  const status: SupervisedWorkerStatusState = {
    phase: "idle",
    stateFile: stateFile ?? null,
    intervalMs,
    restartCount: 0,
    restartLimit,
    cycleCount: 0,
    lastCycle: null,
    lastError: null,
    startedAt: null,
    stoppedAt: null,
  };

  let serviceFiber: Fiber.Fiber<void, Error> | null = null;
  let shutdownRequested = false;
  let signalCleanup: (() => void) | null = null;
  let startAttempted = false;
  let runtimeDisposed = false;
  let readySignaled = false;

  const updateStatus = (next: Partial<SupervisedWorkerStatusState>): void => {
    Object.assign(status, next);
  };

  const installSignalHandlers = (): void => {
    if (!captureProcessSignals || signalCleanup !== null) {
      return;
    }
    const onSignal = (): void => {
      void requestShutdown();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    signalCleanup = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      signalCleanup = null;
    };
  };

  const removeSignalHandlers = (): void => {
    if (signalCleanup !== null) {
      signalCleanup();
    }
  };

  const failReadyIfPending = async (error: Error): Promise<void> => {
    if (readySignaled) {
      return;
    }
    readySignaled = true;
    await runtime.runPromise(
      Deferred.fail(readySignal, error).pipe(Effect.ignore)
    );
  };

  const supervisorProgram: Effect.Effect<void, Error> = Effect.gen(
    function* () {
      installSignalHandlers();

      let restartCount = 0;
      while (true) {
        if (shutdownRequested) {
          yield* Effect.sync(() => {
            updateStatus({
              phase: "stopped",
              stoppedAt: nowIso(),
            });
          });
          return;
        }

        const cycleStartedAt = nowIso();
        const cycleResult: WorkerCycleResult = yield* Effect.tryPromise({
          try: () => runCycle({ stateFile }),
          catch: (cause) =>
            Predicate.isError(cause)
              ? cause
              : new Error(`Worker cycle failed: ${toErrorMessage(cause)}`),
        }).pipe(
          Effect.match({
            onSuccess: (summary): CycleResultSuccess => ({
              status: "success",
              summary,
            }),
            onFailure: (error): CycleResultFailure => ({
              status: "failure",
              error,
            }),
          })
        );

        if (cycleResult.status === "success") {
          const nextCycleCount = status.cycleCount + 1;
          updateStatus({
            phase: "running",
            restartCount,
            cycleCount: nextCycleCount,
            lastCycle: {
              startedAt:
                normalizeNonEmptyString(cycleResult.summary?.startedAt) ??
                cycleStartedAt,
              completedAt:
                normalizeNonEmptyString(cycleResult.summary?.completedAt) ??
                nowIso(),
              summary: cycleResult.summary,
            },
            lastError: null,
            stoppedAt: null,
          });
          if (!readySignaled) {
            readySignaled = true;
            yield* Deferred.succeed(readySignal, {
              cycleCount: nextCycleCount,
              lastCycle: status.lastCycle,
            }).pipe(Effect.ignore);
          }

          const pauseSignal = yield* Effect.raceFirst(
            Deferred.await(shutdownSignal).pipe(Effect.as("shutdown")),
            Effect.sleep(Duration.millis(intervalMs)).pipe(
              Effect.as("next_cycle")
            )
          );
          if (pauseSignal === "shutdown" || shutdownRequested) {
            yield* Effect.sync(() => {
              updateStatus({
                phase: "stopped",
                stoppedAt: nowIso(),
              });
            });
            return;
          }
          continue;
        }

        const cycleFailure = cycleResult.error;
        restartCount += 1;
        updateStatus({
          phase: "restarting",
          restartCount,
          lastError: toErrorMessage(cycleFailure),
          lastCycle: {
            startedAt: cycleStartedAt,
            completedAt: nowIso(),
            summary: null,
          },
        });

        if (restartCount > restartLimit) {
          if (!readySignaled) {
            readySignaled = true;
            yield* Deferred.fail(readySignal, cycleFailure).pipe(Effect.ignore);
          }
          updateStatus({
            phase: "failed",
            stoppedAt: nowIso(),
            lastError: toErrorMessage(cycleFailure),
          });
          return yield* Effect.fail(cycleFailure);
        }

        const restartSignal = yield* Effect.raceFirst(
          Deferred.await(shutdownSignal).pipe(Effect.as("shutdown")),
          Effect.sleep(Duration.millis(restartDelayMs)).pipe(
            Effect.as("restart")
          )
        );
        if (restartSignal === "shutdown" || shutdownRequested) {
          yield* Effect.sync(() => {
            updateStatus({
              phase: "stopped",
              stoppedAt: nowIso(),
            });
          });
          return;
        }
      }
    }
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        serviceFiber = null;
        removeSignalHandlers();
      })
    )
  );

  const requestShutdown = async (): Promise<void> => {
    if (runtimeDisposed) {
      return;
    }
    shutdownRequested = true;
    await failReadyIfPending(
      new Error("Supervised worker service stopped before readiness.")
    );
    if (status.phase !== "failed" && status.phase !== "stopped") {
      updateStatus({ phase: "stopping" });
    }
    await runtime.runPromise(
      Deferred.succeed(shutdownSignal, true).pipe(Effect.ignore)
    );
  };

  const start = (): Promise<void> => {
    if (runtimeDisposed) {
      return Promise.reject(
        new Error(
          "Supervised worker service runtime has been disposed and cannot be restarted."
        )
      );
    }
    if (serviceFiber !== null) {
      return Promise.resolve();
    }
    if (
      startAttempted &&
      (status.phase === "stopped" || status.phase === "failed")
    ) {
      return Promise.reject(
        new Error(
          "Supervised worker service runtime cannot be restarted after stop/failure."
        )
      );
    }

    startAttempted = true;
    updateStatus({
      phase: "starting",
      startedAt: status.startedAt ?? nowIso(),
      stoppedAt: null,
    });
    serviceFiber = runtime.runFork(supervisorProgram);
    return Promise.resolve();
  };

  const disposeRuntime = async (): Promise<void> => {
    if (runtimeDisposed) {
      return;
    }
    runtimeDisposed = true;
    await runtime.dispose();
  };

  const stop = async (): Promise<void> => {
    if (serviceFiber === null) {
      if (status.phase !== "failed") {
        updateStatus({
          phase: "stopped",
          stoppedAt: status.stoppedAt ?? nowIso(),
        });
      }
      if (!readySignaled) {
        await failReadyIfPending(
          new Error(
            "Supervised worker service stopped before first successful cycle."
          )
        );
      }
      removeSignalHandlers();
      await disposeRuntime();
      return;
    }

    const activeServiceFiber = serviceFiber;
    await requestShutdown();
    await runtime.runPromise(
      Effect.matchCause(Fiber.await(activeServiceFiber), {
        onFailure: () => null,
        onSuccess: () => null,
      })
    );
    serviceFiber = null;
    if (status.phase !== "failed") {
      updateStatus({
        phase: "stopped",
        stoppedAt: status.stoppedAt ?? nowIso(),
      });
    }
    if (!readySignaled) {
      await failReadyIfPending(
        new Error(
          "Supervised worker service stopped before first successful cycle."
        )
      );
    }
    await disposeRuntime();
  };

  return {
    start,
    stop,
    ready(): Promise<WorkerReadinessSnapshot> {
      return runtime.runPromise(Deferred.await(readySignal));
    },
    status(): SupervisedWorkerStatusSnapshot {
      return {
        phase: status.phase,
        stateFile: status.stateFile,
        intervalMs: status.intervalMs,
        restartCount: status.restartCount,
        restartLimit: status.restartLimit,
        cycleCount: status.cycleCount,
        lastCycle: cloneJson(status.lastCycle),
        lastError: status.lastError,
        startedAt: status.startedAt,
        stoppedAt: status.stoppedAt,
      };
    },
  };
}

export async function startSupervisedWorkerService(
  options: CreateSupervisedWorkerServiceOptions = {}
): Promise<StartSupervisedWorkerServiceResult> {
  const service = createSupervisedWorkerService(options);
  await service.start();
  const readiness = await service.ready();
  return {
    service,
    ...readiness,
  };
}
