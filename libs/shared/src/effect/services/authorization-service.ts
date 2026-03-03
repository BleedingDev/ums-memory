import { Effect, Layer, ServiceMap } from "effect";

import type {
  AuthorizationAction,
  AuthorizationDecisionReasonCode,
  AuthorizationRequest,
  AuthorizationResponse,
  AuthorizationRole,
} from "../contracts/index.js";
import {
  AuthorizationDeniedError,
  type AuthorizationServiceError,
} from "../errors.js";

export type {
  AuthorizationAction,
  AuthorizationDecisionReasonCode,
  AuthorizationRequest,
  AuthorizationResponse,
  AuthorizationRole,
} from "../contracts/index.js";

export interface AuthorizationService {
  readonly evaluate: (
    request: AuthorizationRequest
  ) => Effect.Effect<AuthorizationResponse>;
  readonly assertAllowed: (
    request: AuthorizationRequest
  ) => Effect.Effect<AuthorizationResponse, AuthorizationServiceError>;
}

export const AuthorizationServiceTag = ServiceMap.Service<AuthorizationService>(
  "@ums/effect/AuthorizationService"
);

type AuthorizationMatrix = Readonly<
  Record<AuthorizationRole, Readonly<Record<AuthorizationAction, boolean>>>
>;

export const authorizationRoleActionMatrix: AuthorizationMatrix = {
  admin: {
    "memory.read": true,
    "memory.write": true,
    "memory.promote": true,
    "memory.demote": true,
    "memory.replay_eval": true,
    "policy.read": true,
    "policy.write": true,
    "policy.override": true,
    "compliance.read": true,
    "compliance.export": true,
  },
  lead: {
    "memory.read": true,
    "memory.write": true,
    "memory.promote": true,
    "memory.demote": true,
    "memory.replay_eval": true,
    "policy.read": true,
    "policy.write": true,
    "policy.override": false,
    "compliance.read": true,
    "compliance.export": true,
  },
  dev: {
    "memory.read": true,
    "memory.write": true,
    "memory.promote": false,
    "memory.demote": false,
    "memory.replay_eval": true,
    "policy.read": true,
    "policy.write": false,
    "policy.override": false,
    "compliance.read": false,
    "compliance.export": false,
  },
  auditor: {
    "memory.read": true,
    "memory.write": false,
    "memory.promote": false,
    "memory.demote": false,
    "memory.replay_eval": false,
    "policy.read": true,
    "policy.write": false,
    "policy.override": false,
    "compliance.read": true,
    "compliance.export": true,
  },
};

const decisionReasonCode = (
  allowed: boolean
): AuthorizationDecisionReasonCode =>
  allowed ? "RBAC_ALLOW" : "RBAC_DENY_ROLE_ACTION";

const resolvePermission = (role: string, action: string): boolean => {
  const roleMatrix = (
    authorizationRoleActionMatrix as Readonly<
      Record<string, Readonly<Record<string, boolean>>>
    >
  )[role];
  if (roleMatrix === undefined) {
    return false;
  }
  return roleMatrix[action] === true;
};

const evaluateAuthorizationDecision = (
  request: AuthorizationRequest,
  evaluatedAtMillis: number
): AuthorizationResponse => {
  const allowed = resolvePermission(request.role, request.action);
  return {
    role: request.role,
    action: request.action,
    allowed,
    reasonCode: decisionReasonCode(allowed),
    evaluatedAtMillis,
  };
};

export interface AuthorizationServiceOptions {
  readonly clock?: () => number;
}

export const makeAuthorizationService = (
  options: AuthorizationServiceOptions = {}
): AuthorizationService => {
  const clock = options.clock ?? Date.now;
  return {
    evaluate: (request) =>
      Effect.sync(() =>
        evaluateAuthorizationDecision(request, Math.max(0, clock()))
      ),
    assertAllowed: (request) =>
      Effect.suspend(() => {
        const decision = evaluateAuthorizationDecision(
          request,
          Math.max(0, clock())
        );
        if (decision.allowed) {
          return Effect.succeed(decision);
        }

        return Effect.fail(
          new AuthorizationDeniedError({
            role: request.role,
            action: request.action,
            reasonCode: decision.reasonCode,
            evaluatedAtMillis: decision.evaluatedAtMillis,
            message: `RBAC denied action '${request.action}' for role '${request.role}'`,
          })
        );
      }),
  };
};

export const makeDeterministicAuthorizationService = (): AuthorizationService =>
  makeAuthorizationService({
    clock: () => 0,
  });

export const makeRuntimeAuthorizationService = (): AuthorizationService =>
  makeAuthorizationService();

export const noopAuthorizationLayer: Layer.Layer<AuthorizationService> =
  Layer.succeed(AuthorizationServiceTag, makeRuntimeAuthorizationService());

export const deterministicAuthorizationLayer: Layer.Layer<AuthorizationService> =
  Layer.succeed(
    AuthorizationServiceTag,
    makeDeterministicAuthorizationService()
  );

export const deterministicTestAuthorizationLayer: Layer.Layer<AuthorizationService> =
  Layer.succeed(
    AuthorizationServiceTag,
    makeDeterministicAuthorizationService()
  );
