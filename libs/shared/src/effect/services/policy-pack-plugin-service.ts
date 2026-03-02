import { Context, Effect, Layer } from "effect";

import type {
  PolicyPackPluginContractVersion,
  PolicyPackPluginRequest,
  PolicyPackPluginResponse,
} from "../contracts/index.js";

export type {
  PolicyPackPluginContractVersion,
  PolicyPackPluginRequest,
  PolicyPackPluginResponse,
} from "../contracts/index.js";

export const policyPackPluginContractVersion: PolicyPackPluginContractVersion =
  "v1";

export interface PolicyPackPluginService {
  readonly evaluateDecisionUpdate: (
    request: PolicyPackPluginRequest
  ) => Effect.Effect<PolicyPackPluginResponse>;
}

export const PolicyPackPluginServiceTag =
  Context.GenericTag<PolicyPackPluginService>(
    "@ums/effect/PolicyPackPluginService"
  );

const noopPolicyPackPluginResponse: PolicyPackPluginResponse = Object.freeze({
  contractVersion: policyPackPluginContractVersion,
  outcome: "pass",
  reasonCodes: [],
  metadata: {},
});

export const makeNoopPolicyPackPluginService = (): PolicyPackPluginService => ({
  evaluateDecisionUpdate: () => Effect.succeed(noopPolicyPackPluginResponse),
});

export const makePolicyPackPluginService = (
  hook: PolicyPackPluginService["evaluateDecisionUpdate"]
): PolicyPackPluginService => ({
  evaluateDecisionUpdate: hook,
});

export const noopPolicyPackPluginLayer: Layer.Layer<PolicyPackPluginService> =
  Layer.succeed(PolicyPackPluginServiceTag, makeNoopPolicyPackPluginService());

export const deterministicTestPolicyPackPluginLayer: Layer.Layer<PolicyPackPluginService> =
  noopPolicyPackPluginLayer;
