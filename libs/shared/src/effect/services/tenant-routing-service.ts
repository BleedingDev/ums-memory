import { Effect, Layer, ServiceMap } from "effect";

import type {
  TenantCatalogEntry,
  TenantId,
  TenantRouteDenyReasonCode,
  TenantRouteResolutionSource,
  TenantRoutingRequest,
  TenantRoutingResponse,
} from "../contracts/index.js";
import {
  TenantRoutingDeniedError,
  type TenantRoutingServiceError,
} from "../errors.js";

export type {
  TenantCatalogEntry,
  TenantRouteDenyReasonCode,
  TenantRouteResolutionSource,
  TenantRoutingRequest,
  TenantRoutingResponse,
} from "../contracts/index.js";

export interface TenantRoutingService {
  readonly resolve: (
    request: TenantRoutingRequest
  ) => Effect.Effect<TenantRoutingResponse>;
  readonly assertResolved: (
    request: TenantRoutingRequest
  ) => Effect.Effect<TenantRoutingResponse, TenantRoutingServiceError>;
}

export const TenantRoutingServiceTag = ServiceMap.Service<TenantRoutingService>(
  "@ums/effect/TenantRoutingService"
);

interface TenantRoutingCandidate {
  readonly source: TenantRouteResolutionSource;
  readonly tenantId: TenantId;
}

const normalizeLookupValue = (value: string): string =>
  value.trim().toLowerCase();

const pushCandidateIfKnown = (
  candidates: TenantRoutingCandidate[],
  tenantById: ReadonlyMap<TenantId, TenantCatalogEntry>,
  source: TenantRouteResolutionSource,
  tenantId: TenantId | undefined
): void => {
  if (tenantId === undefined || !tenantById.has(tenantId)) {
    return;
  }
  candidates.push({
    source,
    tenantId,
  });
};

const dedupeTenantIds = (tenantIds: readonly TenantId[]): TenantId[] => {
  const seen = new Set<TenantId>();
  const deduped: TenantId[] = [];
  for (const tenantId of tenantIds) {
    if (seen.has(tenantId)) {
      continue;
    }
    seen.add(tenantId);
    deduped.push(tenantId);
  }
  return deduped;
};

const canonicalizeTenantIds = (tenantIds: readonly TenantId[]): TenantId[] =>
  dedupeTenantIds(tenantIds).sort((left, right) => left.localeCompare(right));

const toDeniedResponse = (
  denyReasonCode: TenantRouteDenyReasonCode,
  evaluatedAtMillis: number,
  candidateTenantIds: readonly TenantId[],
  tenantId?: TenantId
): TenantRoutingResponse => ({
  resolved: false,
  tenantId,
  denyReasonCode,
  candidateTenantIds: [...candidateTenantIds],
  evaluatedAtMillis,
});

const evaluateTenantRoutingDecision = (
  request: TenantRoutingRequest,
  evaluatedAtMillis: number
): TenantRoutingResponse => {
  const tenantById = new Map<TenantId, TenantCatalogEntry>();
  const tenantIdBySlug = new Map<string, TenantId>();
  const tenantIdByIssuer = new Map<string, TenantId>();
  const conflictingSlugTenantIds: TenantId[] = [];
  const conflictingIssuerTenantIds: TenantId[] = [];
  const invalidBindingIssuers = new Set<string>();

  for (const tenant of request.tenants) {
    if (tenantById.has(tenant.tenantId)) {
      continue;
    }
    tenantById.set(tenant.tenantId, tenant);
  }
  for (const tenant of request.tenants) {
    const slugKey = normalizeLookupValue(tenant.tenantSlug);
    const existingTenantId = tenantIdBySlug.get(slugKey);
    if (existingTenantId === undefined) {
      tenantIdBySlug.set(slugKey, tenant.tenantId);
      continue;
    }
    if (existingTenantId !== tenant.tenantId) {
      conflictingSlugTenantIds.push(existingTenantId, tenant.tenantId);
    }
  }
  for (const binding of request.issuerBindings) {
    const issuerKey = normalizeLookupValue(binding.issuer);
    if (!tenantById.has(binding.tenantId)) {
      invalidBindingIssuers.add(issuerKey);
      continue;
    }
    const existingTenantId = tenantIdByIssuer.get(issuerKey);
    if (existingTenantId === undefined) {
      tenantIdByIssuer.set(issuerKey, binding.tenantId);
      continue;
    }
    if (existingTenantId !== binding.tenantId) {
      conflictingIssuerTenantIds.push(existingTenantId, binding.tenantId);
    }
  }

  const duplicateRouteTenantIds = canonicalizeTenantIds([
    ...conflictingSlugTenantIds,
    ...conflictingIssuerTenantIds,
  ]);
  if (duplicateRouteTenantIds.length > 0) {
    return toDeniedResponse(
      "TENANT_ROUTE_CONFLICT",
      evaluatedAtMillis,
      duplicateRouteTenantIds
    );
  }

  const claimCandidates: TenantRoutingCandidate[] = [];
  pushCandidateIfKnown(
    claimCandidates,
    tenantById,
    "tenant_id_claim",
    request.tenantIdClaim
  );
  const slugTenantId =
    request.tenantSlugClaim === undefined
      ? undefined
      : tenantIdBySlug.get(normalizeLookupValue(request.tenantSlugClaim));
  pushCandidateIfKnown(
    claimCandidates,
    tenantById,
    "tenant_slug_claim",
    slugTenantId
  );

  const issuerBoundTenantId =
    request.issuer === undefined
      ? undefined
      : tenantIdByIssuer.get(normalizeLookupValue(request.issuer));
  const hasInvalidIssuerBinding =
    request.issuer !== undefined &&
    invalidBindingIssuers.has(normalizeLookupValue(request.issuer));

  const claimTenantIds = dedupeTenantIds(
    claimCandidates.map((candidate) => candidate.tenantId)
  );
  if (claimTenantIds.length > 1) {
    return toDeniedResponse(
      "TENANT_ROUTE_CONFLICT",
      evaluatedAtMillis,
      claimTenantIds
    );
  }

  if (hasInvalidIssuerBinding) {
    const invalidBindingCandidates = canonicalizeTenantIds([
      ...claimCandidates.map((candidate) => candidate.tenantId),
      ...(issuerBoundTenantId === undefined ? [] : [issuerBoundTenantId]),
    ]);
    return toDeniedResponse(
      "TENANT_ISSUER_MISMATCH",
      evaluatedAtMillis,
      invalidBindingCandidates,
      invalidBindingCandidates[0]
    );
  }

  const claimResolution = claimCandidates[0];
  const resolvedByClaims = claimResolution?.tenantId;
  if (resolvedByClaims !== undefined) {
    if (request.issuer !== undefined) {
      if (
        issuerBoundTenantId === undefined ||
        issuerBoundTenantId !== resolvedByClaims
      ) {
        const mismatchCandidates = dedupeTenantIds([
          resolvedByClaims,
          ...(issuerBoundTenantId === undefined ? [] : [issuerBoundTenantId]),
        ]);
        return toDeniedResponse(
          "TENANT_ISSUER_MISMATCH",
          evaluatedAtMillis,
          mismatchCandidates,
          resolvedByClaims
        );
      }
    }

    return {
      resolved: true,
      tenantId: resolvedByClaims,
      source: claimResolution?.source,
      candidateTenantIds: [resolvedByClaims],
      evaluatedAtMillis,
    };
  }

  if (
    request.issuer !== undefined &&
    issuerBoundTenantId !== undefined &&
    tenantById.has(issuerBoundTenantId)
  ) {
    return {
      resolved: true,
      tenantId: issuerBoundTenantId,
      source: "issuer_binding",
      candidateTenantIds: [issuerBoundTenantId],
      evaluatedAtMillis,
    };
  }

  const candidateTenantIds = canonicalizeTenantIds(
    claimCandidates.map((candidate) => candidate.tenantId)
  );
  const denyReasonCode: TenantRouteDenyReasonCode =
    request.issuer !== undefined &&
    issuerBoundTenantId === undefined &&
    candidateTenantIds.length > 0
      ? "TENANT_ISSUER_MISMATCH"
      : "TENANT_ROUTE_MISSING";
  return {
    ...toDeniedResponse(denyReasonCode, evaluatedAtMillis, candidateTenantIds),
    tenantId: candidateTenantIds[0],
  };
};

export interface TenantRoutingServiceOptions {
  readonly clock?: () => number;
}

export const makeTenantRoutingService = (
  options: TenantRoutingServiceOptions = {}
): TenantRoutingService => {
  const clock = options.clock ?? Date.now;
  return {
    resolve: (request) =>
      Effect.sync(() =>
        evaluateTenantRoutingDecision(request, Math.max(0, clock()))
      ),
    assertResolved: (request) =>
      Effect.suspend(() => {
        const decision = evaluateTenantRoutingDecision(
          request,
          Math.max(0, clock())
        );
        if (decision.resolved) {
          return Effect.succeed(decision);
        }
        return Effect.fail(
          new TenantRoutingDeniedError({
            denyReasonCode: decision.denyReasonCode ?? "TENANT_ROUTE_MISSING",
            tenantId: decision.tenantId,
            candidateTenantIds: decision.candidateTenantIds,
            evaluatedAtMillis: decision.evaluatedAtMillis,
            message: `Tenant routing denied: ${decision.denyReasonCode ?? "TENANT_ROUTE_MISSING"}`,
          })
        );
      }),
  };
};

export const makeDeterministicTenantRoutingService = (): TenantRoutingService =>
  makeTenantRoutingService({
    clock: () => 0,
  });

export const makeRuntimeTenantRoutingService = (): TenantRoutingService =>
  makeTenantRoutingService();

export const noopTenantRoutingLayer: Layer.Layer<TenantRoutingService> =
  Layer.succeed(TenantRoutingServiceTag, makeRuntimeTenantRoutingService());

export const deterministicTenantRoutingLayer: Layer.Layer<TenantRoutingService> =
  Layer.succeed(
    TenantRoutingServiceTag,
    makeDeterministicTenantRoutingService()
  );

export const deterministicTestTenantRoutingLayer: Layer.Layer<TenantRoutingService> =
  Layer.succeed(
    TenantRoutingServiceTag,
    makeDeterministicTenantRoutingService()
  );
