import { Effect } from "effect";
export function createPolicyPackPlugin() {
  return {
    name: "fixture-policy-pack-plugin",
    evaluateDecisionUpdate(request: any) {
      return Effect.succeed({
        contractVersion: "v1",
        outcome: request.policyKey === "plugin-fixture-deny" ? "deny" : "pass",
        reasonCodes:
          request.policyKey === "plugin-fixture-deny"
            ? ["fixture-plugin-deny"]
            : [],
        metadata: {
          fixture: "policy-pack-plugin-override",
          policyKey: request.policyKey,
        },
      });
    },
  };
}
