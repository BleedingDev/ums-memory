import { Context, Effect, Layer } from "effect";

import type {
  PolicyContext,
  PolicyContextValue,
  PolicyOutcome,
  PolicyRequest,
  PolicyResponse,
} from "../contracts/index.js";
import type { PolicyServiceError } from "../errors.js";

export type {
  PolicyContext,
  PolicyContextValue,
  PolicyRequest,
  PolicyResponse,
} from "../contracts/index.js";
export type PolicyDecision = PolicyOutcome;

export interface PolicyService {
  readonly evaluate: (request: PolicyRequest) => Effect.Effect<PolicyResponse, PolicyServiceError>;
}

export const PolicyServiceTag = Context.GenericTag<PolicyService>("@ums/effect/PolicyService");

export const makeNoopPolicyService = (): PolicyService => ({
  evaluate: () =>
    Effect.succeed({
      decision: "allow",
      reasonCodes: ["NOOP_POLICY_ALLOW"],
      evaluatedAtMillis: 0,
    }),
});

export const noopPolicyLayer: Layer.Layer<PolicyService> = Layer.succeed(
  PolicyServiceTag,
  makeNoopPolicyService(),
);

export const deterministicTestPolicyLayer: Layer.Layer<PolicyService> = noopPolicyLayer;
