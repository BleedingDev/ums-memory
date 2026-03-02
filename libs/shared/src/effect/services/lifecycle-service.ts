import { createHash } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import type {
  MemoryLifecycleCandidate,
  MemoryLifecycleDemoteRequest,
  MemoryLifecycleDemoteResponse,
  MemoryLifecycleGateStatus,
  MemoryLifecycleOperation,
  MemoryLifecyclePreconditionReasonCode,
  MemoryLifecyclePromoteRequest,
  MemoryLifecyclePromoteResponse,
  MemoryLifecycleReplayEvalRequest,
  MemoryLifecycleReplayEvalResponse,
  MemoryLifecycleSafetyDelta,
  MemoryLifecycleShadowWriteRequest,
  MemoryLifecycleShadowWriteResponse,
} from "../contracts/index.js";
import {
  decodeMemoryLifecycleDemoteRequestEffect,
  decodeMemoryLifecyclePromoteRequestEffect,
  decodeMemoryLifecycleReplayEvalRequestEffect,
  decodeMemoryLifecycleShadowWriteRequestEffect,
} from "../contracts/validators.js";
import {
  MemoryLifecyclePreconditionError,
  type MemoryLifecycleServiceError,
} from "../errors.js";

export type {
  MemoryLifecycleCandidate,
  MemoryLifecycleDemoteRequest,
  MemoryLifecycleDemoteResponse,
  MemoryLifecyclePromoteRequest,
  MemoryLifecyclePromoteResponse,
  MemoryLifecycleReplayEvalRequest,
  MemoryLifecycleReplayEvalResponse,
  MemoryLifecycleShadowWriteRequest,
  MemoryLifecycleShadowWriteResponse,
} from "../contracts/index.js";

type MemoryLifecycleResponse =
  | MemoryLifecycleShadowWriteResponse
  | MemoryLifecycleReplayEvalResponse
  | MemoryLifecyclePromoteResponse
  | MemoryLifecycleDemoteResponse;

interface ReplayEvaluationState {
  readonly replayEvalId: string;
  readonly gateStatus: MemoryLifecycleGateStatus;
  readonly safetyDelta: MemoryLifecycleSafetyDelta;
}

interface MutableLifecycleState {
  readonly candidatesByKey: Map<string, MemoryLifecycleCandidate>;
  readonly latestReplayByKey: Map<string, ReplayEvaluationState>;
  readonly responseByRequestDigest: Map<string, MemoryLifecycleResponse>;
}

export interface MemoryLifecycleService {
  readonly shadowWrite: (
    request: MemoryLifecycleShadowWriteRequest
  ) => Effect.Effect<
    MemoryLifecycleShadowWriteResponse,
    MemoryLifecycleServiceError
  >;
  readonly replayEval: (
    request: MemoryLifecycleReplayEvalRequest
  ) => Effect.Effect<
    MemoryLifecycleReplayEvalResponse,
    MemoryLifecycleServiceError
  >;
  readonly promote: (
    request: MemoryLifecyclePromoteRequest
  ) => Effect.Effect<
    MemoryLifecyclePromoteResponse,
    MemoryLifecycleServiceError
  >;
  readonly demote: (
    request: MemoryLifecycleDemoteRequest
  ) => Effect.Effect<
    MemoryLifecycleDemoteResponse,
    MemoryLifecycleServiceError
  >;
}

export const MemoryLifecycleServiceTag =
  Context.GenericTag<MemoryLifecycleService>(
    "@ums/effect/MemoryLifecycleService"
  );

const stableSortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortObject(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [
          key,
          stableSortObject((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
};

const stableStringify = (value: unknown): string =>
  JSON.stringify(stableSortObject(value));

const toRequestDigest = (
  operation: MemoryLifecycleOperation,
  request: unknown
): string =>
  createHash("sha256")
    .update(stableStringify({ operation, request }))
    .digest("hex");

const toDeterministicId = (
  prefix: string,
  seed: string,
  left: string,
  right: string
): string =>
  `${prefix}_${createHash("sha256")
    .update(stableStringify({ seed, left, right }))
    .digest("hex")
    .slice(0, 16)}`;

const roundToSix = (value: number): number =>
  Math.round(value * 1_000_000) / 1_000_000;

const toSortedUnique = <T extends string>(values: readonly T[]): readonly T[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const toCandidateKey = (spaceId: string, candidateId: string): string =>
  `${spaceId}::${candidateId}`;

const toMemoryLifecyclePreconditionError = ({
  operation,
  spaceId,
  candidateId,
  reasonCode,
  message,
}: {
  readonly operation: MemoryLifecycleOperation;
  readonly spaceId: MemoryLifecycleCandidate["spaceId"];
  readonly candidateId: MemoryLifecycleCandidate["candidateId"];
  readonly reasonCode: MemoryLifecyclePreconditionReasonCode;
  readonly message: string;
}): MemoryLifecyclePreconditionError =>
  new MemoryLifecyclePreconditionError({
    operation,
    spaceId,
    candidateId,
    reasonCode,
    message,
  });

const computeNetValueScore = (
  request: MemoryLifecycleReplayEvalRequest
): number =>
  roundToSix(
    request.qualityDelta.successRateDelta * 0.5 +
      request.qualityDelta.reopenRateDelta * -0.2 +
      request.efficiencyDelta.latencyP95DeltaMs * -0.000005 +
      request.efficiencyDelta.tokenCostDelta * -0.0004 +
      request.safetyDelta.policyViolationsDelta * -0.2 +
      request.safetyDelta.hallucinationFlagDelta * -0.2
  );

const evaluateReplayGate = (
  request: MemoryLifecycleReplayEvalRequest,
  netValueScore: number
): MemoryLifecycleGateStatus => {
  if (request.safetyDelta.policyViolationsDelta > 0) {
    return "fail";
  }
  if (request.safetyDelta.hallucinationFlagDelta > 0) {
    return "fail";
  }
  return netValueScore >= 0 ? "pass" : "fail";
};

const createMutableLifecycleState = (): MutableLifecycleState => ({
  candidatesByKey: new Map(),
  latestReplayByKey: new Map(),
  responseByRequestDigest: new Map(),
});

const getCachedResponse = <TResponse extends MemoryLifecycleResponse>(
  state: MutableLifecycleState,
  requestDigest: string
): TResponse | undefined =>
  state.responseByRequestDigest.get(requestDigest) as TResponse | undefined;

const cacheResponse = <TResponse extends MemoryLifecycleResponse>(
  state: MutableLifecycleState,
  requestDigest: string,
  response: TResponse
): TResponse => {
  state.responseByRequestDigest.set(requestDigest, response);
  return response;
};

const latestGateStatusOrPass = (
  replayState: ReplayEvaluationState | undefined
): MemoryLifecycleGateStatus => replayState?.gateStatus ?? "pass";

export const makeMemoryLifecycleService = (): MemoryLifecycleService => {
  const state = createMutableLifecycleState();

  const shadowWrite: MemoryLifecycleService["shadowWrite"] = (request) =>
    decodeMemoryLifecycleShadowWriteRequestEffect(request).pipe(
      Effect.flatMap((decodedRequest) => {
        const requestDigest = toRequestDigest("shadow_write", decodedRequest);
        const cachedResponse =
          getCachedResponse<MemoryLifecycleShadowWriteResponse>(
            state,
            requestDigest
          );
        if (cachedResponse !== undefined) {
          return Effect.succeed(cachedResponse);
        }

        if (decodedRequest.sourceEpisodeIds.length === 0) {
          return Effect.fail(
            toMemoryLifecyclePreconditionError({
              operation: "shadow_write",
              spaceId: decodedRequest.spaceId,
              candidateId: decodedRequest.candidateId,
              reasonCode: "SHADOW_WRITE_REQUIRES_SOURCE_EPISODES",
              message:
                "shadow_write requires at least one sourceEpisodeId for deterministic replay lineage.",
            })
          );
        }

        const candidateKey = toCandidateKey(
          decodedRequest.spaceId,
          decodedRequest.candidateId
        );
        const existingCandidate = state.candidatesByKey.get(candidateKey);
        if (existingCandidate?.status === "promoted") {
          return Effect.fail(
            toMemoryLifecyclePreconditionError({
              operation: "shadow_write",
              spaceId: decodedRequest.spaceId,
              candidateId: decodedRequest.candidateId,
              reasonCode: "SHADOW_WRITE_REJECTS_PROMOTED_CANDIDATE",
              message:
                "shadow_write cannot overwrite promoted candidates; demote first to preserve lifecycle determinism.",
            })
          );
        }

        const nextCandidate: MemoryLifecycleCandidate = {
          spaceId: decodedRequest.spaceId,
          candidateId: decodedRequest.candidateId,
          statement: decodedRequest.statement,
          scope: decodedRequest.scope ?? "global",
          sourceEpisodeIds: toSortedUnique(decodedRequest.sourceEpisodeIds),
          status: "shadow",
          expiresAtMillis: decodedRequest.expiresAtMillis,
          latestReplayEvalId: null,
          promotedRuleId: null,
          promotedAtMillis: null,
          demotedAtMillis: null,
          updatedAtMillis: decodedRequest.writtenAtMillis,
        };

        state.candidatesByKey.set(candidateKey, nextCandidate);
        state.latestReplayByKey.delete(candidateKey);

        const response: MemoryLifecycleShadowWriteResponse = {
          operation: "shadow_write",
          requestDigest,
          action: existingCandidate === undefined ? "created" : "updated",
          candidate: nextCandidate,
        };

        return Effect.succeed(cacheResponse(state, requestDigest, response));
      })
    );

  const replayEval: MemoryLifecycleService["replayEval"] = (request) =>
    decodeMemoryLifecycleReplayEvalRequestEffect(request).pipe(
      Effect.flatMap((decodedRequest) => {
        const requestDigest = toRequestDigest("replay_eval", decodedRequest);
        const cachedResponse =
          getCachedResponse<MemoryLifecycleReplayEvalResponse>(
            state,
            requestDigest
          );
        if (cachedResponse !== undefined) {
          return Effect.succeed(cachedResponse);
        }

        const candidateKey = toCandidateKey(
          decodedRequest.spaceId,
          decodedRequest.candidateId
        );
        const existingCandidate = state.candidatesByKey.get(candidateKey);
        if (
          existingCandidate === undefined ||
          existingCandidate.status !== "shadow"
        ) {
          return Effect.fail(
            toMemoryLifecyclePreconditionError({
              operation: "replay_eval",
              spaceId: decodedRequest.spaceId,
              candidateId: decodedRequest.candidateId,
              reasonCode: "REPLAY_EVAL_REQUIRES_SHADOW_CANDIDATE",
              message:
                "replay_eval requires an existing candidate in shadow status.",
            })
          );
        }

        const netValueScore = computeNetValueScore(decodedRequest);
        const gateStatus = evaluateReplayGate(decodedRequest, netValueScore);
        const replayEvalId = toDeterministicId(
          "replay_eval",
          requestDigest,
          decodedRequest.spaceId,
          decodedRequest.candidateId
        );

        const response: MemoryLifecycleReplayEvalResponse = {
          operation: "replay_eval",
          requestDigest,
          replayEvalId,
          candidateId: decodedRequest.candidateId,
          evaluationPackId: decodedRequest.evaluationPackId,
          targetMemorySpace: decodedRequest.targetMemorySpace,
          qualityDelta: decodedRequest.qualityDelta,
          efficiencyDelta: decodedRequest.efficiencyDelta,
          safetyDelta: decodedRequest.safetyDelta,
          netValueScore,
          gateStatus,
        };

        const nextCandidate: MemoryLifecycleCandidate = {
          ...existingCandidate,
          latestReplayEvalId: replayEvalId,
          updatedAtMillis: Math.max(
            existingCandidate.updatedAtMillis,
            decodedRequest.evaluatedAtMillis
          ),
        };

        state.candidatesByKey.set(candidateKey, nextCandidate);
        state.latestReplayByKey.set(candidateKey, {
          replayEvalId,
          gateStatus,
          safetyDelta: decodedRequest.safetyDelta,
        });

        return Effect.succeed(cacheResponse(state, requestDigest, response));
      })
    );

  const promote: MemoryLifecycleService["promote"] = (request) =>
    decodeMemoryLifecyclePromoteRequestEffect(request).pipe(
      Effect.flatMap((decodedRequest) => {
        const requestDigest = toRequestDigest("promote", decodedRequest);
        const cachedResponse =
          getCachedResponse<MemoryLifecyclePromoteResponse>(
            state,
            requestDigest
          );
        if (cachedResponse !== undefined) {
          return Effect.succeed(cachedResponse);
        }

        const candidateKey = toCandidateKey(
          decodedRequest.spaceId,
          decodedRequest.candidateId
        );
        const existingCandidate = state.candidatesByKey.get(candidateKey);
        if (existingCandidate === undefined) {
          return Effect.fail(
            toMemoryLifecyclePreconditionError({
              operation: "promote",
              spaceId: decodedRequest.spaceId,
              candidateId: decodedRequest.candidateId,
              reasonCode: "PROMOTE_REQUIRES_EXISTING_CANDIDATE",
              message: "promote requires an existing candidate.",
            })
          );
        }

        const replayState = state.latestReplayByKey.get(candidateKey);
        if (existingCandidate.status === "promoted") {
          const noopResponse: MemoryLifecyclePromoteResponse = {
            operation: "promote",
            requestDigest,
            action: "noop",
            candidate: existingCandidate,
            ruleId: existingCandidate.promotedRuleId,
            replayEvalId: existingCandidate.latestReplayEvalId,
            gateStatus: latestGateStatusOrPass(replayState),
          };
          return Effect.succeed(
            cacheResponse(state, requestDigest, noopResponse)
          );
        }

        if (
          replayState === undefined ||
          replayState.gateStatus !== "pass" ||
          replayState.safetyDelta.policyViolationsDelta > 0 ||
          replayState.safetyDelta.hallucinationFlagDelta > 0
        ) {
          return Effect.fail(
            toMemoryLifecyclePreconditionError({
              operation: "promote",
              spaceId: decodedRequest.spaceId,
              candidateId: decodedRequest.candidateId,
              reasonCode: "PROMOTE_REQUIRES_PASSING_REPLAY_EVAL",
              message:
                "promote requires latest replay_eval gateStatus=pass with no unresolved safety regressions.",
            })
          );
        }

        if (
          existingCandidate.expiresAtMillis < decodedRequest.promotedAtMillis
        ) {
          return Effect.fail(
            toMemoryLifecyclePreconditionError({
              operation: "promote",
              spaceId: decodedRequest.spaceId,
              candidateId: decodedRequest.candidateId,
              reasonCode: "PROMOTE_REQUIRES_FRESH_EVIDENCE",
              message: "promote requires non-expired evidence lineage.",
            })
          );
        }

        const ruleId =
          existingCandidate.promotedRuleId ??
          toDeterministicId(
            "rule",
            "promote",
            decodedRequest.spaceId,
            decodedRequest.candidateId
          );

        const promotedCandidate: MemoryLifecycleCandidate = {
          ...existingCandidate,
          status: "promoted",
          promotedRuleId: ruleId,
          promotedAtMillis:
            existingCandidate.promotedAtMillis ??
            decodedRequest.promotedAtMillis,
          demotedAtMillis: null,
          latestReplayEvalId: replayState.replayEvalId,
          updatedAtMillis: decodedRequest.promotedAtMillis,
        };

        state.candidatesByKey.set(candidateKey, promotedCandidate);

        const response: MemoryLifecyclePromoteResponse = {
          operation: "promote",
          requestDigest,
          action: "promoted",
          candidate: promotedCandidate,
          ruleId,
          replayEvalId: replayState.replayEvalId,
          gateStatus: replayState.gateStatus,
        };

        return Effect.succeed(cacheResponse(state, requestDigest, response));
      })
    );

  const demote: MemoryLifecycleService["demote"] = (request) =>
    decodeMemoryLifecycleDemoteRequestEffect(request).pipe(
      Effect.flatMap((decodedRequest) => {
        const requestDigest = toRequestDigest("demote", decodedRequest);
        const cachedResponse = getCachedResponse<MemoryLifecycleDemoteResponse>(
          state,
          requestDigest
        );
        if (cachedResponse !== undefined) {
          return Effect.succeed(cachedResponse);
        }

        const candidateKey = toCandidateKey(
          decodedRequest.spaceId,
          decodedRequest.candidateId
        );
        const existingCandidate = state.candidatesByKey.get(candidateKey);
        if (existingCandidate === undefined) {
          return Effect.fail(
            toMemoryLifecyclePreconditionError({
              operation: "demote",
              spaceId: decodedRequest.spaceId,
              candidateId: decodedRequest.candidateId,
              reasonCode: "DEMOTE_REQUIRES_EXISTING_CANDIDATE",
              message: "demote requires an existing candidate.",
            })
          );
        }

        const reasonCodes = toSortedUnique(decodedRequest.reasonCodes);
        if (reasonCodes.length === 0) {
          return Effect.fail(
            toMemoryLifecyclePreconditionError({
              operation: "demote",
              spaceId: decodedRequest.spaceId,
              candidateId: decodedRequest.candidateId,
              reasonCode: "DEMOTE_REQUIRES_REASON_CODES",
              message:
                "demote requires at least one deterministic reasonCode for auditability.",
            })
          );
        }

        if (existingCandidate.status === "demoted") {
          const noopResponse: MemoryLifecycleDemoteResponse = {
            operation: "demote",
            requestDigest,
            action: "noop",
            candidate: existingCandidate,
            removedRuleId: null,
            reasonCodes,
          };
          return Effect.succeed(
            cacheResponse(state, requestDigest, noopResponse)
          );
        }

        const demotedCandidate: MemoryLifecycleCandidate = {
          ...existingCandidate,
          status: "demoted",
          promotedRuleId: null,
          demotedAtMillis: decodedRequest.demotedAtMillis,
          updatedAtMillis: decodedRequest.demotedAtMillis,
        };

        state.candidatesByKey.set(candidateKey, demotedCandidate);

        const response: MemoryLifecycleDemoteResponse = {
          operation: "demote",
          requestDigest,
          action: "demoted",
          candidate: demotedCandidate,
          removedRuleId: existingCandidate.promotedRuleId,
          reasonCodes,
        };

        return Effect.succeed(cacheResponse(state, requestDigest, response));
      })
    );

  return {
    shadowWrite,
    replayEval,
    promote,
    demote,
  };
};

export const makeDeterministicMemoryLifecycleService =
  makeMemoryLifecycleService;

export const makeNoopMemoryLifecycleService =
  makeDeterministicMemoryLifecycleService;

export const noopMemoryLifecycleLayer: Layer.Layer<MemoryLifecycleService> =
  Layer.succeed(MemoryLifecycleServiceTag, makeNoopMemoryLifecycleService());

export const deterministicTestMemoryLifecycleLayer: Layer.Layer<MemoryLifecycleService> =
  Layer.succeed(
    MemoryLifecycleServiceTag,
    makeDeterministicMemoryLifecycleService()
  );
