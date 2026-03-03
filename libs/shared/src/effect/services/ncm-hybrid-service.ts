import { createHash } from "node:crypto";

import { Effect, Layer, ServiceMap } from "effect";

import type {
  AgentId,
  BatchId,
  ConversationId,
  MemoryId,
  MessageId,
  ProjectId,
  RoleId,
  SourceId,
  SpaceId,
  UserId,
} from "../contracts/index.js";
import { ContractValidationError } from "../errors.js";

export type NcmFeedbackSource = "human_feedback" | "agent_outcome";
export type NcmFeedbackSignal = "helpful" | "failure";
export type NcmDecayAction = "decay" | "reheat" | "stable";

export interface NcmFeedbackProvenanceEnvelope {
  readonly tenantId: SpaceId;
  readonly projectId?: ProjectId;
  readonly roleId?: RoleId;
  readonly userId?: UserId;
  readonly agentId?: AgentId;
  readonly conversationId?: ConversationId;
  readonly messageId?: MessageId;
  readonly sourceId?: SourceId;
  readonly batchId?: BatchId;
}

export interface NcmFeedbackEvent {
  readonly feedbackId: string;
  readonly spaceId: SpaceId;
  readonly memoryId: MemoryId;
  readonly source: NcmFeedbackSource;
  readonly signal: NcmFeedbackSignal;
  readonly actorUserId?: UserId;
  readonly actorAgentId?: AgentId;
  readonly note?: string;
  readonly idempotencyKey?: string;
  readonly occurredAtMillis: number;
  readonly provenance?: NcmFeedbackProvenanceEnvelope;
}

export interface NcmDecayTransitionRecord {
  readonly transitionId: string;
  readonly spaceId: SpaceId;
  readonly memoryId: MemoryId;
  readonly action: NcmDecayAction;
  readonly fromWeight: number;
  readonly toWeight: number;
  readonly netDelta: number;
  readonly reasonCodes: readonly string[];
  readonly sourceFeedbackIds: readonly string[];
  readonly policyDigestSha256: string;
  readonly recordedAtMillis: number;
}

export interface NcmOperatorWeightAdjustmentRecord {
  readonly adjustmentId: string;
  readonly spaceId: SpaceId;
  readonly memoryId: MemoryId;
  readonly actorUserId: UserId;
  readonly reason: string;
  readonly delta: number;
  readonly fromWeight: number;
  readonly toWeight: number;
  readonly recordedAtMillis: number;
  readonly policyDigestSha256: string;
}

export interface NcmTenantPolicyKnobs {
  readonly enableFeedbackIngestion: boolean;
  readonly enableDeterministicDecayReheat: boolean;
  readonly enableManualWeightTuning: boolean;
  readonly failClosed: boolean;
  readonly maxManualWeightDelta: number;
  readonly helpfulSignalBoost: number;
  readonly failureSignalPenalty: number;
  readonly retrievalReheatBoost: number;
  readonly timeDecayFactor: number;
  readonly halfLifeDays: number;
}

export interface NcmTenantPolicy {
  readonly tenantId: SpaceId;
  readonly knobs: NcmTenantPolicyKnobs;
  readonly updatedAtMillis: number;
}

export interface NcmFeedbackIngestionRequest {
  readonly event: NcmFeedbackEvent;
  readonly currentWeight: number;
  readonly recentRetrievalCount?: number;
  readonly lastRetrievedAtMillis?: number;
  readonly nowMillis: number;
  readonly policy?: NcmTenantPolicy;
  readonly existingEvents?: readonly NcmFeedbackEvent[];
  readonly existingTransitions?: readonly NcmDecayTransitionRecord[];
}

export interface NcmFeedbackIngestionResponse {
  readonly action: "created" | "replayed" | "rejected";
  readonly idempotentReplay: boolean;
  readonly policyDeniedReasonCode: string | null;
  readonly event: NcmFeedbackEvent;
  readonly events: readonly NcmFeedbackEvent[];
  readonly transitions: readonly NcmDecayTransitionRecord[];
  readonly computedWeight: number;
  readonly transition: NcmDecayTransitionRecord | null;
  readonly explainability: readonly string[];
}

export interface NcmDecayReheatPolicyRequest {
  readonly spaceId: SpaceId;
  readonly memoryId: MemoryId;
  readonly nowMillis: number;
  readonly currentWeight: number;
  readonly recentRetrievalCount?: number;
  readonly lastRetrievedAtMillis?: number;
  readonly feedbackSignals: readonly NcmFeedbackSignal[];
  readonly policy?: NcmTenantPolicy;
}

export interface NcmDecayReheatPolicyResponse {
  readonly action: NcmDecayAction;
  readonly fromWeight: number;
  readonly toWeight: number;
  readonly netDelta: number;
  readonly reasonCodes: readonly string[];
  readonly explainability: readonly string[];
}

export interface NcmOperatorWeightAdjustmentRequest {
  readonly adjustmentId: string;
  readonly spaceId: SpaceId;
  readonly memoryId: MemoryId;
  readonly actorUserId: UserId;
  readonly reason: string;
  readonly delta: number;
  readonly currentWeight: number;
  readonly nowMillis: number;
  readonly policy?: NcmTenantPolicy;
  readonly existingAdjustments?: readonly NcmOperatorWeightAdjustmentRecord[];
}

export interface NcmOperatorWeightAdjustmentResponse {
  readonly action: "applied" | "replayed" | "rejected";
  readonly idempotentReplay: boolean;
  readonly policyDeniedReasonCode: string | null;
  readonly tunedWeight: number;
  readonly adjustment: NcmOperatorWeightAdjustmentRecord;
  readonly adjustments: readonly NcmOperatorWeightAdjustmentRecord[];
}

export interface NcmConsoleSignalsRequest {
  readonly spaceId: SpaceId;
  readonly memoryId?: MemoryId;
  readonly limit?: number;
  readonly feedbackEvents: readonly NcmFeedbackEvent[];
  readonly decayTransitions: readonly NcmDecayTransitionRecord[];
  readonly operatorAdjustments: readonly NcmOperatorWeightAdjustmentRecord[];
}

export interface NcmConsoleSignalEntry {
  readonly kind: "feedback" | "decay_transition" | "operator_adjustment";
  readonly signalId: string;
  readonly memoryId: MemoryId;
  readonly occurredAtMillis: number;
  readonly summary: string;
  readonly lineageRefs: readonly string[];
}

export interface NcmConsoleSignalsResponse {
  readonly totalFeedbackEvents: number;
  readonly totalDecayTransitions: number;
  readonly totalOperatorAdjustments: number;
  readonly entries: readonly NcmConsoleSignalEntry[];
}

export interface NcmHybridService {
  readonly ingestFeedback: (
    request: NcmFeedbackIngestionRequest
  ) => Effect.Effect<NcmFeedbackIngestionResponse, ContractValidationError>;
  readonly evaluateDecayReheatPolicy: (
    request: NcmDecayReheatPolicyRequest
  ) => Effect.Effect<NcmDecayReheatPolicyResponse, ContractValidationError>;
  readonly applyOperatorWeightAdjustment: (
    request: NcmOperatorWeightAdjustmentRequest
  ) => Effect.Effect<
    NcmOperatorWeightAdjustmentResponse,
    ContractValidationError
  >;
  readonly getConsoleSignals: (
    request: NcmConsoleSignalsRequest
  ) => Effect.Effect<NcmConsoleSignalsResponse, ContractValidationError>;
}

export const NcmHybridServiceTag = ServiceMap.Service<NcmHybridService>(
  "@ums/effect/NcmHybridService"
);

export interface NcmHybridServiceOptions {
  readonly defaultPolicy?: NcmTenantPolicy;
}

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const defaultConsoleLimit = 100;
const lineageEmpty = Object.freeze([]) as readonly string[];
const reasonCodePolicyDisabled = "NCM_POLICY_DISABLED";

const defaultTenantPolicyKnobs: NcmTenantPolicyKnobs = Object.freeze({
  enableFeedbackIngestion: true,
  enableDeterministicDecayReheat: true,
  enableManualWeightTuning: true,
  failClosed: true,
  maxManualWeightDelta: 0.35,
  helpfulSignalBoost: 0.08,
  failureSignalPenalty: 0.2,
  retrievalReheatBoost: 0.035,
  timeDecayFactor: 0.025,
  halfLifeDays: 21,
});

const defaultTenantPolicy = (
  tenantId: SpaceId,
  nowMillis: number
): NcmTenantPolicy =>
  Object.freeze({
    tenantId,
    knobs: defaultTenantPolicyKnobs,
    updatedAtMillis: nowMillis,
  });

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const round6 = (value: number): number =>
  Number.isFinite(value) ? Number(value.toFixed(6)) : 0;

const stableSortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortObject(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    sorted[key] = stableSortObject(entryValue);
  }
  return sorted;
};

const stableStringify = (value: unknown): string =>
  JSON.stringify(stableSortObject(value));

const normalizeNonEmptyTrimmed = (
  value: string,
  contract: string,
  field: string
): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ContractValidationError({
      contract,
      message: `${field} must be a non-empty trimmed string.`,
      details: `${field} received empty input.`,
    });
  }
  return normalized;
};

const normalizeMillis = (
  value: number,
  contract: string,
  field: string
): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContractValidationError({
      contract,
      message: `${field} must be a non-negative safe integer.`,
      details: `${field} received ${String(value)}.`,
    });
  }
  return value;
};

const normalizeWeight = (
  value: number,
  contract: string,
  field: string
): number => {
  if (!Number.isFinite(value)) {
    throw new ContractValidationError({
      contract,
      message: `${field} must be finite.`,
      details: `${field} received ${String(value)}.`,
    });
  }
  return round6(clamp(value, 0, 1));
};

const normalizeDelta = (
  value: number,
  contract: string,
  field: string
): number => {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new ContractValidationError({
      contract,
      message: `${field} must be in [-1, 1].`,
      details: `${field} received ${String(value)}.`,
    });
  }
  return round6(value);
};

const normalizePolicy = (
  spaceId: SpaceId,
  nowMillis: number,
  policy: NcmTenantPolicy | undefined,
  fallbackDefaultPolicy: NcmTenantPolicy | undefined
): NcmTenantPolicy => {
  const candidate =
    policy ??
    fallbackDefaultPolicy ??
    defaultTenantPolicy(
      spaceId,
      normalizeMillis(nowMillis, "NcmPolicy", "nowMillis")
    );

  if (candidate.tenantId !== spaceId) {
    throw new ContractValidationError({
      contract: "NcmPolicy",
      message: "Policy tenant must match spaceId.",
      details: `policy.tenantId=${candidate.tenantId} does not match spaceId=${spaceId}.`,
    });
  }

  const knobs = candidate.knobs;
  if (
    !Number.isFinite(knobs.maxManualWeightDelta) ||
    knobs.maxManualWeightDelta <= 0 ||
    knobs.maxManualWeightDelta > 1
  ) {
    throw new ContractValidationError({
      contract: "NcmPolicy",
      message: "maxManualWeightDelta must be in (0,1].",
      details: `Received ${String(knobs.maxManualWeightDelta)}.`,
    });
  }
  if (!Number.isFinite(knobs.halfLifeDays) || knobs.halfLifeDays <= 0) {
    throw new ContractValidationError({
      contract: "NcmPolicy",
      message: "halfLifeDays must be > 0.",
      details: `Received ${String(knobs.halfLifeDays)}.`,
    });
  }
  return candidate;
};

const toSortedFeedbackEvents = (
  events: readonly NcmFeedbackEvent[]
): readonly NcmFeedbackEvent[] =>
  Object.freeze(
    [...events].sort((left, right) => {
      if (left.occurredAtMillis !== right.occurredAtMillis) {
        return left.occurredAtMillis - right.occurredAtMillis;
      }
      return left.feedbackId.localeCompare(right.feedbackId);
    })
  );

const toSortedTransitions = (
  transitions: readonly NcmDecayTransitionRecord[]
): readonly NcmDecayTransitionRecord[] =>
  Object.freeze(
    [...transitions].sort((left, right) => {
      if (left.recordedAtMillis !== right.recordedAtMillis) {
        return left.recordedAtMillis - right.recordedAtMillis;
      }
      return left.transitionId.localeCompare(right.transitionId);
    })
  );

const toSortedAdjustments = (
  adjustments: readonly NcmOperatorWeightAdjustmentRecord[]
): readonly NcmOperatorWeightAdjustmentRecord[] =>
  Object.freeze(
    [...adjustments].sort((left, right) => {
      if (left.recordedAtMillis !== right.recordedAtMillis) {
        return left.recordedAtMillis - right.recordedAtMillis;
      }
      return left.adjustmentId.localeCompare(right.adjustmentId);
    })
  );

const normalizeFeedbackEvent = (
  event: NcmFeedbackEvent,
  contract: string
): NcmFeedbackEvent => {
  const feedbackId = normalizeNonEmptyTrimmed(
    event.feedbackId,
    contract,
    "feedbackId"
  );
  const spaceId = normalizeNonEmptyTrimmed(
    event.spaceId,
    contract,
    "spaceId"
  ) as SpaceId;
  const memoryId = normalizeNonEmptyTrimmed(
    event.memoryId,
    contract,
    "memoryId"
  ) as MemoryId;
  const occurredAtMillis = normalizeMillis(
    event.occurredAtMillis,
    contract,
    "occurredAtMillis"
  );
  const source =
    event.source === "human_feedback" || event.source === "agent_outcome"
      ? event.source
      : null;
  if (source === null) {
    throw new ContractValidationError({
      contract,
      message: "source must be 'human_feedback' or 'agent_outcome'.",
      details: `Received ${String(event.source)}.`,
    });
  }
  const signal =
    event.signal === "helpful" || event.signal === "failure"
      ? event.signal
      : null;
  if (signal === null) {
    throw new ContractValidationError({
      contract,
      message: "signal must be 'helpful' or 'failure'.",
      details: `Received ${String(event.signal)}.`,
    });
  }

  const note =
    event.note === undefined
      ? undefined
      : normalizeNonEmptyTrimmed(event.note, contract, "note");
  const idempotencyKey =
    event.idempotencyKey === undefined
      ? undefined
      : normalizeNonEmptyTrimmed(
          event.idempotencyKey,
          contract,
          "idempotencyKey"
        );

  return Object.freeze({
    ...event,
    feedbackId,
    spaceId,
    memoryId,
    source,
    signal,
    occurredAtMillis,
    ...(note === undefined ? {} : { note }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
};

const feedbackEventDigest = (event: NcmFeedbackEvent): string =>
  sha256(
    stableStringify({
      feedbackId: event.feedbackId,
      spaceId: event.spaceId,
      memoryId: event.memoryId,
      source: event.source,
      signal: event.signal,
      actorUserId: event.actorUserId ?? null,
      actorAgentId: event.actorAgentId ?? null,
      note: event.note ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
      occurredAtMillis: event.occurredAtMillis,
      provenance: event.provenance ?? null,
    })
  );

const operatorAdjustmentDigest = (
  request: NcmOperatorWeightAdjustmentRequest
): string =>
  sha256(
    stableStringify({
      adjustmentId: request.adjustmentId,
      spaceId: request.spaceId,
      memoryId: request.memoryId,
      actorUserId: request.actorUserId,
      reason: request.reason,
      delta: round6(request.delta),
      currentWeight: round6(request.currentWeight),
      nowMillis: request.nowMillis,
    })
  );

const policyDigest = (policy: NcmTenantPolicy): string =>
  sha256(stableStringify(policy.knobs));

const isSameFeedbackIdentity = (
  left: NcmFeedbackEvent,
  right: NcmFeedbackEvent
): boolean =>
  left.feedbackId === right.feedbackId ||
  (left.idempotencyKey !== undefined &&
    right.idempotencyKey !== undefined &&
    left.idempotencyKey === right.idempotencyKey);

const evaluateDecayFromSignals = (
  request: {
    readonly currentWeight: number;
    readonly nowMillis: number;
    readonly lastRetrievedAtMillis?: number;
    readonly recentRetrievalCount: number;
    readonly feedbackSignals: readonly NcmFeedbackSignal[];
  },
  policy: NcmTenantPolicy
): NcmDecayReheatPolicyResponse => {
  const currentWeight = normalizeWeight(
    request.currentWeight,
    "NcmDecayReheatPolicyRequest",
    "currentWeight"
  );
  const nowMillis = normalizeMillis(
    request.nowMillis,
    "NcmDecayReheatPolicyRequest",
    "nowMillis"
  );
  const recentRetrievalCount = Math.max(
    0,
    Math.trunc(request.recentRetrievalCount)
  );
  const helpfulCount = request.feedbackSignals.filter(
    (signal) => signal === "helpful"
  ).length;
  const failureCount = request.feedbackSignals.length - helpfulCount;

  const staleDays =
    request.lastRetrievedAtMillis === undefined
      ? policy.knobs.halfLifeDays
      : Math.max(
          0,
          (nowMillis - request.lastRetrievedAtMillis) / millisecondsPerDay
        );
  const timeDecay =
    (staleDays / policy.knobs.halfLifeDays) * policy.knobs.timeDecayFactor;
  const helpfulBoost = helpfulCount * policy.knobs.helpfulSignalBoost;
  const failurePenalty = failureCount * policy.knobs.failureSignalPenalty;
  const retrievalBoost =
    Math.min(10, recentRetrievalCount) * policy.knobs.retrievalReheatBoost;
  const netDelta = round6(
    helpfulBoost + retrievalBoost - failurePenalty - timeDecay
  );
  const toWeight = normalizeWeight(
    currentWeight + netDelta,
    "NcmDecay",
    "toWeight"
  );

  const action: NcmDecayAction =
    netDelta > 0 ? "reheat" : netDelta < 0 ? "decay" : "stable";
  const reasonCodes = Object.freeze(
    [
      helpfulCount > 0 ? "HELPFUL_SIGNAL" : null,
      failureCount > 0 ? "FAILURE_SIGNAL" : null,
      recentRetrievalCount > 0 ? "RECENT_RETRIEVAL_REHEAT" : null,
      staleDays > policy.knobs.halfLifeDays ? "STALE_TIME_DECAY" : null,
      action === "stable" ? "NO_CHANGE" : null,
    ].filter((entry): entry is string => entry !== null)
  );

  const explainability = Object.freeze([
    `helpful=${helpfulCount}, failure=${failureCount}, retrievals=${recentRetrievalCount}, staleDays=${round6(staleDays)}`,
    `boost=${round6(helpfulBoost + retrievalBoost)}, penalty=${round6(failurePenalty + timeDecay)}, netDelta=${netDelta}`,
    `weight ${currentWeight} -> ${toWeight} (${action})`,
  ]);

  return Object.freeze({
    action,
    fromWeight: currentWeight,
    toWeight,
    netDelta,
    reasonCodes,
    explainability,
  });
};

const toLineageRefs = (event: NcmFeedbackEvent): readonly string[] => {
  const provenance = event.provenance;
  if (provenance === undefined) {
    return lineageEmpty;
  }
  const refs = [
    provenance.userId ? `user:${provenance.userId}` : null,
    provenance.agentId ? `agent:${provenance.agentId}` : null,
    provenance.conversationId
      ? `conversation:${provenance.conversationId}`
      : null,
    provenance.messageId ? `message:${provenance.messageId}` : null,
    provenance.sourceId ? `source:${provenance.sourceId}` : null,
    provenance.batchId ? `batch:${provenance.batchId}` : null,
  ].filter((entry): entry is string => entry !== null);
  return Object.freeze(refs);
};

export const makeDeterministicNcmHybridService = (
  options: NcmHybridServiceOptions = {}
): NcmHybridService => ({
  ingestFeedback: (request) =>
    Effect.try({
      try: () => {
        const contract = "NcmFeedbackIngestionRequest";
        const normalizedEvent = normalizeFeedbackEvent(request.event, contract);
        const policy = normalizePolicy(
          normalizedEvent.spaceId,
          request.nowMillis,
          request.policy,
          options.defaultPolicy
        );
        const currentWeight = normalizeWeight(
          request.currentWeight,
          contract,
          "currentWeight"
        );
        const nowMillis = normalizeMillis(
          request.nowMillis,
          contract,
          "nowMillis"
        );
        const existingEvents = toSortedFeedbackEvents(
          (request.existingEvents ?? []).map((event) =>
            normalizeFeedbackEvent(event, contract)
          )
        );
        const existingTransitions = toSortedTransitions(
          request.existingTransitions ?? []
        );

        if (!policy.knobs.enableFeedbackIngestion) {
          if (policy.knobs.failClosed) {
            throw new ContractValidationError({
              contract,
              message: "Feedback ingestion is disabled by tenant policy.",
              details: `Policy knob enableFeedbackIngestion=false for tenant ${policy.tenantId}.`,
            });
          }
          return Object.freeze({
            action: "rejected" as const,
            idempotentReplay: false,
            policyDeniedReasonCode: reasonCodePolicyDisabled,
            event: normalizedEvent,
            events: existingEvents,
            transitions: existingTransitions,
            computedWeight: currentWeight,
            transition: null,
            explainability: Object.freeze([
              "feedback ingestion disabled by policy; fail-open rejection without state mutation.",
            ]),
          });
        }

        const incomingDigest = feedbackEventDigest(normalizedEvent);
        const existingMatch = existingEvents.find((existing) =>
          isSameFeedbackIdentity(existing, normalizedEvent)
        );

        if (existingMatch !== undefined) {
          const existingDigest = feedbackEventDigest(existingMatch);
          if (existingDigest !== incomingDigest) {
            throw new ContractValidationError({
              contract,
              message:
                "Feedback replay identity collision detected with different payload.",
              details: `feedbackId/idempotencyKey collision for ${normalizedEvent.feedbackId}.`,
            });
          }
          return Object.freeze({
            action: "replayed" as const,
            idempotentReplay: true,
            policyDeniedReasonCode: null,
            event: existingMatch,
            events: existingEvents,
            transitions: existingTransitions,
            computedWeight: currentWeight,
            transition: null,
            explainability: Object.freeze([
              "idempotent replay detected; previous feedback payload reused.",
            ]),
          });
        }

        const nextEvents = toSortedFeedbackEvents([
          ...existingEvents,
          normalizedEvent,
        ]);
        const memorySignals = nextEvents
          .filter(
            (event) =>
              event.spaceId === normalizedEvent.spaceId &&
              event.memoryId === normalizedEvent.memoryId
          )
          .map((event) => event.signal);
        const decayEvaluation = evaluateDecayFromSignals(
          {
            currentWeight,
            nowMillis,
            recentRetrievalCount: request.recentRetrievalCount ?? 0,
            feedbackSignals: memorySignals,
            ...(request.lastRetrievedAtMillis === undefined
              ? {}
              : { lastRetrievedAtMillis: request.lastRetrievedAtMillis }),
          },
          policy
        );
        const transitionId = `ncm-transition:${sha256(
          stableStringify({
            spaceId: normalizedEvent.spaceId,
            memoryId: normalizedEvent.memoryId,
            fromWeight: decayEvaluation.fromWeight,
            toWeight: decayEvaluation.toWeight,
            netDelta: decayEvaluation.netDelta,
            sourceFeedbackIds: nextEvents
              .filter(
                (event) =>
                  event.spaceId === normalizedEvent.spaceId &&
                  event.memoryId === normalizedEvent.memoryId
              )
              .map((event) => event.feedbackId),
            recordedAtMillis: nowMillis,
            policy: policy.knobs,
          })
        )}`;
        const transition: NcmDecayTransitionRecord = Object.freeze({
          transitionId,
          spaceId: normalizedEvent.spaceId,
          memoryId: normalizedEvent.memoryId,
          action: decayEvaluation.action,
          fromWeight: decayEvaluation.fromWeight,
          toWeight: decayEvaluation.toWeight,
          netDelta: decayEvaluation.netDelta,
          reasonCodes: decayEvaluation.reasonCodes,
          sourceFeedbackIds: Object.freeze(
            nextEvents
              .filter(
                (event) =>
                  event.spaceId === normalizedEvent.spaceId &&
                  event.memoryId === normalizedEvent.memoryId
              )
              .map((event) => event.feedbackId)
          ),
          policyDigestSha256: policyDigest(policy),
          recordedAtMillis: nowMillis,
        });

        const nextTransitions = toSortedTransitions([
          ...existingTransitions,
          transition,
        ]);

        return Object.freeze({
          action: "created" as const,
          idempotentReplay: false,
          policyDeniedReasonCode: null,
          event: normalizedEvent,
          events: nextEvents,
          transitions: nextTransitions,
          computedWeight: decayEvaluation.toWeight,
          transition,
          explainability: decayEvaluation.explainability,
        });
      },
      catch: (cause) =>
        cause instanceof ContractValidationError
          ? cause
          : new ContractValidationError({
              contract: "NcmFeedbackIngestionRequest",
              message: "Failed to ingest NCM feedback.",
              details:
                cause instanceof Error
                  ? cause.message
                  : `Unknown failure: ${String(cause)}`,
            }),
    }),

  evaluateDecayReheatPolicy: (request) =>
    Effect.try({
      try: () => {
        const contract = "NcmDecayReheatPolicyRequest";
        const spaceId = normalizeNonEmptyTrimmed(
          request.spaceId,
          contract,
          "spaceId"
        ) as SpaceId;
        const memoryId = normalizeNonEmptyTrimmed(
          request.memoryId,
          contract,
          "memoryId"
        ) as MemoryId;
        const policy = normalizePolicy(
          spaceId,
          request.nowMillis,
          request.policy,
          options.defaultPolicy
        );
        if (!policy.knobs.enableDeterministicDecayReheat) {
          if (policy.knobs.failClosed) {
            throw new ContractValidationError({
              contract,
              message: "Deterministic decay/reheat is disabled by policy.",
              details: `Policy knob enableDeterministicDecayReheat=false for tenant ${spaceId}.`,
            });
          }
          const currentWeight = normalizeWeight(
            request.currentWeight,
            contract,
            "currentWeight"
          );
          return Object.freeze({
            action: "stable" as const,
            fromWeight: currentWeight,
            toWeight: currentWeight,
            netDelta: 0,
            reasonCodes: Object.freeze([reasonCodePolicyDisabled]),
            explainability: Object.freeze([
              "deterministic decay/reheat disabled by policy; no mutation.",
            ]),
          });
        }

        const response = evaluateDecayFromSignals(
          {
            currentWeight: request.currentWeight,
            nowMillis: request.nowMillis,
            recentRetrievalCount: request.recentRetrievalCount ?? 0,
            feedbackSignals: request.feedbackSignals,
            ...(request.lastRetrievedAtMillis === undefined
              ? {}
              : { lastRetrievedAtMillis: request.lastRetrievedAtMillis }),
          },
          policy
        );

        // Ensure request identity fields are validated.
        if (spaceId.length === 0 || memoryId.length === 0) {
          throw new ContractValidationError({
            contract,
            message: "spaceId and memoryId must be non-empty.",
            details: "Normalized identifiers unexpectedly empty.",
          });
        }
        return response;
      },
      catch: (cause) =>
        cause instanceof ContractValidationError
          ? cause
          : new ContractValidationError({
              contract: "NcmDecayReheatPolicyRequest",
              message: "Failed to evaluate deterministic decay/reheat policy.",
              details:
                cause instanceof Error
                  ? cause.message
                  : `Unknown failure: ${String(cause)}`,
            }),
    }),

  applyOperatorWeightAdjustment: (request) =>
    Effect.try({
      try: () => {
        const contract = "NcmOperatorWeightAdjustmentRequest";
        const adjustmentId = normalizeNonEmptyTrimmed(
          request.adjustmentId,
          contract,
          "adjustmentId"
        );
        const spaceId = normalizeNonEmptyTrimmed(
          request.spaceId,
          contract,
          "spaceId"
        ) as SpaceId;
        const memoryId = normalizeNonEmptyTrimmed(
          request.memoryId,
          contract,
          "memoryId"
        ) as MemoryId;
        const actorUserId = normalizeNonEmptyTrimmed(
          request.actorUserId,
          contract,
          "actorUserId"
        ) as UserId;
        const reason = normalizeNonEmptyTrimmed(
          request.reason,
          contract,
          "reason"
        );
        const nowMillis = normalizeMillis(
          request.nowMillis,
          contract,
          "nowMillis"
        );
        const currentWeight = normalizeWeight(
          request.currentWeight,
          contract,
          "currentWeight"
        );
        const delta = normalizeDelta(request.delta, contract, "delta");
        const policy = normalizePolicy(
          spaceId,
          nowMillis,
          request.policy,
          options.defaultPolicy
        );
        const existingAdjustments = toSortedAdjustments(
          request.existingAdjustments ?? []
        );

        if (!policy.knobs.enableManualWeightTuning) {
          if (policy.knobs.failClosed) {
            throw new ContractValidationError({
              contract,
              message: "Manual weight tuning is disabled by tenant policy.",
              details: `Policy knob enableManualWeightTuning=false for tenant ${spaceId}.`,
            });
          }
          const rejectedAdjustment: NcmOperatorWeightAdjustmentRecord =
            Object.freeze({
              adjustmentId,
              spaceId,
              memoryId,
              actorUserId,
              reason,
              delta,
              fromWeight: currentWeight,
              toWeight: currentWeight,
              recordedAtMillis: nowMillis,
              policyDigestSha256: policyDigest(policy),
            });
          return Object.freeze({
            action: "rejected" as const,
            idempotentReplay: false,
            policyDeniedReasonCode: reasonCodePolicyDisabled,
            tunedWeight: currentWeight,
            adjustment: rejectedAdjustment,
            adjustments: existingAdjustments,
          });
        }

        if (Math.abs(delta) > policy.knobs.maxManualWeightDelta) {
          throw new ContractValidationError({
            contract,
            message: "delta exceeds policy maxManualWeightDelta.",
            details: `delta=${delta}, max=${policy.knobs.maxManualWeightDelta}.`,
          });
        }

        const incomingDigest = operatorAdjustmentDigest(request);
        const existing = existingAdjustments.find(
          (entry) => entry.adjustmentId === adjustmentId
        );
        if (existing !== undefined) {
          const existingDigest = sha256(
            stableStringify({
              adjustmentId: existing.adjustmentId,
              spaceId: existing.spaceId,
              memoryId: existing.memoryId,
              actorUserId: existing.actorUserId,
              reason: existing.reason,
              delta: existing.delta,
              currentWeight: existing.fromWeight,
              nowMillis: existing.recordedAtMillis,
            })
          );
          if (existingDigest !== incomingDigest) {
            throw new ContractValidationError({
              contract,
              message: "adjustmentId already exists with a different payload.",
              details: `adjustmentId=${adjustmentId}.`,
            });
          }
          return Object.freeze({
            action: "replayed" as const,
            idempotentReplay: true,
            policyDeniedReasonCode: null,
            tunedWeight: existing.toWeight,
            adjustment: existing,
            adjustments: existingAdjustments,
          });
        }

        const tunedWeight = normalizeWeight(
          currentWeight + delta,
          contract,
          "tunedWeight"
        );
        const adjustment: NcmOperatorWeightAdjustmentRecord = Object.freeze({
          adjustmentId,
          spaceId,
          memoryId,
          actorUserId,
          reason,
          delta,
          fromWeight: currentWeight,
          toWeight: tunedWeight,
          recordedAtMillis: nowMillis,
          policyDigestSha256: policyDigest(policy),
        });
        const nextAdjustments = toSortedAdjustments([
          ...existingAdjustments,
          adjustment,
        ]);

        return Object.freeze({
          action: "applied" as const,
          idempotentReplay: false,
          policyDeniedReasonCode: null,
          tunedWeight,
          adjustment,
          adjustments: nextAdjustments,
        });
      },
      catch: (cause) =>
        cause instanceof ContractValidationError
          ? cause
          : new ContractValidationError({
              contract: "NcmOperatorWeightAdjustmentRequest",
              message: "Failed to apply operator weight adjustment.",
              details:
                cause instanceof Error
                  ? cause.message
                  : `Unknown failure: ${String(cause)}`,
            }),
    }),

  getConsoleSignals: (request) =>
    Effect.try({
      try: () => {
        const contract = "NcmConsoleSignalsRequest";
        const spaceId = normalizeNonEmptyTrimmed(
          request.spaceId,
          contract,
          "spaceId"
        ) as SpaceId;
        const limitRaw = request.limit ?? defaultConsoleLimit;
        if (!Number.isSafeInteger(limitRaw) || limitRaw <= 0) {
          throw new ContractValidationError({
            contract,
            message: "limit must be a positive safe integer.",
            details: `Received ${String(limitRaw)}.`,
          });
        }
        const limit = Math.min(limitRaw, 2_000);
        const memoryFilter =
          request.memoryId === undefined
            ? undefined
            : (normalizeNonEmptyTrimmed(
                request.memoryId,
                contract,
                "memoryId"
              ) as MemoryId);

        const feedbackEvents = toSortedFeedbackEvents(
          request.feedbackEvents.filter((event) => {
            if (event.spaceId !== spaceId) {
              return false;
            }
            if (memoryFilter !== undefined && event.memoryId !== memoryFilter) {
              return false;
            }
            return true;
          })
        );
        const transitions = toSortedTransitions(
          request.decayTransitions.filter((entry) => {
            if (entry.spaceId !== spaceId) {
              return false;
            }
            if (memoryFilter !== undefined && entry.memoryId !== memoryFilter) {
              return false;
            }
            return true;
          })
        );
        const adjustments = toSortedAdjustments(
          request.operatorAdjustments.filter((entry) => {
            if (entry.spaceId !== spaceId) {
              return false;
            }
            if (memoryFilter !== undefined && entry.memoryId !== memoryFilter) {
              return false;
            }
            return true;
          })
        );

        const feedbackEntries: NcmConsoleSignalEntry[] = feedbackEvents.map(
          (event) =>
            Object.freeze({
              kind: "feedback" as const,
              signalId: event.feedbackId,
              memoryId: event.memoryId,
              occurredAtMillis: event.occurredAtMillis,
              summary: `${event.signal} from ${event.source}`,
              lineageRefs: toLineageRefs(event),
            })
        );
        const transitionEntries: NcmConsoleSignalEntry[] = transitions.map(
          (entry) =>
            Object.freeze({
              kind: "decay_transition" as const,
              signalId: entry.transitionId,
              memoryId: entry.memoryId,
              occurredAtMillis: entry.recordedAtMillis,
              summary: `${entry.action} ${entry.fromWeight} -> ${entry.toWeight} (${entry.reasonCodes.join(",")})`,
              lineageRefs: Object.freeze(
                entry.sourceFeedbackIds.map(
                  (feedbackId) => `feedback:${feedbackId}`
                )
              ),
            })
        );
        const adjustmentEntries: NcmConsoleSignalEntry[] = adjustments.map(
          (entry) =>
            Object.freeze({
              kind: "operator_adjustment" as const,
              signalId: entry.adjustmentId,
              memoryId: entry.memoryId,
              occurredAtMillis: entry.recordedAtMillis,
              summary: `manual delta=${entry.delta} by ${entry.actorUserId}`,
              lineageRefs: Object.freeze([`user:${entry.actorUserId}`]),
            })
        );

        const entries = Object.freeze(
          [...feedbackEntries, ...transitionEntries, ...adjustmentEntries]
            .sort((left, right) => {
              if (left.occurredAtMillis !== right.occurredAtMillis) {
                return right.occurredAtMillis - left.occurredAtMillis;
              }
              return left.signalId.localeCompare(right.signalId);
            })
            .slice(0, limit)
        );

        return Object.freeze({
          totalFeedbackEvents: feedbackEvents.length,
          totalDecayTransitions: transitions.length,
          totalOperatorAdjustments: adjustments.length,
          entries,
        });
      },
      catch: (cause) =>
        cause instanceof ContractValidationError
          ? cause
          : new ContractValidationError({
              contract: "NcmConsoleSignalsRequest",
              message: "Failed to materialize NCM console signals.",
              details:
                cause instanceof Error
                  ? cause.message
                  : `Unknown failure: ${String(cause)}`,
            }),
    }),
});

export const makeNoopNcmHybridService = (): NcmHybridService => ({
  ingestFeedback: (request) =>
    Effect.succeed({
      action: "created",
      idempotentReplay: false,
      policyDeniedReasonCode: null,
      event: request.event,
      events: Object.freeze([request.event]),
      transitions: Object.freeze([]),
      computedWeight: clamp(request.currentWeight, 0, 1),
      transition: null,
      explainability: Object.freeze(["noop ncm hybrid service"]),
    }),
  evaluateDecayReheatPolicy: (request) =>
    Effect.succeed({
      action: "stable",
      fromWeight: clamp(request.currentWeight, 0, 1),
      toWeight: clamp(request.currentWeight, 0, 1),
      netDelta: 0,
      reasonCodes: Object.freeze(["NOOP"]),
      explainability: Object.freeze(["noop ncm hybrid service"]),
    }),
  applyOperatorWeightAdjustment: (request) =>
    Effect.succeed({
      action: "applied",
      idempotentReplay: false,
      policyDeniedReasonCode: null,
      tunedWeight: clamp(request.currentWeight + request.delta, 0, 1),
      adjustment: {
        adjustmentId: request.adjustmentId,
        spaceId: request.spaceId,
        memoryId: request.memoryId,
        actorUserId: request.actorUserId,
        reason: request.reason,
        delta: request.delta,
        fromWeight: clamp(request.currentWeight, 0, 1),
        toWeight: clamp(request.currentWeight + request.delta, 0, 1),
        recordedAtMillis: request.nowMillis,
        policyDigestSha256: "noop",
      },
      adjustments: Object.freeze([]),
    }),
  getConsoleSignals: () =>
    Effect.succeed({
      totalFeedbackEvents: 0,
      totalDecayTransitions: 0,
      totalOperatorAdjustments: 0,
      entries: Object.freeze([]),
    }),
});

export const noopNcmHybridLayer: Layer.Layer<NcmHybridService> = Layer.succeed(
  NcmHybridServiceTag,
  makeNoopNcmHybridService()
);

export const deterministicTestNcmHybridLayer: Layer.Layer<NcmHybridService> =
  Layer.succeed(NcmHybridServiceTag, makeDeterministicNcmHybridService());
