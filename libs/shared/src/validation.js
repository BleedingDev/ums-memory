import {
  EvidenceRequiredError,
  IsolationViolationError,
  PayloadLimitError,
  ValidationError,
} from "./errors.js";
import { asSortedUniqueStrings, deepFreeze, stableStringify } from "./utils.js";

export const DEFAULT_GUARDRAILS = Object.freeze({
  maxPayloadBytes: 16 * 1024,
  maxRecallBytes: 12 * 1024,
  maxRecallItems: 16,
  maxWorkingEpisodeWindow: 8,
  allowCrossSpaceRead: false,
});

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function createGuardrailConfig(overrides = {}) {
  return Object.freeze({
    maxPayloadBytes: toPositiveInteger(overrides.maxPayloadBytes, DEFAULT_GUARDRAILS.maxPayloadBytes),
    maxRecallBytes: toPositiveInteger(overrides.maxRecallBytes, DEFAULT_GUARDRAILS.maxRecallBytes),
    maxRecallItems: toPositiveInteger(overrides.maxRecallItems, DEFAULT_GUARDRAILS.maxRecallItems),
    maxWorkingEpisodeWindow: toPositiveInteger(
      overrides.maxWorkingEpisodeWindow,
      DEFAULT_GUARDRAILS.maxWorkingEpisodeWindow,
    ),
    allowCrossSpaceRead:
      typeof overrides.allowCrossSpaceRead === "boolean"
        ? overrides.allowCrossSpaceRead
        : DEFAULT_GUARDRAILS.allowCrossSpaceRead,
  });
}

export function estimatePayloadBytes(value) {
  return Buffer.byteLength(stableStringify(value), "utf8");
}

export function enforceBoundedPayload(payload, limitBytes, context = "payload") {
  const bytes = estimatePayloadBytes(payload);
  if (bytes > limitBytes) {
    throw new PayloadLimitError(`${context} exceeds byte budget`, {
      context,
      bytes,
      limitBytes,
    });
  }
  return bytes;
}

export function enforceEvidenceRequirement(candidate, fieldName = "evidenceEpisodeIds") {
  const evidenceIds = asSortedUniqueStrings(candidate?.[fieldName]);
  if (evidenceIds.length === 0) {
    throw new EvidenceRequiredError("evidence requirement violated", {
      fieldName,
      candidate,
    });
  }
  return evidenceIds;
}

export function enforceIsolation({ requestedSpaceId, resourceSpaceId, allowSpaceIds = [] }) {
  if (requestedSpaceId === resourceSpaceId) {
    return true;
  }
  const allowlist = asSortedUniqueStrings(allowSpaceIds);
  if (allowlist.includes(resourceSpaceId)) {
    return true;
  }
  throw new IsolationViolationError("cross-space access denied", {
    requestedSpaceId,
    resourceSpaceId,
    allowSpaceIds: allowlist,
  });
}

export function enforceAllowedSpaces({
  requestedSpaceId,
  targetSpaceIds,
  allowSpaceIds = [],
  allowCrossSpaceRead = false,
}) {
  const normalizedTargets = asSortedUniqueStrings(targetSpaceIds);
  if (normalizedTargets.length === 0) {
    throw new ValidationError("targetSpaceIds must contain at least one space");
  }

  for (const targetSpaceId of normalizedTargets) {
    if (!allowCrossSpaceRead) {
      enforceIsolation({ requestedSpaceId, resourceSpaceId: targetSpaceId, allowSpaceIds });
    }
  }

  return normalizedTargets;
}

export function countRecallPackItems(pack) {
  return (
    (pack.topRules?.length ?? 0) +
    (pack.antiPatterns?.length ?? 0) +
    (pack.evidencePointers?.length ?? 0)
  );
}

function removeOnePackItem(pack) {
  if (pack.evidencePointers.length > 0) {
    pack.evidencePointers.pop();
    return true;
  }
  if (pack.antiPatterns.length > 0) {
    pack.antiPatterns.pop();
    return true;
  }
  if (pack.topRules.length > 0) {
    pack.topRules.pop();
    return true;
  }
  return false;
}

export function truncateRecallPack(pack, { maxItems, maxBytes }) {
  const boundedPack = {
    ...pack,
    topRules: [...(pack.topRules ?? [])],
    antiPatterns: [...(pack.antiPatterns ?? [])],
    evidencePointers: [...(pack.evidencePointers ?? [])],
    freshnessWarnings: [...(pack.freshnessWarnings ?? [])],
    conflictNotes: [...(pack.conflictNotes ?? [])],
    truncated: Boolean(pack.truncated),
  };

  let wasTruncated = false;
  while (countRecallPackItems(boundedPack) > maxItems) {
    if (!removeOnePackItem(boundedPack)) {
      break;
    }
    wasTruncated = true;
  }

  while (estimatePayloadBytes(boundedPack) > maxBytes) {
    if (!removeOnePackItem(boundedPack)) {
      throw new PayloadLimitError("recall pack cannot satisfy payload budget", {
        maxBytes,
      });
    }
    wasTruncated = true;
  }

  boundedPack.truncated = boundedPack.truncated || wasTruncated;
  return deepFreeze(boundedPack);
}
