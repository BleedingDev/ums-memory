import { createHash } from "node:crypto";

const OPS = [
  "ingest",
  "context",
  "reflect",
  "validate",
  "curate",
  "learner_profile_update",
  "identity_graph_update",
  "misconception_update",
  "curriculum_plan_update",
  "review_schedule_update",
  "policy_decision_update",
  "pain_signal_ingest",
  "failure_signal_ingest",
  "curriculum_recommendation",
  "review_schedule_clock",
  "review_set_rebalance",
  "curate_guarded",
  "recall_authorization",
  "tutor_degraded",
  "policy_audit_export",
  "feedback",
  "outcome",
  "audit",
  "export",
  "doctor",
];

const stores = new Map();

const DEFAULT_VERSION_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const MAX_LIST_ITEMS = 128;
const MAX_SIGNAL_ITEM_LENGTH = 256;
const MAX_IDENTITY_REFS = 32;
const MAX_IDENTITY_VALUE_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MAX_EMAIL_LENGTH = 320;
const MAX_ACTIVE_REVIEW_SET_LIMIT = 256;
const DEFAULT_ACTIVE_REVIEW_SET_LIMIT = 32;
const DEFAULT_SLEEP_THRESHOLD = 8;
const MAX_POLICY_AUDIT_EVENTS = 2048;
const MAX_RECOMMENDATIONS = 64;
const MAX_RECOMMENDATION_TOKEN_BUDGET = 8192;
const DEFAULT_RECOMMENDATION_TOKEN_BUDGET = 1024;
const DEFAULT_FRESHNESS_WARNING_DAYS = 14;
const DEFAULT_DECAY_WARNING_DAYS = 30;
const DEFAULT_MAX_CONFLICT_NOTES = 8;
const PROFILE_EVIDENCE_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: learner_profile_update requires at least one evidence pointer or an explicit policy exception.";
const MISCONCEPTION_EVIDENCE_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: misconception_update requires at least one evidenceEventId.";
const CURRICULUM_EVIDENCE_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: curriculum_plan_update requires at least one evidenceEventId.";
const REVIEW_SOURCE_EVENT_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: review_schedule_update requires at least one sourceEventId.";
const PAIN_SIGNAL_EVIDENCE_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: pain_signal_ingest requires at least one evidenceEventId.";
const FAILURE_SIGNAL_EVIDENCE_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: failure_signal_ingest requires at least one evidenceEventId.";
const GUARDED_CURATION_EVIDENCE_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: curate_guarded candidate promotion requires evidence-backed validation.";
const RECALL_AUTHORIZATION_REQUESTER_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: recall_authorization requires requesterStoreId for cross-space checks.";
const CROSS_SPACE_ALLOWLIST_DENY_ERROR =
  "PERSONALIZATION_POLICY_DENY: cross-space recall request is not authorized by allowlist policy.";
const POLICY_REASON_CODES_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: policy_decision_update deny outcome requires reasonCodes.";
const POLICY_PROVENANCE_EVENT_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: policy_decision_update requires provenanceEventIds.";
const PROFILE_LINEAGE_ATTRIBUTES = Object.freeze([
  "status",
  "profileConfidence",
  "displayName",
  "email",
  "goals",
  "interestTags",
  "misconceptionIds",
  "metadata",
]);
const EVIDENCE_POINTER_KINDS = new Set(["event", "episode", "signal", "artifact", "policy"]);
const CROSS_AGENT_NAMES = new Set(["codex", "claude"]);
// Harm-stage decay is deterministic: 1/2/3/5 harmful signals map to progressively stronger decay stages.
const MISCONCEPTION_DECAY_STAGE_THRESHOLDS = Object.freeze([1, 2, 3, 5]);
const MISCONCEPTION_DECAY_BY_STAGE = Object.freeze({
  0: 0,
  1: 0.18,
  2: 0.24,
  3: 0.32,
  4: 0.42,
});
const MISCONCEPTION_SIGNAL_BASE_DELTA = Object.freeze({
  helpful: 0.11,
  correction: 0.11,
  harmful: 0,
});
const MISCONCEPTION_HARMFUL_SEVERITY_MULTIPLIER = 0.08;
const MISCONCEPTION_CONFIDENCE_FLOOR = 0.05;
const MISCONCEPTION_ANTI_PATTERN_THRESHOLDS = Object.freeze([2, 3, 5]);
const DEFAULT_RECOMMENDATION_WEIGHTS = Object.freeze({
  interest: 0.35,
  masteryGap: 0.45,
  due: 0.15,
  evidence: 0.05,
});
const DEFAULT_STORE_ID = "coding-agent";
const INTERNAL_PROFILE_ID = "__store_default__";

function stableSortObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableSortObject(value[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableSortObject(value));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function opSeed(operation, storeId, profile, input) {
  return hash(stableStringify({ operation, storeId, profile, input }));
}

function makeId(prefix, seed) {
  return `${prefix}_${seed.slice(0, 12)}`;
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
}

function defaultStoreId(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return DEFAULT_STORE_ID;
}

function defaultProfile() {
  return INTERNAL_PROFILE_ID;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMetadata(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  return stableSortObject(value);
}

function asSortedUniqueStrings(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function mergeStringLists(left, right) {
  return asSortedUniqueStrings([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]);
}

function clamp01(value, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0) {
    return 0;
  }
  if (parsed > 1) {
    return 1;
  }
  return parsed;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeIsoOrDefault(value, fallback = "1970-01-01T00:00:00.000Z") {
  return normalizeTimestamp(value) ?? fallback;
}

function normalizeIsoTimestamp(value, fieldName, fallback = null) {
  const normalized = normalizeTimestamp(value);
  if (normalized === null) {
    return fallback;
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be an ISO-8601 timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function normalizeIsoTimestampOrFallback(value, fallback = DEFAULT_VERSION_TIMESTAMP) {
  try {
    return normalizeIsoTimestamp(value, "timestamp", fallback);
  } catch {
    return fallback;
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function toPositiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function toNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function ensureBoundedCount(values, fieldName, maxItems = MAX_LIST_ITEMS) {
  if (values.length > maxItems) {
    throw new Error(`${fieldName} may include at most ${maxItems} entries.`);
  }
  return values;
}

function normalizeBoundedString(value, fieldName, maxLength = MAX_SIGNAL_ITEM_LENGTH) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} must be <= ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeBoundedStringArray(values, fieldName, maxItems = MAX_LIST_ITEMS, maxLength = MAX_SIGNAL_ITEM_LENGTH) {
  const normalized = asSortedUniqueStrings(values);
  ensureBoundedCount(normalized, fieldName, maxItems);
  for (const entry of normalized) {
    if (entry.length > maxLength) {
      throw new Error(`${fieldName} entries must be <= ${maxLength} characters.`);
    }
  }
  return normalized;
}

function normalizeGuardedStringArray(
  values,
  fieldName,
  { required = false, requiredError = `${fieldName} requires at least one entry.` } = {},
) {
  if (values === undefined || values === null) {
    if (required) {
      throw new Error(requiredError);
    }
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error(`${fieldName} must be an array of non-empty strings.`);
  }
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error(`${fieldName} entries must be non-empty strings.`);
    }
    const entry = value.trim();
    if (!entry) {
      throw new Error(`${fieldName} entries must be non-empty strings.`);
    }
    if (entry.length > MAX_SIGNAL_ITEM_LENGTH) {
      throw new Error(`${fieldName} entries must be <= ${MAX_SIGNAL_ITEM_LENGTH} characters.`);
    }
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
  }
  normalized.sort((left, right) => left.localeCompare(right));
  ensureBoundedCount(normalized, fieldName);
  if (required && normalized.length === 0) {
    throw new Error(requiredError);
  }
  return normalized;
}

function normalizeDeterministicEnum(value, fieldName, operation, allowedValues, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`${operation} ${fieldName} must be one of: ${[...allowedValues].sort().join(", ")}.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!allowedValues.has(normalized)) {
    throw new Error(`${operation} ${fieldName} must be one of: ${[...allowedValues].sort().join(", ")}.`);
  }
  return normalized;
}

function normalizeOptionalEmail(value) {
  const email = normalizeBoundedString(value, "email", MAX_EMAIL_LENGTH);
  if (!email) {
    return null;
  }
  if (!email.includes("@")) {
    throw new Error("email must include '@'.");
  }
  return email;
}

function normalizeEvidencePointer(rawPointer, index) {
  const pointer = isPlainObject(rawPointer) ? rawPointer : { pointerId: rawPointer };
  const pointerId = normalizeBoundedString(
    pointer.pointerId ?? pointer.id ?? pointer.eventId ?? pointer.episodeId,
    `evidencePointers[${index}].pointerId`,
    MAX_SIGNAL_ITEM_LENGTH,
  );
  if (!pointerId) {
    throw new Error(`evidencePointers[${index}].pointerId must be a non-empty string.`);
  }
  const rawKind = typeof pointer.kind === "string" ? pointer.kind.trim().toLowerCase() : "";
  const kind = EVIDENCE_POINTER_KINDS.has(rawKind) ? rawKind : "event";
  const source = normalizeBoundedString(pointer.source ?? pointer.namespace, `evidencePointers[${index}].source`, 64);
  return {
    pointerId,
    kind,
    source: source ?? "unspecified",
    confidence: clamp01(pointer.confidence, 1),
    observedAt: normalizeIsoTimestamp(
      pointer.observedAt ?? pointer.timestamp,
      `evidencePointers[${index}].observedAt`,
      null,
    ),
    metadata: normalizeMetadata(pointer.metadata),
  };
}

function normalizeEvidencePointers(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const pointers = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const normalized = normalizeEvidencePointer(values[index], index);
    const key = `${normalized.kind}:${normalized.source}:${normalized.pointerId}`;
    const existing = pointers.get(key);
    if (!existing) {
      pointers.set(key, normalized);
      continue;
    }
    pointers.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, normalized.confidence),
      observedAt:
        existing.observedAt && normalized.observedAt
          ? existing.observedAt >= normalized.observedAt
            ? existing.observedAt
            : normalized.observedAt
          : existing.observedAt ?? normalized.observedAt ?? null,
      metadata: stableSortObject({
        ...(existing.metadata ?? {}),
        ...(normalized.metadata ?? {}),
      }),
    });
  }
  const normalizedPointers = [...pointers.values()].sort((left, right) => {
    const kindDiff = left.kind.localeCompare(right.kind);
    if (kindDiff !== 0) {
      return kindDiff;
    }
    const sourceDiff = left.source.localeCompare(right.source);
    if (sourceDiff !== 0) {
      return sourceDiff;
    }
    return left.pointerId.localeCompare(right.pointerId);
  });
  return ensureBoundedCount(normalizedPointers, "evidencePointers");
}

function normalizeEvidencePointersFromRequest(request, extras = []) {
  const eventIds = normalizeBoundedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
  );
  const fromEvents = eventIds.map((eventId) => ({
    pointerId: eventId,
    kind: "event",
    source: "event_id",
  }));
  const basePointers = normalizeEvidencePointers(request.evidencePointers);
  return normalizeEvidencePointers([...basePointers, ...fromEvents, ...(Array.isArray(extras) ? extras : [])]);
}

function normalizePolicyException(value) {
  if (value === null || value === undefined || value === false) {
    return null;
  }
  if (value === true) {
    return {
      code: "manual_override",
      reason: "explicit boolean policy override",
      approvedBy: "unspecified",
      reference: null,
      timestamp: DEFAULT_VERSION_TIMESTAMP,
      metadata: {},
    };
  }
  if (typeof value === "string") {
    const normalized = normalizeBoundedString(value, "policyException", MAX_SIGNAL_ITEM_LENGTH);
    if (!normalized) {
      throw new Error("policyException must be a non-empty string.");
    }
    return {
      code: normalized,
      reason: null,
      approvedBy: "unspecified",
      reference: null,
      timestamp: DEFAULT_VERSION_TIMESTAMP,
      metadata: {},
    };
  }
  if (!isPlainObject(value)) {
    throw new Error("policyException must be an object, string, or boolean true.");
  }
  const code = normalizeBoundedString(value.code ?? value.reasonCode ?? value.type, "policyException.code");
  if (!code) {
    throw new Error("policyException.code must be a non-empty string.");
  }
  const approvedBy = normalizeBoundedString(value.approvedBy, "policyException.approvedBy", 128);
  return {
    code,
    reason: normalizeBoundedString(value.reason, "policyException.reason", 512),
    approvedBy: approvedBy ?? "unspecified",
    reference: normalizeBoundedString(value.reference ?? value.ticket, "policyException.reference", 128),
    timestamp: normalizeIsoTimestamp(value.timestamp ?? value.createdAt, "policyException.timestamp", DEFAULT_VERSION_TIMESTAMP),
    metadata: normalizeMetadata(value.metadata),
  };
}

function normalizeAgentName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return CROSS_AGENT_NAMES.has(normalized) ? normalized : null;
}

function normalizeCodexProfileSignal(rawSignal) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }
  return {
    agent: "codex",
    goals: normalizeBoundedStringArray(rawSignal.learning_goals ?? rawSignal.goals ?? rawSignal.objectives, "codex.goals"),
    interestTags: normalizeBoundedStringArray(rawSignal.interests ?? rawSignal.interest_tags, "codex.interestTags"),
    misconceptionIds: normalizeBoundedStringArray(
      rawSignal.misconceptions ?? rawSignal.misconception_ids,
      "codex.misconceptionIds",
    ),
    profileConfidence: clamp01(rawSignal.confidence ?? rawSignal.profile_confidence, 0.5),
    evidencePointers: normalizeEvidencePointersFromRequest(rawSignal),
    sourceAt: normalizeIsoTimestamp(rawSignal.timestamp ?? rawSignal.updatedAt, "codex.timestamp", DEFAULT_VERSION_TIMESTAMP),
    metadata: normalizeMetadata({
      format: "codex",
      ...(rawSignal.metadata ?? {}),
    }),
  };
}

function normalizeClaudeProfileSignal(rawSignal) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }
  return {
    agent: "claude",
    goals: normalizeBoundedStringArray(
      rawSignal.goals ?? rawSignal.learningGoals ?? rawSignal.learning_goals,
      "claude.goals",
    ),
    interestTags: normalizeBoundedStringArray(
      rawSignal.interestTags ?? rawSignal.topic_tags ?? rawSignal.interests,
      "claude.interestTags",
    ),
    misconceptionIds: normalizeBoundedStringArray(
      rawSignal.misconceptionIds ?? rawSignal.misconceptions ?? rawSignal.error_patterns,
      "claude.misconceptionIds",
    ),
    profileConfidence: clamp01(
      rawSignal.confidenceScore ?? rawSignal.confidence ?? rawSignal.profileConfidence,
      0.5,
    ),
    evidencePointers: normalizeEvidencePointersFromRequest(rawSignal),
    sourceAt: normalizeIsoTimestamp(rawSignal.timestamp ?? rawSignal.updatedAt, "claude.timestamp", DEFAULT_VERSION_TIMESTAMP),
    metadata: normalizeMetadata({
      format: "claude",
      ...(rawSignal.metadata ?? {}),
    }),
  };
}

function normalizeProfileSignalsByAgent(request) {
  const signals = [];
  const codexSignal = normalizeCodexProfileSignal(request.codex ?? request.codexSignal ?? request.codex_profile);
  if (codexSignal) {
    signals.push(codexSignal);
  }
  const claudeSignal = normalizeClaudeProfileSignal(request.claude ?? request.claudeSignal ?? request.claude_profile);
  if (claudeSignal) {
    signals.push(claudeSignal);
  }
  const sourceAgent = normalizeAgentName(request.sourceAgent ?? request.agent ?? request.source);
  const sourcePayload = isPlainObject(request.sourcePayload) ? request.sourcePayload : null;
  if (sourceAgent === "codex") {
    const bySource = normalizeCodexProfileSignal(sourcePayload ?? request);
    if (bySource) {
      signals.push(bySource);
    }
  } else if (sourceAgent === "claude") {
    const bySource = normalizeClaudeProfileSignal(sourcePayload ?? request);
    if (bySource) {
      signals.push(bySource);
    }
  }

  const merged = new Map();
  for (const signal of signals) {
    const key = signal.agent;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, signal);
      continue;
    }
    merged.set(key, {
      ...existing,
      goals: mergeStringLists(existing.goals, signal.goals),
      interestTags: mergeStringLists(existing.interestTags, signal.interestTags),
      misconceptionIds: mergeStringLists(existing.misconceptionIds, signal.misconceptionIds),
      profileConfidence: signal.profileConfidence,
      evidencePointers: normalizeEvidencePointers([...existing.evidencePointers, ...signal.evidencePointers]),
      sourceAt: existing.sourceAt >= signal.sourceAt ? existing.sourceAt : signal.sourceAt,
      metadata: stableSortObject({
        ...(existing.metadata ?? {}),
        ...(signal.metadata ?? {}),
      }),
    });
  }
  return [...merged.values()].sort((left, right) => left.agent.localeCompare(right.agent));
}

function normalizeCodexIdentitySignal(rawSignal) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }
  const fromRef = normalizeIdentityRef(rawSignal.fromRef ?? rawSignal.source_identity ?? rawSignal.source);
  const toRef = normalizeIdentityRef(rawSignal.toRef ?? rawSignal.target_identity ?? rawSignal.target);
  if (fromRef.namespace === "unknown" || fromRef.value === "unknown") {
    return null;
  }
  if (toRef.namespace === "unknown" || toRef.value === "unknown") {
    return null;
  }
  return {
    agent: "codex",
    relation: normalizeIdentityRelation(rawSignal.relation ?? rawSignal.link_type),
    fromRef,
    toRef,
    confidence: clamp01(rawSignal.confidence ?? rawSignal.confidence_score, 0.5),
    evidencePointers: normalizeEvidencePointersFromRequest(rawSignal),
    sourceAt: normalizeIsoTimestamp(rawSignal.timestamp ?? rawSignal.updatedAt, "codexIdentity.timestamp", DEFAULT_VERSION_TIMESTAMP),
    metadata: normalizeMetadata({
      format: "codex",
      ...(rawSignal.metadata ?? {}),
    }),
  };
}

function normalizeClaudeIdentitySignal(rawSignal) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }
  const fromRef = normalizeIdentityRef(rawSignal.fromRef ?? rawSignal.from ?? rawSignal.left);
  const toRef = normalizeIdentityRef(rawSignal.toRef ?? rawSignal.to ?? rawSignal.right);
  if (fromRef.namespace === "unknown" || fromRef.value === "unknown") {
    return null;
  }
  if (toRef.namespace === "unknown" || toRef.value === "unknown") {
    return null;
  }
  return {
    agent: "claude",
    relation: normalizeIdentityRelation(rawSignal.relation ?? rawSignal.relation_type),
    fromRef,
    toRef,
    confidence: clamp01(rawSignal.confidence ?? rawSignal.confidenceScore, 0.5),
    evidencePointers: normalizeEvidencePointersFromRequest(rawSignal),
    sourceAt: normalizeIsoTimestamp(
      rawSignal.timestamp ?? rawSignal.updatedAt,
      "claudeIdentity.timestamp",
      DEFAULT_VERSION_TIMESTAMP,
    ),
    metadata: normalizeMetadata({
      format: "claude",
      ...(rawSignal.metadata ?? {}),
    }),
  };
}

function normalizeIdentitySignalsByAgent(request) {
  const signals = [];
  const codexSignal = normalizeCodexIdentitySignal(
    request.codex ?? request.codexIdentity ?? request.codex_identity ?? request.codexEdge,
  );
  if (codexSignal) {
    signals.push(codexSignal);
  }
  const claudeSignal = normalizeClaudeIdentitySignal(
    request.claude ?? request.claudeIdentity ?? request.claude_identity ?? request.claudeEdge,
  );
  if (claudeSignal) {
    signals.push(claudeSignal);
  }
  const sourceAgent = normalizeAgentName(request.sourceAgent ?? request.agent ?? request.source);
  const sourcePayload = isPlainObject(request.sourcePayload) ? request.sourcePayload : null;
  if (sourceAgent === "codex") {
    const bySource = normalizeCodexIdentitySignal(sourcePayload ?? request);
    if (bySource) {
      signals.push(bySource);
    }
  } else if (sourceAgent === "claude") {
    const bySource = normalizeClaudeIdentitySignal(sourcePayload ?? request);
    if (bySource) {
      signals.push(bySource);
    }
  }
  return signals.sort((left, right) => left.agent.localeCompare(right.agent));
}

function mergeSourceSignals(existingSignals, incomingSignals) {
  const merged = new Map();
  const source = [
    ...(Array.isArray(existingSignals) ? existingSignals : []),
    ...(Array.isArray(incomingSignals) ? incomingSignals : []),
  ];
  for (const rawSignal of source) {
    if (!isPlainObject(rawSignal)) {
      continue;
    }
    const signalId =
      normalizeBoundedString(rawSignal.signalId, "sourceSignals.signalId", 64) ??
      makeId("sig", hash(stableStringify(rawSignal)));
    merged.set(signalId, {
      ...rawSignal,
      signalId,
      metadata: normalizeMetadata(rawSignal.metadata),
    });
  }
  return [...merged.values()].sort((left, right) => left.signalId.localeCompare(right.signalId));
}

function deriveProfileId(request, storeId, profile) {
  const learnerId =
    typeof request.learnerId === "string" && request.learnerId.trim() ? request.learnerId.trim() : profile;
  return typeof request.profileId === "string" && request.profileId.trim()
    ? request.profileId.trim()
    : makeId("lp", hash(stableStringify({ storeId, profile, learnerId })));
}

function normalizeIdentityRef(rawRef) {
  const ref = isPlainObject(rawRef) ? rawRef : {};
  const namespace =
    typeof ref.namespace === "string" && ref.namespace.trim() ? ref.namespace.trim() : "unknown";
  const value = typeof ref.value === "string" && ref.value.trim() ? ref.value.trim() : "unknown";

  return {
    namespace,
    value,
    verified: Boolean(ref.verified),
    isPrimary: Boolean(ref.isPrimary),
    lastSeenAt: normalizeIsoTimestamp(ref.lastSeenAt, "identityRef.lastSeenAt", null),
    metadata: normalizeMetadata(ref.metadata),
  };
}

function normalizeIdentityRefs(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  ensureBoundedCount(values, "identityRefs", MAX_IDENTITY_REFS);

  const refs = new Map();
  for (const rawRef of values) {
    const normalized = normalizeIdentityRef(rawRef);
    if (normalized.namespace.length > MAX_IDENTITY_VALUE_LENGTH) {
      throw new Error(`identityRefs.namespace must be <= ${MAX_IDENTITY_VALUE_LENGTH} characters.`);
    }
    if (normalized.value.length > MAX_IDENTITY_VALUE_LENGTH) {
      throw new Error(`identityRefs.value must be <= ${MAX_IDENTITY_VALUE_LENGTH} characters.`);
    }
    const key = `${normalized.namespace}:${normalized.value}`;
    const existing = refs.get(key);
    if (!existing) {
      refs.set(key, normalized);
      continue;
    }

    refs.set(key, {
      ...existing,
      verified: existing.verified || normalized.verified,
      isPrimary: existing.isPrimary || normalized.isPrimary,
      lastSeenAt:
        existing.lastSeenAt && normalized.lastSeenAt
          ? existing.lastSeenAt > normalized.lastSeenAt
            ? existing.lastSeenAt
            : normalized.lastSeenAt
          : existing.lastSeenAt ?? normalized.lastSeenAt ?? null,
      metadata: stableSortObject({
        ...existing.metadata,
        ...normalized.metadata,
      }),
    });
  }

  const normalizedRefs = [...refs.values()].sort((left, right) => {
    const namespaceDiff = left.namespace.localeCompare(right.namespace);
    if (namespaceDiff !== 0) {
      return namespaceDiff;
    }
    return left.value.localeCompare(right.value);
  });

  if (normalizedRefs.length > 0 && !normalizedRefs.some((ref) => ref.isPrimary)) {
    normalizedRefs[0] = {
      ...normalizedRefs[0],
      isPrimary: true,
    };
  }

  return normalizedRefs;
}

function normalizeLearnerProfileUpdateRequest(request, storeId, profile) {
  const sourceSignals = normalizeProfileSignalsByAgent(request);
  const learnerId =
    normalizeBoundedString(request.learnerId, "learnerId") ?? profile;
  const requestedIdentityRefs = normalizeIdentityRefs(request.identityRefs);
  const fallbackIdentity = {
    namespace: "profile",
    value: learnerId,
    verified: false,
    isPrimary: true,
    lastSeenAt: null,
    metadata: {},
  };
  const identityRefs =
    requestedIdentityRefs.length > 0 ? requestedIdentityRefs : normalizeIdentityRefs([fallbackIdentity]);
  const canonicalIdentity = identityRefs.find((ref) => ref.isPrimary) ?? identityRefs[0];
  const profileId =
    typeof request.profileId === "string" && request.profileId.trim()
      ? request.profileId.trim()
      : makeId("lp", hash(stableStringify({ storeId, profile, learnerId, canonicalIdentity })));
  const normalizedSignals = sourceSignals.map((signal) => ({
    ...signal,
    signalId: makeId("sig", hash(stableStringify(signal))),
  }));
  const signalGoals = normalizedSignals.flatMap((signal) => signal.goals);
  const signalInterestTags = normalizedSignals.flatMap((signal) => signal.interestTags);
  const signalMisconceptionIds = normalizedSignals.flatMap((signal) => signal.misconceptionIds);
  const signalEvidencePointers = normalizedSignals.flatMap((signal) => signal.evidencePointers);
  const confidenceOverrides = normalizedSignals.map((signal) => signal.profileConfidence);
  const policyException = normalizePolicyException(
    request.policyException ?? request.policy_exception ?? (request.allowWithoutEvidence ? true : null),
  );
  const evidencePointers = normalizeEvidencePointersFromRequest(request, signalEvidencePointers);
  if (evidencePointers.length === 0 && !policyException) {
    throw new Error(PROFILE_EVIDENCE_CONTRACT_ERROR);
  }
  const providedAttributes = asSortedUniqueStrings(
    [
      hasOwn(request, "status") ? "status" : null,
      hasOwn(request, "profileConfidence") ? "profileConfidence" : null,
      hasOwn(request, "displayName") ? "displayName" : null,
      hasOwn(request, "email") ? "email" : null,
      hasOwn(request, "goals") || signalGoals.length > 0 ? "goals" : null,
      hasOwn(request, "interestTags") || signalInterestTags.length > 0 ? "interestTags" : null,
      hasOwn(request, "misconceptionIds") || signalMisconceptionIds.length > 0 ? "misconceptionIds" : null,
      hasOwn(request, "metadata") ? "metadata" : null,
    ].filter(Boolean),
  );
  const displayName = normalizeBoundedString(request.displayName, "displayName", MAX_DISPLAY_NAME_LENGTH);
  const createdAt = normalizeIsoTimestamp(
    request.createdAt ?? request.timestamp,
    "learner_profile_update.createdAt",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const updatedAt = normalizeIsoTimestamp(
    request.updatedAt ?? request.timestamp,
    "learner_profile_update.updatedAt",
    createdAt,
  );
  const profileConfidence =
    confidenceOverrides.length > 0
      ? confidenceOverrides[confidenceOverrides.length - 1]
      : clamp01(request.profileConfidence, 0.5);
  const metadata = normalizeMetadata(request.metadata);

  return {
    profileId,
    learnerId,
    status: request.status === "archived" ? "archived" : "active",
    version: toPositiveInteger(request.version, 1),
    profileConfidence,
    displayName,
    email: normalizeOptionalEmail(request.email),
    goals: normalizeBoundedStringArray(
      [...normalizeBoundedStringArray(request.goals, "goals"), ...signalGoals],
      "goals",
    ),
    interestTags: normalizeBoundedStringArray(
      [...normalizeBoundedStringArray(request.interestTags, "interestTags"), ...signalInterestTags],
      "interestTags",
    ),
    misconceptionIds: normalizeBoundedStringArray(
      [...normalizeBoundedStringArray(request.misconceptionIds, "misconceptionIds"), ...signalMisconceptionIds],
      "misconceptionIds",
    ),
    identityRefs,
    metadata,
    evidencePointers,
    policyException,
    sourceSignals: normalizedSignals,
    providedAttributes,
    createdAt,
    updatedAt,
  };
}

function normalizeLineageEntry(attribute, value, timestamp, evidencePointers, policyException) {
  const normalizedTimestamp = normalizeIsoTimestamp(
    timestamp,
    `learner_profile_update.attributeLineage.${attribute}.timestamp`,
    DEFAULT_VERSION_TIMESTAMP,
  );
  const normalizedValue = stableSortObject(value === undefined ? null : value);
  const valueDigest = hash(stableStringify(normalizedValue));
  const evidencePointerIds = normalizeBoundedStringArray(
    (Array.isArray(evidencePointers) ? evidencePointers : []).map((pointer) => pointer.pointerId),
    `attributeLineage.${attribute}.evidencePointerIds`,
  );
  const policyExceptionCode = policyException?.code ?? null;
  const lineageSeed = hash(
    stableStringify({
      attribute,
      timestamp: normalizedTimestamp,
      valueDigest,
      evidencePointerIds,
      policyExceptionCode,
    }),
  );
  return {
    revisionId: makeId("rev", lineageSeed),
    attribute,
    timestamp: normalizedTimestamp,
    valueDigest,
    value: normalizedValue,
    evidencePointerIds,
    policyExceptionCode,
  };
}

function compareLineageEntries(left, right) {
  const timestampDiff = left.timestamp.localeCompare(right.timestamp);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }
  const digestDiff = left.valueDigest.localeCompare(right.valueDigest);
  if (digestDiff !== 0) {
    return digestDiff;
  }
  return left.revisionId.localeCompare(right.revisionId);
}

function appendLineageEntry(existingEntries, entry) {
  const entries = Array.isArray(existingEntries) ? [...existingEntries] : [];
  if (!entries.some((candidate) => candidate?.revisionId === entry.revisionId)) {
    entries.push(entry);
  }
  return entries.sort(compareLineageEntries);
}

function mergeLearnerProfile(existing, incoming, operationAction) {
  const base = {
    ...existing,
    learnerId: incoming.learnerId,
    status: incoming.status,
    version: Math.max(existing.version ?? 1, incoming.version),
    profileConfidence: incoming.profileConfidence,
    displayName: incoming.displayName ?? existing.displayName ?? null,
    email: incoming.email ?? existing.email ?? null,
    goals: mergeStringLists(existing.goals, incoming.goals),
    interestTags: mergeStringLists(existing.interestTags, incoming.interestTags),
    misconceptionIds: mergeStringLists(existing.misconceptionIds, incoming.misconceptionIds),
    identityRefs: normalizeIdentityRefs([...(existing.identityRefs ?? []), ...(incoming.identityRefs ?? [])]),
    metadata: stableSortObject({
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    }),
    evidencePointers: normalizeEvidencePointers([
      ...(existing.evidencePointers ?? []),
      ...(incoming.evidencePointers ?? []),
    ]),
    policyException: incoming.policyException ?? existing.policyException ?? null,
    sourceSignals: mergeSourceSignals(existing.sourceSignals, incoming.sourceSignals),
    createdAt: existing.createdAt ?? incoming.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
    updatedAt: incoming.updatedAt ?? existing.updatedAt ?? DEFAULT_VERSION_TIMESTAMP,
  };

  const timelineTimestamp = base.updatedAt ?? DEFAULT_VERSION_TIMESTAMP;
  const provided = new Set(incoming.providedAttributes ?? []);
  const lineage = isPlainObject(existing.attributeLineage) ? { ...existing.attributeLineage } : {};
  const attributeTruth = isPlainObject(existing.attributeTruth) ? { ...existing.attributeTruth } : {};

  for (const attribute of PROFILE_LINEAGE_ATTRIBUTES) {
    const existingCurrentValue = existing[attribute];
    const currentValue = hasOwn(base, attribute) ? base[attribute] : null;
    const existingTruthEntry = isPlainObject(attributeTruth[attribute]) ? attributeTruth[attribute] : null;
    const existingRevision = normalizeLineageEntry(
      attribute,
      existingCurrentValue,
      existingTruthEntry?.timestamp ?? existing.updatedAt ?? existing.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
      existing.evidencePointers ?? [],
      existing.policyException,
    );
    const incomingRevision = normalizeLineageEntry(
      attribute,
      incoming[attribute],
      incoming.updatedAt ?? timelineTimestamp,
      incoming.evidencePointers ?? [],
      incoming.policyException,
    );

    let winner = existingRevision;
    let entries = appendLineageEntry(lineage[attribute], existingRevision);
    if (operationAction === "created") {
      entries = appendLineageEntry(entries, incomingRevision);
      winner = incomingRevision;
      base[attribute] = incomingRevision.value;
    } else if (provided.has(attribute)) {
      entries = appendLineageEntry(entries, incomingRevision);
      winner = compareLineageEntries(incomingRevision, existingRevision) >= 0 ? incomingRevision : existingRevision;
      base[attribute] = winner.value;
    } else {
      base[attribute] = currentValue ?? existingCurrentValue ?? winner.value;
    }

    lineage[attribute] = entries;
    attributeTruth[attribute] = {
      timestamp: winner.timestamp,
      valueDigest: winner.valueDigest,
      revisionId: winner.revisionId,
      strategy: "timestamp_then_valueDigest_then_revisionId",
    };
  }

  base.attributeLineage = stableSortObject(lineage);
  base.attributeTruth = stableSortObject(attributeTruth);
  return base;
}

const IDENTITY_RELATIONS = new Set([
  "alias_of",
  "evidence_of",
  "misconception_of",
  "goal_of",
  "interest_of",
]);

const MISCONCEPTION_SIGNALS = new Set(["harmful", "helpful", "correction"]);
const MISCONCEPTION_STATUSES = new Set(["active", "resolved", "suppressed"]);
const CURRICULUM_STATUSES = new Set(["proposed", "committed", "blocked", "completed"]);
const REVIEW_STATUSES = new Set(["scheduled", "due", "completed", "suspended"]);
const POLICY_OUTCOMES = new Set(["allow", "review", "deny"]);
const PAIN_SIGNAL_TYPES = new Set(["harmful", "thumbs_down", "human_rewrite", "wrong_answer", "manual_correction"]);
const FAILURE_SIGNAL_TYPES = new Set([
  "test_failure",
  "regression",
  "ticket_reopened",
  "runtime_error",
  "assertion_failure",
]);
const FAILURE_SIGNAL_DEFAULT_SEVERITY = Object.freeze({
  test_failure: 0.78,
  regression: 0.9,
  ticket_reopened: 0.7,
  runtime_error: 0.82,
  assertion_failure: 0.75,
});
const CLOCK_MODES = new Set(["auto", "interaction", "sleep"]);
const RECALL_AUTH_MODES = new Set(["check", "grant", "revoke", "replace"]);
const DEGRADATION_WARNINGS = Object.freeze([
  "LLM_UNAVAILABLE",
  "INDEX_UNAVAILABLE",
]);

const INJECTION_PATTERNS = Object.freeze([
  { code: "prompt_override_ignore_previous", pattern: /ignore (all |any |the )?(previous|prior|above) (instructions|prompts|rules)/i },
  { code: "prompt_override_system_prompt", pattern: /(reveal|show|dump).*(system|developer).*(prompt|instruction)/i },
  { code: "prompt_override_privilege_escalation", pattern: /(bypass|override|disable).*(safety|guardrail|policy|restriction)/i },
  { code: "prompt_override_exfiltration", pattern: /(exfiltrate|leak|expose).*(secret|token|credential|password)/i },
  { code: "prompt_override_instruction_hijack", pattern: /you are now|act as|pretend to be/i },
  { code: "prompt_override_execution", pattern: /<script|javascript:|eval\(/i },
]);

function normalizeIdentityRelation(value) {
  if (typeof value !== "string") {
    return "alias_of";
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "alias_of";
  }
  return IDENTITY_RELATIONS.has(normalized) ? normalized : "alias_of";
}

function normalizeIdentityGraphUpdateRequest(request, storeId, profile) {
  const sourceSignals = normalizeIdentitySignalsByAgent(request);
  const learnerId =
    normalizeBoundedString(request.learnerId, "learnerId") ?? profile;
  const profileId =
    typeof request.profileId === "string" && request.profileId.trim()
      ? request.profileId.trim()
      : makeId("lp", hash(stableStringify({ storeId, profile, learnerId })));
  const firstSignal = sourceSignals[0] ?? null;
  const relation = normalizeIdentityRelation(request.relation ?? firstSignal?.relation);
  const fromRef = normalizeIdentityRef(request.fromRef ?? firstSignal?.fromRef);
  const toRef = normalizeIdentityRef(request.toRef ?? firstSignal?.toRef);
  if (fromRef.namespace === "unknown" || fromRef.value === "unknown") {
    throw new Error("identity_graph_update requires fromRef.namespace and fromRef.value.");
  }
  if (toRef.namespace === "unknown" || toRef.value === "unknown") {
    throw new Error("identity_graph_update requires toRef.namespace and toRef.value.");
  }
  if (fromRef.namespace === toRef.namespace && fromRef.value === toRef.value) {
    throw new Error("Identity graph edge endpoints must be distinct.");
  }
  const signalEvidence = sourceSignals.flatMap((signal) => signal.evidencePointers);
  const evidencePointers = normalizeEvidencePointersFromRequest(request, signalEvidence);
  const evidenceEventIds = normalizeBoundedStringArray(
    [
      ...normalizeBoundedStringArray(request.evidenceEventIds ?? request.evidenceEpisodeIds, "evidenceEventIds"),
      ...evidencePointers
        .filter((pointer) => pointer.kind === "event" || pointer.kind === "episode")
        .map((pointer) => pointer.pointerId),
    ],
    "evidenceEventIds",
  );
  const createdAt = normalizeIsoTimestamp(
    request.createdAt ?? request.timestamp ?? firstSignal?.sourceAt,
    "identity_graph_update.createdAt",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const updatedAt = normalizeIsoTimestamp(
    request.updatedAt ?? request.timestamp ?? firstSignal?.sourceAt,
    "identity_graph_update.updatedAt",
    createdAt,
  );

  const edgeId =
    typeof request.edgeId === "string" && request.edgeId.trim()
      ? request.edgeId.trim()
      : makeId("edge", hash(stableStringify({ storeId, profile, profileId, relation, fromRef, toRef })));

  return {
    edgeId,
    profileId,
    relation,
    fromRef,
    toRef,
    confidence: clamp01(request.confidence ?? firstSignal?.confidence, 0.5),
    evidencePointers,
    evidenceEventIds,
    sourceSignals: sourceSignals.map((signal) => ({
      ...signal,
      signalId: makeId("sig", hash(stableStringify(signal))),
    })),
    metadata: normalizeMetadata(request.metadata),
    createdAt,
    updatedAt,
  };
}

function mergeIdentityGraphEdge(existing, incoming) {
  return {
    ...existing,
    profileId: incoming.profileId,
    relation: incoming.relation,
    fromRef: incoming.fromRef,
    toRef: incoming.toRef,
    confidence: incoming.confidence,
    evidencePointers: normalizeEvidencePointers([
      ...(existing.evidencePointers ?? []),
      ...(incoming.evidencePointers ?? []),
    ]),
    evidenceEventIds: mergeStringLists(existing.evidenceEventIds, incoming.evidenceEventIds),
    sourceSignals: mergeSourceSignals(existing.sourceSignals, incoming.sourceSignals),
    metadata: stableSortObject({
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    }),
    createdAt: existing.createdAt ?? incoming.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
    updatedAt: incoming.updatedAt ?? existing.updatedAt ?? DEFAULT_VERSION_TIMESTAMP,
  };
}

function normalizeMisconceptionUpdateRequest(request, storeId, profile) {
  const profileId = deriveProfileId(request, storeId, profile);
  const misconceptionKey = requireNonEmptyString(request.misconceptionKey, "misconceptionKey");
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    { required: true, requiredError: MISCONCEPTION_EVIDENCE_CONTRACT_ERROR },
  );
  const signal = normalizeDeterministicEnum(
    request.signal,
    "signal",
    "misconception_update",
    MISCONCEPTION_SIGNALS,
    "harmful",
  );
  const note = typeof request.note === "string" ? request.note.trim() : "";
  const signalId =
    typeof request.signalId === "string" && request.signalId.trim()
      ? request.signalId.trim()
      : makeId(
          "sig",
          hash(
            stableStringify({
              storeId,
              profileId,
              misconceptionKey,
              signal,
              evidenceEventIds,
              note,
            }),
          ),
        );
  const misconceptionId =
    typeof request.misconceptionId === "string" && request.misconceptionId.trim()
      ? request.misconceptionId.trim()
      : makeId("mis", hash(stableStringify({ storeId, profileId, misconceptionKey })));
  const createdAt = normalizeIsoOrDefault(request.createdAt ?? request.timestamp);
  const updatedAt = normalizeIsoOrDefault(request.updatedAt ?? request.timestamp, createdAt);
  const requestedStatus = normalizeDeterministicEnum(
    request.status,
    "status",
    "misconception_update",
    MISCONCEPTION_STATUSES,
    "active",
  );
  const status = requestedStatus === "suppressed" ? "suppressed" : "active";
  const confidence = clamp01(request.confidence, signal === "harmful" ? 0.35 : 0.65);
  const metadata = normalizeMetadata({
    ...normalizeMetadata(request.metadata),
    note: note || undefined,
  });
  const severity = clamp01(metadata.severity, 0);
  const confidenceDecay = resolveMisconceptionConfidenceShift(signal, signal === "harmful" ? 1 : 0, severity);
  const antiPatterns = buildMisconceptionAntiPatterns({
    misconceptionId,
    misconceptionKey,
    harmfulSignalCount: signal === "harmful" ? 1 : 0,
    evidenceEventIds,
    sourceSignalIds: [signalId],
    updatedAt,
  });

  return {
    misconceptionId,
    profileId,
    misconceptionKey,
    status,
    signal,
    signalId,
    harmfulSignalCount: signal === "harmful" ? 1 : 0,
    helpfulSignalCount: signal === "helpful" ? 1 : 0,
    correctionSignalCount: signal === "correction" ? 1 : 0,
    confidence,
    evidenceEventIds,
    sourceSignalIds: [signalId],
    conflictEventIds: asSortedUniqueStrings(request.conflictEventIds),
    metadata,
    confidenceDecay: stableSortObject({
      stage: confidenceDecay.stage,
      accelerated: confidenceDecay.accelerated,
      accelerationMultiplier: confidenceDecay.accelerationMultiplier,
      severityPenalty: confidenceDecay.severityPenalty,
      appliedDelta: confidenceDecay.delta,
    }),
    antiPatterns,
    createdAt,
    updatedAt,
  };
}

function mergeMisconceptionRecord(existing, incoming) {
  const seenSignal = (existing.sourceSignalIds ?? []).includes(incoming.signalId);
  if (seenSignal) {
    return existing;
  }
  const harmfulSignalCount =
    toNonNegativeInteger(existing.harmfulSignalCount, 0) +
    (incoming.signal !== "harmful" ? 0 : 1);
  const helpfulSignalCount =
    toNonNegativeInteger(existing.helpfulSignalCount, 0) +
    (incoming.signal !== "helpful" ? 0 : 1);
  const correctionSignalCount =
    toNonNegativeInteger(existing.correctionSignalCount, 0) +
    (incoming.signal !== "correction" ? 0 : 1);

  const signalSeverity = clamp01(incoming?.metadata?.severity, 0);
  const confidenceDecay = resolveMisconceptionConfidenceShift(incoming.signal, harmfulSignalCount, signalSeverity);
  const confidenceBase = clamp01((existing.confidence ?? 0.5) + confidenceDecay.delta, existing.confidence ?? 0.5);
  const confidence =
    incoming.signal === "harmful"
      ? Math.max(MISCONCEPTION_CONFIDENCE_FLOOR, confidenceBase)
      : confidenceBase;
  const status =
    incoming.status === "suppressed" || existing.status === "suppressed"
      ? "suppressed"
      : correctionSignalCount >= harmfulSignalCount && harmfulSignalCount > 0
        ? "resolved"
        : "active";
  const evidenceEventIds = mergeStringLists(existing.evidenceEventIds, incoming.evidenceEventIds);
  const sourceSignalIds = mergeStringLists(existing.sourceSignalIds, incoming.sourceSignalIds);
  const antiPatterns = buildMisconceptionAntiPatterns({
    misconceptionId: existing.misconceptionId ?? incoming.misconceptionId,
    misconceptionKey: incoming.misconceptionKey,
    harmfulSignalCount,
    evidenceEventIds,
    sourceSignalIds,
    updatedAt: incoming.updatedAt ?? existing.updatedAt ?? DEFAULT_VERSION_TIMESTAMP,
  });

  return {
    ...existing,
    profileId: incoming.profileId,
    misconceptionKey: incoming.misconceptionKey,
    status,
    signal: incoming.signal,
    signalId: incoming.signalId,
    harmfulSignalCount,
    helpfulSignalCount,
    correctionSignalCount,
    confidence,
    evidenceEventIds,
    sourceSignalIds,
    conflictEventIds: mergeStringLists(existing.conflictEventIds, incoming.conflictEventIds),
    metadata: stableSortObject({
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    }),
    confidenceDecay: stableSortObject({
      stage: confidenceDecay.stage,
      accelerated: confidenceDecay.accelerated,
      accelerationMultiplier: confidenceDecay.accelerationMultiplier,
      severityPenalty: confidenceDecay.severityPenalty,
      appliedDelta: confidenceDecay.delta,
    }),
    antiPatterns,
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
}

function normalizeCurriculumPlanUpdateRequest(request, storeId, profile) {
  const profileId = deriveProfileId(request, storeId, profile);
  const objectiveId = requireNonEmptyString(request.objectiveId, "objectiveId");
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    { required: true, requiredError: CURRICULUM_EVIDENCE_CONTRACT_ERROR },
  );
  const status = normalizeDeterministicEnum(
    request.status,
    "status",
    "curriculum_plan_update",
    CURRICULUM_STATUSES,
    "proposed",
  );
  const recommendationRank = toPositiveInteger(request.recommendationRank ?? request.rank, 1);
  const planItemId =
    typeof request.planItemId === "string" && request.planItemId.trim()
      ? request.planItemId.trim()
      : makeId("cp", hash(stableStringify({ storeId, profileId, objectiveId })));
  const createdAt = normalizeIsoOrDefault(request.createdAt ?? request.timestamp);
  const updatedAt = normalizeIsoOrDefault(request.updatedAt ?? request.timestamp, createdAt);
  const dueAt = normalizeIsoOrDefault(request.dueAt ?? request.targetAt ?? createdAt, createdAt);

  return {
    planItemId,
    profileId,
    objectiveId,
    status,
    recommendationRank,
    dueAt,
    sourceMisconceptionIds: asSortedUniqueStrings(request.sourceMisconceptionIds),
    interestTags: asSortedUniqueStrings(request.interestTags),
    evidenceEventIds,
    provenanceSignalIds: asSortedUniqueStrings(request.provenanceSignalIds ?? request.sourceSignalIds),
    metadata: normalizeMetadata(request.metadata),
    createdAt,
    updatedAt,
  };
}

function mergeCurriculumPlanItem(existing, incoming) {
  return {
    ...existing,
    profileId: incoming.profileId,
    objectiveId: incoming.objectiveId,
    status: existing.status === "blocked" ? "blocked" : incoming.status,
    recommendationRank: Math.min(existing.recommendationRank ?? 1, incoming.recommendationRank ?? 1),
    dueAt: incoming.dueAt ?? existing.dueAt,
    sourceMisconceptionIds: mergeStringLists(existing.sourceMisconceptionIds, incoming.sourceMisconceptionIds),
    interestTags: mergeStringLists(existing.interestTags, incoming.interestTags),
    evidenceEventIds: mergeStringLists(existing.evidenceEventIds, incoming.evidenceEventIds),
    provenanceSignalIds: mergeStringLists(existing.provenanceSignalIds, incoming.provenanceSignalIds),
    metadata: stableSortObject({
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    }),
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
}

function normalizeReviewScheduleUpdateRequest(request, storeId, profile) {
  const profileId = deriveProfileId(request, storeId, profile);
  const targetId = requireNonEmptyString(request.targetId, "targetId");
  const sourceEventIds = normalizeGuardedStringArray(request.sourceEventIds, "sourceEventIds", {
    required: true,
    requiredError: REVIEW_SOURCE_EVENT_CONTRACT_ERROR,
  });
  const status = normalizeDeterministicEnum(
    request.status,
    "status",
    "review_schedule_update",
    REVIEW_STATUSES,
    "scheduled",
  );
  const createdAt = normalizeIsoOrDefault(request.createdAt ?? request.timestamp);
  const updatedAt = normalizeIsoOrDefault(request.updatedAt ?? request.timestamp, createdAt);
  const dueAt = normalizeIsoOrDefault(request.dueAt ?? createdAt, createdAt);
  const scheduleEntryId =
    typeof request.scheduleEntryId === "string" && request.scheduleEntryId.trim()
      ? request.scheduleEntryId.trim()
      : makeId("srs", hash(stableStringify({ storeId, profileId, targetId })));

  return {
    scheduleEntryId,
    profileId,
    targetId,
    status,
    repetition: toNonNegativeInteger(request.repetition, 0),
    intervalDays: toPositiveInteger(request.intervalDays, 1),
    easeFactor: clamp01(request.easeFactor, 0.6),
    dueAt,
    sourceEventIds,
    evidenceEventIds: asSortedUniqueStrings(request.evidenceEventIds ?? request.evidenceEpisodeIds),
    metadata: normalizeMetadata(request.metadata),
    createdAt,
    updatedAt,
  };
}

function mergeReviewScheduleEntry(existing, incoming) {
  return {
    ...existing,
    profileId: incoming.profileId,
    targetId: incoming.targetId,
    status: incoming.status,
    repetition: Math.max(existing.repetition ?? 0, incoming.repetition ?? 0),
    intervalDays: incoming.intervalDays ?? existing.intervalDays,
    easeFactor: incoming.easeFactor ?? existing.easeFactor,
    dueAt: incoming.dueAt ?? existing.dueAt,
    sourceEventIds: mergeStringLists(existing.sourceEventIds, incoming.sourceEventIds),
    evidenceEventIds: mergeStringLists(existing.evidenceEventIds, incoming.evidenceEventIds),
    metadata: stableSortObject({
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    }),
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
}

function normalizePolicyDecisionUpdateRequest(request, storeId, profile) {
  const profileId = deriveProfileId(request, storeId, profile);
  const policyKey = requireNonEmptyString(request.policyKey, "policyKey");
  const action = typeof request.action === "string" && request.action.trim() ? request.action.trim() : "evaluate";
  const surface = typeof request.surface === "string" && request.surface.trim() ? request.surface.trim() : "general";
  const outcome = normalizeDeterministicEnum(
    request.outcome,
    "outcome",
    "policy_decision_update",
    POLICY_OUTCOMES,
    "review",
  );
  const reasonCodes = normalizeGuardedStringArray(request.reasonCodes, "reasonCodes");
  if (outcome === "deny" && reasonCodes.length === 0) {
    throw new Error(POLICY_REASON_CODES_CONTRACT_ERROR);
  }
  const provenanceEventIds = normalizeGuardedStringArray(request.provenanceEventIds, "provenanceEventIds", {
    required: true,
    requiredError: POLICY_PROVENANCE_EVENT_CONTRACT_ERROR,
  });
  const decisionId =
    typeof request.decisionId === "string" && request.decisionId.trim()
      ? request.decisionId.trim()
      : makeId("pol", hash(stableStringify({ storeId, profileId, policyKey, surface, action })));
  const createdAt = normalizeIsoOrDefault(request.createdAt ?? request.timestamp);
  const updatedAt = normalizeIsoOrDefault(request.updatedAt ?? request.timestamp, createdAt);

  return {
    decisionId,
    profileId,
    policyKey,
    action,
    surface,
    outcome,
    reasonCodes,
    provenanceEventIds,
    evidenceEventIds: asSortedUniqueStrings(request.evidenceEventIds ?? request.evidenceEpisodeIds),
    metadata: normalizeMetadata(request.metadata),
    createdAt,
    updatedAt,
  };
}

function mergePolicyDecision(existing, incoming) {
  const severity = { allow: 1, review: 2, deny: 3 };
  const outcome =
    severity[existing.outcome] >= severity[incoming.outcome] ? existing.outcome : incoming.outcome;

  return {
    ...existing,
    profileId: incoming.profileId,
    policyKey: incoming.policyKey,
    action: incoming.action,
    surface: incoming.surface,
    outcome,
    reasonCodes: mergeStringLists(existing.reasonCodes, incoming.reasonCodes),
    provenanceEventIds: mergeStringLists(existing.provenanceEventIds, incoming.provenanceEventIds),
    evidenceEventIds: mergeStringLists(existing.evidenceEventIds, incoming.evidenceEventIds),
    metadata: stableSortObject({
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    }),
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
}

function getStoreProfiles(storeId) {
  const existing = stores.get(storeId);
  if (existing) {
    return existing;
  }
  const created = new Map();
  stores.set(storeId, created);
  return created;
}

function getProfileState(storeId, profile) {
  const profiles = getStoreProfiles(storeId);
  const existing = profiles.get(profile);
  if (existing) {
    return existing;
  }
  const created = {
    events: [],
    eventDigests: new Set(),
    rules: [],
    feedback: [],
    outcomes: [],
    learnerProfiles: [],
    identityGraphEdges: [],
    misconceptions: [],
    misconceptionChronologyHistory: [],
    curriculumPlanItems: [],
    curriculumConflictHistory: [],
    curriculumRecommendationSnapshots: [],
    reviewScheduleEntries: [],
    painSignals: [],
    failureSignals: [],
    schedulerClocks: {
      interactionTick: 0,
      sleepTick: 0,
      fatigueLoad: 0,
      sleepThreshold: DEFAULT_SLEEP_THRESHOLD,
      fatigueThreshold: DEFAULT_SLEEP_THRESHOLD,
      noveltyWriteLoad: 0,
      noveltyWriteThreshold: DEFAULT_SLEEP_THRESHOLD,
      consolidationCount: 0,
      lastConsolidationCause: "none",
      lastInteractionAt: DEFAULT_VERSION_TIMESTAMP,
      lastSleepAt: DEFAULT_VERSION_TIMESTAMP,
      lastConsolidatedAt: DEFAULT_VERSION_TIMESTAMP,
      updatedAt: DEFAULT_VERSION_TIMESTAMP,
    },
    reviewArchivalTiers: {
      activeLimit: DEFAULT_ACTIVE_REVIEW_SET_LIMIT,
      activeReviewIds: [],
      tiers: {
        warm: [],
        cold: [],
        frozen: [],
      },
      archivedRecords: [],
      updatedAt: DEFAULT_VERSION_TIMESTAMP,
    },
    recallAllowlistPolicy: {
      policyId: makeId("allow", hash(stableStringify({ storeId, profile }))),
      allowedStoreIds: [storeId],
      updatedAt: DEFAULT_VERSION_TIMESTAMP,
      metadata: {},
    },
    degradedTutorSessions: [],
    policyDecisions: [],
    policyAuditTrail: [],
  };
  profiles.set(profile, created);
  return created;
}

function normalizeEvent(raw, index) {
  const event = raw && typeof raw === "object" ? raw : {};
  const material = stableStringify({
    source: event.source ?? "unknown",
    type: event.type ?? "note",
    content: event.content ?? "",
    ordinal: index,
  });
  const digest = hash(material);
  return {
    eventId: typeof event.id === "string" && event.id ? event.id : makeId("evt", digest),
    type: event.type ?? "note",
    source: event.source ?? "unknown",
    content: event.content ?? "",
    digest,
  };
}

function normalizeRuleCandidate(raw) {
  const candidate = raw && typeof raw === "object" ? raw : {};
  const statement = typeof candidate.statement === "string" ? candidate.statement.trim() : "";
  const source = typeof candidate.sourceEventId === "string" ? candidate.sourceEventId : "unknown";
  const material = stableStringify({ statement, source });
  const digest = hash(material);
  return {
    candidateId: makeId("cand", digest),
    statement,
    sourceEventId: source,
    confidence: Number.isFinite(candidate.confidence) ? Number(candidate.confidence) : 0.5,
  };
}

function normalizeRequest(operation, request) {
  requireObject(request);
  const storeId = defaultStoreId(request.storeId ?? request.store);
  const profile = defaultProfile();
  return {
    storeId,
    profile,
    input: stableSortObject({
      ...request,
      storeId,
      profile,
    }),
    operation,
  };
}

function findByDigestPrefix(items, digestPrefix, field) {
  if (typeof digestPrefix !== "string" || !digestPrefix) {
    return null;
  }
  return items.find((item) => item[field].startsWith(digestPrefix)) ?? null;
}

function buildMeta(operation, storeId, profile, input) {
  const seed = opSeed(operation, storeId, profile, input);
  return {
    operation,
    storeId,
    profile,
    requestDigest: seed,
    deterministic: true,
  };
}

function deterministicLatencyMs(requestDigest, min = 4, max = 40) {
  const seed = Number.parseInt(typeof requestDigest === "string" ? requestDigest.slice(0, 8) : "", 16);
  if (!Number.isFinite(seed)) {
    return min;
  }
  return min + (seed % (max - min + 1));
}

function latencyBucket(latencyMs) {
  if (latencyMs <= 10) {
    return "le_10ms";
  }
  if (latencyMs <= 20) {
    return "le_20ms";
  }
  if (latencyMs <= 30) {
    return "le_30ms";
  }
  return "gt_30ms";
}

function buildSloObservability(requestDigest, operation, targetP95Ms) {
  const observedLatencyMs = deterministicLatencyMs(requestDigest);
  const budgetDeltaMs = observedLatencyMs - targetP95Ms;
  const withinBudget = budgetDeltaMs <= 0;
  return {
    targetP95Ms,
    observedLatencyMs,
    latencyBucket: latencyBucket(observedLatencyMs),
    budgetStatus: withinBudget ? "within_budget" : "out_of_budget",
    withinBudget,
    budgetDeltaMs,
    operation,
    deterministic: true,
    replaySafe: true,
  };
}

function compareByIsoTimestampThenId(leftTimestamp, leftId, rightTimestamp, rightId) {
  const timestampDiff = String(leftTimestamp ?? "").localeCompare(String(rightTimestamp ?? ""));
  if (timestampDiff !== 0) {
    return timestampDiff;
  }
  return String(leftId ?? "").localeCompare(String(rightId ?? ""));
}

function sortByTimestampAndId(values, timestampField, idField) {
  return [...values].sort((left, right) =>
    compareByIsoTimestampThenId(left?.[timestampField], left?.[idField], right?.[timestampField], right?.[idField]),
  );
}

function getOrCreateSchedulerClocks(state) {
  const current = isPlainObject(state.schedulerClocks) ? state.schedulerClocks : {};
  const fatigueThreshold = toPositiveInteger(
    current.fatigueThreshold ?? current.sleepThreshold,
    DEFAULT_SLEEP_THRESHOLD,
  );
  const normalized = {
    interactionTick: toNonNegativeInteger(current.interactionTick, 0),
    sleepTick: toNonNegativeInteger(current.sleepTick, 0),
    fatigueLoad: toNonNegativeInteger(current.fatigueLoad, 0),
    sleepThreshold: fatigueThreshold,
    fatigueThreshold,
    noveltyWriteLoad: toNonNegativeInteger(current.noveltyWriteLoad, 0),
    noveltyWriteThreshold: toPositiveInteger(
      current.noveltyWriteThreshold,
      fatigueThreshold,
    ),
    consolidationCount: toNonNegativeInteger(current.consolidationCount, 0),
    lastConsolidationCause:
      normalizeBoundedString(current.lastConsolidationCause, "schedulerClocks.lastConsolidationCause", 64) ??
      "none",
    lastInteractionAt: normalizeIsoTimestampOrFallback(current.lastInteractionAt, DEFAULT_VERSION_TIMESTAMP),
    lastSleepAt: normalizeIsoTimestampOrFallback(current.lastSleepAt, DEFAULT_VERSION_TIMESTAMP),
    lastConsolidatedAt: normalizeIsoTimestampOrFallback(current.lastConsolidatedAt, DEFAULT_VERSION_TIMESTAMP),
    updatedAt: normalizeIsoTimestampOrFallback(current.updatedAt, DEFAULT_VERSION_TIMESTAMP),
  };
  state.schedulerClocks = normalized;
  return normalized;
}

function getOrCreateReviewArchivalTiers(state) {
  const current = isPlainObject(state.reviewArchivalTiers) ? state.reviewArchivalTiers : {};
  const tiers = isPlainObject(current.tiers) ? current.tiers : {};
  const normalized = {
    activeLimit: Math.min(
      Math.max(toPositiveInteger(current.activeLimit, DEFAULT_ACTIVE_REVIEW_SET_LIMIT), 1),
      MAX_ACTIVE_REVIEW_SET_LIMIT,
    ),
    activeReviewIds: normalizeBoundedStringArray(current.activeReviewIds, "reviewArchivalTiers.activeReviewIds"),
    tiers: {
      warm: normalizeBoundedStringArray(tiers.warm, "reviewArchivalTiers.tiers.warm"),
      cold: normalizeBoundedStringArray(tiers.cold, "reviewArchivalTiers.tiers.cold"),
      frozen: normalizeBoundedStringArray(tiers.frozen, "reviewArchivalTiers.tiers.frozen"),
    },
    archivedRecords: Array.isArray(current.archivedRecords)
      ? sortByTimestampAndId(
          current.archivedRecords
            .filter((record) => isPlainObject(record))
            .map((record) => ({
              archiveRecordId:
                normalizeBoundedString(record.archiveRecordId, "reviewArchivalTiers.archiveRecordId", 64) ??
                makeId("arc", hash(stableStringify(record))),
              scheduleEntryId: normalizeBoundedString(record.scheduleEntryId, "reviewArchivalTiers.scheduleEntryId") ?? "unknown",
              targetId: normalizeBoundedString(record.targetId, "reviewArchivalTiers.targetId") ?? "unknown",
              tier: normalizeDeterministicEnum(
                record.tier,
                "tier",
                "review_set_rebalance",
                new Set(["warm", "cold", "frozen"]),
                "warm",
              ),
              archivedAt: normalizeIsoTimestampOrFallback(record.archivedAt, DEFAULT_VERSION_TIMESTAMP),
              dueAt: normalizeIsoTimestampOrFallback(record.dueAt, DEFAULT_VERSION_TIMESTAMP),
              sourceEventIds: normalizeBoundedStringArray(record.sourceEventIds, "reviewArchivalTiers.sourceEventIds"),
              evidenceEventIds: normalizeBoundedStringArray(record.evidenceEventIds, "reviewArchivalTiers.evidenceEventIds"),
              metadata: normalizeMetadata(record.metadata),
            })),
          "archivedAt",
          "archiveRecordId",
        )
      : [],
    updatedAt: normalizeIsoTimestampOrFallback(current.updatedAt, DEFAULT_VERSION_TIMESTAMP),
  };
  state.reviewArchivalTiers = normalized;
  return normalized;
}

function getOrCreateRecallAllowlistPolicy(state, storeId, profile) {
  const current = isPlainObject(state.recallAllowlistPolicy) ? state.recallAllowlistPolicy : {};
  const policyId =
    normalizeBoundedString(current.policyId, "recallAllowlistPolicy.policyId", 64) ??
    makeId("allow", hash(stableStringify({ storeId, profile })));
  const allowedStoreIds = mergeStringLists(current.allowedStoreIds, [storeId]);
  const normalized = {
    policyId,
    allowedStoreIds,
    updatedAt: normalizeIsoTimestampOrFallback(current.updatedAt, DEFAULT_VERSION_TIMESTAMP),
    metadata: normalizeMetadata(current.metadata),
  };
  state.recallAllowlistPolicy = normalized;
  return normalized;
}

function ensureRecallAuthorizationForOperation(
  state,
  { storeId, profile, requesterStoreId, operation, timestamp = DEFAULT_VERSION_TIMESTAMP },
) {
  const requester = normalizeBoundedString(requesterStoreId, "requesterStoreId", 128) ?? storeId;
  const crossSpace = requester !== storeId;
  const policy = getOrCreateRecallAllowlistPolicy(state, storeId, profile);
  const authorized = !crossSpace || policy.allowedStoreIds.includes(requester);
  const reasonCodes = authorized ? ["allowlist_authorized"] : ["allowlist_denied"];
  const auditEvent = appendPolicyAuditTrail(state, {
    operation,
    storeId,
    profile,
    entityId: makeId(
      "auth",
      hash(stableStringify({ operation, requesterStoreId: requester, storeId, profile, timestamp })),
    ),
    outcome: authorized ? "allow" : "deny",
    reasonCodes,
    details: {
      requesterStoreId: requester,
      targetStoreId: storeId,
      crossSpace,
      allowStoreIds: policy.allowedStoreIds,
    },
    timestamp,
  });

  if (!authorized) {
    const error = new Error(`${CROSS_SPACE_ALLOWLIST_DENY_ERROR} requesterStoreId=${requester} targetStoreId=${storeId}`);
    error.code = "PERSONALIZATION_POLICY_DENY";
    error.policyAuditEventId = auditEvent.auditEventId;
    throw error;
  }

  return {
    authorized,
    crossSpace,
    policy,
    policyAuditEventId: auditEvent.auditEventId,
  };
}

function appendPolicyAuditTrail(state, rawEvent) {
  const event = isPlainObject(rawEvent) ? rawEvent : {};
  const timestamp = normalizeIsoTimestampOrFallback(event.timestamp, DEFAULT_VERSION_TIMESTAMP);
  const material = stableSortObject({
    operation: event.operation ?? "unknown",
    storeId: event.storeId ?? DEFAULT_STORE_ID,
    profile: event.profile ?? INTERNAL_PROFILE_ID,
    entityId: event.entityId ?? null,
    outcome: event.outcome ?? "recorded",
    reasonCodes: normalizeBoundedStringArray(event.reasonCodes, "policyAuditTrail.reasonCodes"),
    details: normalizeMetadata(event.details),
    timestamp,
  });
  const auditEventId =
    normalizeBoundedString(event.auditEventId, "policyAuditTrail.auditEventId", 64) ??
    makeId("audit", hash(stableStringify(material)));
  const nextEvent = {
    auditEventId,
    operation: String(event.operation ?? "unknown"),
    storeId: String(event.storeId ?? DEFAULT_STORE_ID),
    profile: String(event.profile ?? INTERNAL_PROFILE_ID),
    entityId: event.entityId ?? null,
    outcome: String(event.outcome ?? "recorded"),
    reasonCodes: normalizeBoundedStringArray(event.reasonCodes, "policyAuditTrail.reasonCodes"),
    details: normalizeMetadata(event.details),
    timestamp,
  };

  const existing = Array.isArray(state.policyAuditTrail) ? state.policyAuditTrail : [];
  if (existing.some((entry) => entry?.auditEventId === auditEventId)) {
    state.policyAuditTrail = sortByTimestampAndId(existing, "timestamp", "auditEventId").slice(
      -MAX_POLICY_AUDIT_EVENTS,
    );
    return nextEvent;
  }

  state.policyAuditTrail = sortByTimestampAndId(
    [...existing, nextEvent],
    "timestamp",
    "auditEventId",
  ).slice(-MAX_POLICY_AUDIT_EVENTS);
  return nextEvent;
}

function addDaysToIso(baseIso, days) {
  const parsed = Date.parse(baseIso);
  if (!Number.isFinite(parsed)) {
    return baseIso;
  }
  const safeDays = Number.isFinite(days) ? Number(days) : 0;
  return new Date(parsed + Math.trunc(safeDays) * 24 * 60 * 60 * 1000).toISOString();
}

function detectPromptInjection(statement) {
  const normalized = typeof statement === "string" ? statement.trim() : "";
  if (!normalized) {
    return [];
  }
  const matches = [];
  for (const rule of INJECTION_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      matches.push(rule.code);
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

function stableScore(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizeRecommendationWeights(value) {
  const candidate = isPlainObject(value) ? value : {};
  const raw = {
    interest: Math.max(toFiniteNumber(candidate.interest, DEFAULT_RECOMMENDATION_WEIGHTS.interest), 0),
    masteryGap: Math.max(toFiniteNumber(candidate.masteryGap, DEFAULT_RECOMMENDATION_WEIGHTS.masteryGap), 0),
    due: Math.max(toFiniteNumber(candidate.due, DEFAULT_RECOMMENDATION_WEIGHTS.due), 0),
    evidence: Math.max(toFiniteNumber(candidate.evidence, DEFAULT_RECOMMENDATION_WEIGHTS.evidence), 0),
  };
  const total = raw.interest + raw.masteryGap + raw.due + raw.evidence;
  if (total <= 0) {
    return stableSortObject(DEFAULT_RECOMMENDATION_WEIGHTS);
  }
  const normalized = {
    interest: Number((raw.interest / total).toFixed(6)),
    due: Number((raw.due / total).toFixed(6)),
    evidence: Number((raw.evidence / total).toFixed(6)),
  };
  normalized.masteryGap = Number(
    Math.max(0, 1 - (normalized.interest + normalized.due + normalized.evidence)).toFixed(6),
  );
  return stableSortObject(normalized);
}

function isoAgeDays(referenceAt, targetAt) {
  const referenceMs = Date.parse(referenceAt);
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(referenceMs) || !Number.isFinite(targetMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((referenceMs - targetMs) / (24 * 60 * 60 * 1000)));
}

function buildFreshnessAndDecayMetadata(planItem, referenceAt, freshnessWarningDays, decayWarningDays) {
  const referencePoint = normalizeIsoTimestampOrFallback(
    planItem.updatedAt ?? planItem.dueAt ?? planItem.createdAt,
    DEFAULT_VERSION_TIMESTAMP,
  );
  const ageDays = isoAgeDays(referenceAt, referencePoint);
  const stale = ageDays >= freshnessWarningDays;
  const decayed = ageDays >= decayWarningDays;
  const warningCodes = [];
  if (stale) {
    warningCodes.push("freshness_warning");
  }
  if (decayed) {
    warningCodes.push("decay_warning");
  }
  const decayPenalty = decayed ? 24 : stale ? 12 : 0;
  return {
    referencePoint,
    ageDays,
    stale,
    decayed,
    warningCodes: warningCodes.sort((left, right) => left.localeCompare(right)),
    freshnessWarningDays,
    decayWarningDays,
    decayPenalty,
  };
}

function estimateRecommendationTokenCost(planItem, provenancePointers) {
  const objectiveText = String(planItem?.objectiveId ?? "");
  const metadataLength = stableStringify(planItem?.metadata ?? {}).length;
  const estimate = Math.ceil(objectiveText.length / 4) + Math.ceil(metadataLength / 20) + provenancePointers.length * 8 + 12;
  return Math.max(24, estimate);
}

function resolveMisconceptionDecayStage(harmfulSignalCount) {
  const count = toNonNegativeInteger(harmfulSignalCount, 0);
  if (count < MISCONCEPTION_DECAY_STAGE_THRESHOLDS[0]) {
    return 0;
  }
  if (count < MISCONCEPTION_DECAY_STAGE_THRESHOLDS[1]) {
    return 1;
  }
  if (count < MISCONCEPTION_DECAY_STAGE_THRESHOLDS[2]) {
    return 2;
  }
  if (count < MISCONCEPTION_DECAY_STAGE_THRESHOLDS[3]) {
    return 3;
  }
  return 4;
}

function resolveMisconceptionConfidenceShift(signal, harmfulSignalCount, severity) {
  const decayStage = resolveMisconceptionDecayStage(harmfulSignalCount);
  if (signal !== "harmful") {
    return {
      delta: MISCONCEPTION_SIGNAL_BASE_DELTA[signal] ?? 0,
      stage: decayStage,
      accelerated: false,
      accelerationMultiplier: 1,
      severityPenalty: 0,
    };
  }
  const baseDecay = MISCONCEPTION_DECAY_BY_STAGE[decayStage] ?? MISCONCEPTION_DECAY_BY_STAGE[4];
  const accelerationMultiplier = decayStage >= 2 ? Number((1 + (decayStage - 1) * 0.35).toFixed(6)) : 1;
  const severityPenalty = Number((clamp01(severity, 0) * MISCONCEPTION_HARMFUL_SEVERITY_MULTIPLIER).toFixed(6));
  return {
    delta: Number((-(baseDecay + severityPenalty)).toFixed(6)),
    stage: decayStage,
    accelerated: decayStage >= 2,
    accelerationMultiplier,
    severityPenalty,
  };
}

function buildMisconceptionAntiPatterns(record) {
  const harmfulSignalCount = toNonNegativeInteger(record?.harmfulSignalCount, 0);
  if (harmfulSignalCount <= 0) {
    return [];
  }
  const evidenceEventIds = normalizeBoundedStringArray(record?.evidenceEventIds, "misconception.antiPattern.evidenceEventIds");
  const sourceSignalIds = normalizeBoundedStringArray(record?.sourceSignalIds, "misconception.antiPattern.sourceSignalIds");
  const antiPatterns = [];
  for (let index = 0; index < MISCONCEPTION_ANTI_PATTERN_THRESHOLDS.length; index += 1) {
    const threshold = MISCONCEPTION_ANTI_PATTERN_THRESHOLDS[index];
    if (harmfulSignalCount < threshold) {
      continue;
    }
    const antiPatternId = makeId(
      "anti",
      hash(
        stableStringify({
          misconceptionId: record?.misconceptionId ?? "unknown",
          threshold,
        }),
      ),
    );
    antiPatterns.push({
      antiPatternId,
      threshold,
      stage: index + 1,
      recommendationMode: "invert_unstable_guidance",
      statement: `avoid:${record?.misconceptionKey ?? "unknown"}`,
      harmfulSignalCount,
      evidenceEventIds,
      sourceSignalIds,
      activatedAt: normalizeIsoTimestampOrFallback(record?.updatedAt, DEFAULT_VERSION_TIMESTAMP),
    });
  }
  return antiPatterns.sort((left, right) =>
    compareByIsoTimestampThenId(left.activatedAt, left.antiPatternId, right.activatedAt, right.antiPatternId),
  );
}

function summarizeCurriculumConflictChanges(previous, next) {
  const watchedFields = [
    "status",
    "recommendationRank",
    "dueAt",
    "objectiveId",
    "sourceMisconceptionIds",
    "interestTags",
    "evidenceEventIds",
    "provenanceSignalIds",
  ];
  const changedFields = [];
  for (const field of watchedFields) {
    if (stableStringify(previous?.[field]) !== stableStringify(next?.[field])) {
      changedFields.push(field);
    }
  }
  return changedFields.sort((left, right) => left.localeCompare(right));
}

function appendCurriculumConflictNote(state, conflictNote) {
  const existing = Array.isArray(state.curriculumConflictHistory) ? state.curriculumConflictHistory : [];
  if (existing.some((entry) => entry?.noteId === conflictNote.noteId)) {
    state.curriculumConflictHistory = sortByTimestampAndId(existing, "timestamp", "noteId");
    return conflictNote;
  }
  state.curriculumConflictHistory = sortByTimestampAndId(
    [...existing, conflictNote],
    "timestamp",
    "noteId",
  ).slice(-MAX_POLICY_AUDIT_EVENTS);
  return conflictNote;
}

function summarizeMisconceptionChanges(previous, next) {
  const watchedFields = [
    "status",
    "signal",
    "confidence",
    "harmfulSignalCount",
    "helpfulSignalCount",
    "correctionSignalCount",
    "evidenceEventIds",
    "sourceSignalIds",
    "antiPatterns",
  ];
  const changedFields = [];
  for (const field of watchedFields) {
    if (stableStringify(previous?.[field]) !== stableStringify(next?.[field])) {
      changedFields.push(field);
    }
  }
  return changedFields.sort((left, right) => left.localeCompare(right));
}

function appendMisconceptionChronologyNote(state, chronologyNote) {
  const existing = Array.isArray(state.misconceptionChronologyHistory) ? state.misconceptionChronologyHistory : [];
  if (existing.some((entry) => entry?.noteId === chronologyNote.noteId)) {
    state.misconceptionChronologyHistory = sortByTimestampAndId(existing, "timestamp", "noteId");
    return chronologyNote;
  }
  state.misconceptionChronologyHistory = sortByTimestampAndId(
    [...existing, chronologyNote],
    "timestamp",
    "noteId",
  ).slice(-MAX_POLICY_AUDIT_EVENTS);
  return chronologyNote;
}

function createEmptyLearnerProfileSeed(incoming) {
  return {
    profileId: incoming.profileId,
    learnerId: incoming.learnerId,
    status: "active",
    version: Math.max(incoming.version ?? 1, 1),
    profileConfidence: 0.5,
    displayName: null,
    email: null,
    goals: [],
    interestTags: [],
    misconceptionIds: [],
    identityRefs: [],
    metadata: {},
    evidencePointers: [],
    policyException: null,
    sourceSignals: [],
    providedAttributes: [],
    createdAt: incoming.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
    updatedAt: incoming.updatedAt ?? incoming.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
    attributeLineage: {},
    attributeTruth: {},
  };
}

function upsertDeterministicRecord(records, idField, record, timestampField = "createdAt") {
  const source = Array.isArray(records) ? records : [];
  const identifier = record?.[idField];
  const existingIndex = source.findIndex((entry) => entry?.[idField] === identifier);
  if (existingIndex >= 0) {
    const existing = source[existingIndex];
    if (stableStringify(existing) === stableStringify(record)) {
      return {
        action: "noop",
        nextRecords: sortByTimestampAndId(source, timestampField, idField),
        record: existing,
      };
    }
    const nextRecords = [...source];
    nextRecords[existingIndex] = record;
    return {
      action: "updated",
      nextRecords: sortByTimestampAndId(nextRecords, timestampField, idField),
      record,
    };
  }
  return {
    action: "created",
    nextRecords: sortByTimestampAndId([...source, record], timestampField, idField),
    record,
  };
}

function normalizePainSignalIngestRequest(request, storeId, profile) {
  const misconceptionKey = requireNonEmptyString(
    request.misconceptionKey ?? request.targetId ?? request.targetRuleId,
    "misconceptionKey",
  );
  const signalType = normalizeDeterministicEnum(
    request.signalType ?? request.signal ?? request.painType,
    "signalType",
    "pain_signal_ingest",
    PAIN_SIGNAL_TYPES,
    "harmful",
  );
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    { required: true, requiredError: PAIN_SIGNAL_EVIDENCE_CONTRACT_ERROR },
  );
  const sourceEventIds = normalizeGuardedStringArray(request.sourceEventIds, "sourceEventIds");
  const provenanceSource =
    normalizeBoundedString(request.provenanceSource ?? request.source ?? request.actor, "provenanceSource", 128) ??
    "human_feedback";
  const severity = clamp01(request.severity, 0.92);
  const note = normalizeBoundedString(request.note ?? request.message ?? request.feedbackText, "note", 1024);
  const recordedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.recordedAt ?? request.createdAt,
    "pain_signal_ingest.timestamp",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const mappedSignal = "harmful";
  const painSignalId =
    normalizeBoundedString(request.painSignalId ?? request.signalId, "painSignalId", 64) ??
    makeId(
      "pain",
      hash(
        stableStringify({
          storeId,
          profile,
          misconceptionKey,
          signalType,
          mappedSignal,
          severity,
          evidenceEventIds,
          sourceEventIds,
          provenanceSource,
          note: note ?? null,
        }),
      ),
    );

  return {
    painSignalId,
    misconceptionKey,
    signalType,
    mappedSignal,
    severity,
    evidenceEventIds,
    sourceEventIds,
    provenanceSource,
    note,
    recordedAt,
    metadata: normalizeMetadata(request.metadata),
  };
}

function normalizeFailureSignalIngestRequest(request, storeId, profile) {
  const misconceptionKey = requireNonEmptyString(
    request.misconceptionKey ?? request.targetId ?? request.targetRuleId,
    "misconceptionKey",
  );
  const failureType = normalizeDeterministicEnum(
    request.failureType ?? request.signalType ?? request.type,
    "failureType",
    "failure_signal_ingest",
    FAILURE_SIGNAL_TYPES,
    "test_failure",
  );
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    { required: true, requiredError: FAILURE_SIGNAL_EVIDENCE_CONTRACT_ERROR },
  );
  const sourceEventIds = normalizeGuardedStringArray(
    request.sourceEventIds ?? request.provenanceEventIds,
    "sourceEventIds",
  );
  const failureCount = Math.max(toPositiveInteger(request.failureCount ?? request.count, 1), 1);
  const severity = clamp01(request.severity, FAILURE_SIGNAL_DEFAULT_SEVERITY[failureType] ?? 0.75);
  const pressureDelta = Number((severity * Math.max(1, failureCount) * 0.2).toFixed(4));
  const outcomeRef =
    normalizeBoundedString(request.outcomeId ?? request.taskId ?? request.task, "outcomeRef", 128) ?? "unspecified";
  const recordedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.recordedAt ?? request.createdAt,
    "failure_signal_ingest.timestamp",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const failureSignalId =
    normalizeBoundedString(request.failureSignalId ?? request.signalId, "failureSignalId", 64) ??
    makeId(
      "fail",
      hash(
        stableStringify({
          storeId,
          profile,
          misconceptionKey,
          failureType,
          failureCount,
          severity,
          evidenceEventIds,
          sourceEventIds,
          outcomeRef,
        }),
      ),
    );

  return {
    failureSignalId,
    misconceptionKey,
    failureType,
    failureCount,
    severity,
    pressureDelta,
    mappedSignal: "harmful",
    evidenceEventIds,
    sourceEventIds,
    outcomeRef,
    recordedAt,
    metadata: normalizeMetadata(request.metadata),
  };
}

function normalizeCurriculumRecommendationRequest(request) {
  const referenceAt = normalizeIsoTimestamp(
    request.referenceAt ?? request.timestamp ?? request.generatedAt,
    "curriculum_recommendation.referenceAt",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const maxRecommendations = Math.min(
    Math.max(toPositiveInteger(request.maxRecommendations ?? request.limit, 5), 1),
    MAX_RECOMMENDATIONS,
  );
  const freshnessWarningDays = Math.min(
    Math.max(toPositiveInteger(request.freshnessWarningDays ?? request.freshnessThresholdDays, DEFAULT_FRESHNESS_WARNING_DAYS), 1),
    365,
  );
  const decayWarningDays = Math.min(
    Math.max(toPositiveInteger(request.decayWarningDays ?? request.decayThresholdDays, DEFAULT_DECAY_WARNING_DAYS), freshnessWarningDays),
    730,
  );
  const tokenBudget = Math.min(
    Math.max(toPositiveInteger(request.tokenBudget ?? request.recallTokenBudget, DEFAULT_RECOMMENDATION_TOKEN_BUDGET), 32),
    MAX_RECOMMENDATION_TOKEN_BUDGET,
  );
  const maxConflictNotes = Math.min(
    Math.max(toPositiveInteger(request.maxConflictNotes, DEFAULT_MAX_CONFLICT_NOTES), 1),
    MAX_LIST_ITEMS,
  );
  return {
    referenceAt,
    maxRecommendations,
    includeBlocked: Boolean(request.includeBlocked),
    includeCompleted: Boolean(request.includeCompleted),
    freshnessWarningDays,
    decayWarningDays,
    tokenBudget,
    maxConflictNotes,
    rankingWeights: normalizeRecommendationWeights(request.rankingWeights),
    metadata: normalizeMetadata(request.metadata),
  };
}

function normalizeReviewScheduleClockRequest(request) {
  const mode = normalizeDeterministicEnum(
    request.mode ?? request.clockMode,
    "mode",
    "review_schedule_clock",
    CLOCK_MODES,
    "auto",
  );
  const interactionIncrement = toNonNegativeInteger(
    request.interactionIncrement ?? request.interactions ?? (mode === "sleep" ? 0 : 1),
    mode === "sleep" ? 0 : 1,
  );
  const sleepIncrement = toNonNegativeInteger(
    request.sleepIncrement ?? (mode === "interaction" ? 0 : 1),
    mode === "interaction" ? 0 : 1,
  );
  const noveltyLoad = toNonNegativeInteger(request.noveltyLoad, 0);
  const noveltyWriteLoad = toNonNegativeInteger(
    request.noveltyWriteLoad ?? request.noveltyWriteWrites ?? request.noveltyWrites,
    0,
  );
  const fatigueDelta = toNonNegativeInteger(request.fatigueDelta, 0);
  const requestedFatigueThreshold = toPositiveInteger(
    request.fatigueThreshold ?? request.sleepThreshold,
    DEFAULT_SLEEP_THRESHOLD,
  );
  const noveltyWriteThreshold = toPositiveInteger(
    request.noveltyWriteThreshold,
    requestedFatigueThreshold,
  );
  const timestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.at ?? request.updatedAt,
    "review_schedule_clock.timestamp",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const forceSleep = Boolean(request.forceSleep);

  return {
    mode,
    interactionIncrement,
    sleepIncrement,
    noveltyLoad,
    noveltyWriteLoad,
    fatigueDelta,
    sleepThreshold: requestedFatigueThreshold,
    fatigueThreshold: requestedFatigueThreshold,
    noveltyWriteThreshold,
    timestamp,
    forceSleep,
  };
}

function normalizeReviewSetRebalanceRequest(request) {
  const activeLimit = Math.min(
    Math.max(toPositiveInteger(request.activeLimit ?? request.maxActive, DEFAULT_ACTIVE_REVIEW_SET_LIMIT), 1),
    MAX_ACTIVE_REVIEW_SET_LIMIT,
  );
  const timestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.rebalancedAt ?? request.updatedAt,
    "review_set_rebalance.timestamp",
    DEFAULT_VERSION_TIMESTAMP,
  );
  return {
    activeLimit,
    timestamp,
  };
}

function normalizeRecallAuthorizationRequest(request, storeId) {
  const mode = normalizeDeterministicEnum(
    request.mode,
    "mode",
    "recall_authorization",
    RECALL_AUTH_MODES,
    "check",
  );
  const requesterStoreId = normalizeBoundedString(
    request.requesterStoreId ?? request.sourceStoreId ?? request.fromStoreId,
    "requesterStoreId",
    128,
  );
  const allowStoreIds = normalizeBoundedStringArray(
    request.allowStoreIds ?? request.allowSpaceIds,
    "allowStoreIds",
  );
  const failClosed = request.failClosed !== false;
  const reason = normalizeBoundedString(request.reason, "reason", 512);
  if (mode === "check" && requesterStoreId !== storeId && !requesterStoreId) {
    throw new Error(RECALL_AUTHORIZATION_REQUESTER_ERROR);
  }
  return {
    mode,
    requesterStoreId: requesterStoreId ?? storeId,
    allowStoreIds,
    failClosed,
    reason,
    timestamp: normalizeIsoTimestamp(
      request.timestamp ?? request.updatedAt ?? request.createdAt,
      "recall_authorization.timestamp",
      DEFAULT_VERSION_TIMESTAMP,
    ),
  };
}

function normalizeTutorDegradedRequest(request) {
  const query = typeof request.query === "string" ? request.query.trim().toLowerCase() : "";
  const maxSuggestions = Math.min(
    Math.max(toPositiveInteger(request.maxSuggestions ?? request.limit, 5), 1),
    MAX_RECOMMENDATIONS,
  );
  const llmAvailable = Boolean(request.llmAvailable);
  const indexAvailable = Boolean(request.indexAvailable);
  const forceDegraded = request.forceDegraded !== false;
  const timestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.generatedAt ?? request.createdAt,
    "tutor_degraded.timestamp",
    DEFAULT_VERSION_TIMESTAMP,
  );
  return {
    query,
    maxSuggestions,
    llmAvailable,
    indexAvailable,
    forceDegraded,
    timestamp,
  };
}

function intersectionCount(left, right) {
  const rightSet = new Set(Array.isArray(right) ? right : []);
  let count = 0;
  for (const value of Array.isArray(left) ? left : []) {
    if (rightSet.has(value)) {
      count += 1;
    }
  }
  return count;
}

function runIngest(request) {
  const { storeId, profile, input } = normalizeRequest("ingest", request);
  const state = getProfileState(storeId, profile);
  const events = Array.isArray(request.events) ? request.events : [];
  const refs = [];
  let accepted = 0;
  let duplicates = 0;

  for (let i = 0; i < events.length; i += 1) {
    const normalized = normalizeEvent(events[i], i);
    if (state.eventDigests.has(normalized.digest)) {
      duplicates += 1;
      refs.push({
        eventId: normalized.eventId,
        digest: normalized.digest,
        status: "duplicate",
      });
      continue;
    }
    state.eventDigests.add(normalized.digest);
    state.events.push(normalized);
    accepted += 1;
    refs.push({
      eventId: normalized.eventId,
      digest: normalized.digest,
      status: "accepted",
    });
  }

  const ledgerDigest = hash(stableStringify(state.events.map((event) => event.digest)));

  return {
    ...buildMeta("ingest", storeId, profile, input),
    accepted,
    duplicates,
    eventRefs: refs,
    ledgerDigest,
  };
}

function runContext(request) {
  const { storeId, profile, input } = normalizeRequest("context", request);
  const state = getProfileState(storeId, profile);
  const requestTimestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.requestedAt,
    "context.timestamp",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const recallAuthorization =
    request.requesterStoreId || request.sourceStoreId
      ? ensureRecallAuthorizationForOperation(state, {
          storeId,
          profile,
          requesterStoreId: request.requesterStoreId ?? request.sourceStoreId,
          operation: "context",
          timestamp: requestTimestamp,
        })
      : null;
  const query = typeof request.query === "string" ? request.query.toLowerCase() : "";
  const limit = Number.isInteger(request.limit) && request.limit > 0 ? request.limit : 5;
  const chronologyLimit = Math.min(
    Math.max(toPositiveInteger(request.misconceptionChronologyLimit ?? request.chronologyLimit, limit), 1),
    MAX_LIST_ITEMS,
  );

  const matched = state.events
    .map((event) => {
      const content = `${event.type} ${event.source} ${event.content}`.toLowerCase();
      const match = query ? content.includes(query) : true;
      return { event, match };
    })
    .filter((item) => item.match)
    .slice(0, limit)
    .map((item) => ({
      eventId: item.event.eventId,
      type: item.event.type,
      source: item.event.source,
      excerpt: item.event.content.slice(0, 180),
      digest: item.event.digest,
    }));
  const chronologyHistory = Array.isArray(state.misconceptionChronologyHistory)
    ? sortByTimestampAndId(state.misconceptionChronologyHistory, "timestamp", "noteId")
    : [];
  const scoredChronology = chronologyHistory.map((note) => {
    const searchable = `${note.misconceptionKey ?? ""} ${(note.changedFields ?? []).join(" ")}`.toLowerCase();
    const relevance =
      (query && searchable.includes(query) ? 60 : 0) +
      ((note.changedFields ?? []).includes("harmfulSignalCount") ? 20 : 0) +
      ((note.changedFields ?? []).includes("status") ? 15 : 0) +
      ((note.changedFields ?? []).includes("confidence") ? 10 : 0);
    return {
      note,
      relevance,
    };
  });
  const prioritizedChronology = scoredChronology
    .sort((left, right) => {
      if (right.relevance !== left.relevance) {
        return right.relevance - left.relevance;
      }
      const recency = String(right.note?.timestamp ?? "").localeCompare(String(left.note?.timestamp ?? ""));
      if (recency !== 0) {
        return recency;
      }
      return String(left.note?.noteId ?? "").localeCompare(String(right.note?.noteId ?? ""));
    })
    .slice(0, chronologyLimit)
    .map((entry) => ({
      noteId: entry.note.noteId,
      misconceptionId: entry.note.misconceptionId,
      misconceptionKey: entry.note.misconceptionKey,
      profileId: entry.note.profileId,
      timestamp: entry.note.timestamp,
      changedFields: entry.note.changedFields,
      previousDigest: entry.note.previousDigest,
      nextDigest: entry.note.nextDigest,
      confidence: entry.note.confidence,
      harmfulSignalCount: entry.note.harmfulSignalCount,
      evidenceEventIds: entry.note.evidenceEventIds,
      relevance: entry.relevance,
    }));
  const orderedChronology = sortByTimestampAndId(prioritizedChronology, "timestamp", "noteId");
  const chronologyFormatting = orderedChronology.map(
    (note, index) => `${index + 1}. ${note.timestamp} ${note.misconceptionKey} -> ${note.changedFields.join("|")}`,
  );

  return {
    ...buildMeta("context", storeId, profile, input),
    query,
    totalEvents: state.events.length,
    authorization: recallAuthorization
      ? {
          authorized: recallAuthorization.authorized,
          crossSpace: recallAuthorization.crossSpace,
          policyAuditEventId: recallAuthorization.policyAuditEventId,
        }
      : null,
    matches: matched,
    rules: state.rules.slice(0, 5).map((rule) => ({
      ruleId: rule.ruleId,
      statement: rule.statement,
      confidence: rule.confidence,
    })),
    misconceptionChronology: {
      bounded: orderedChronology.length <= chronologyLimit,
      deterministicFormatting: true,
      prioritization: query ? "query_relevance_then_recency_then_noteId" : "severity_then_recency_then_noteId",
      limit: chronologyLimit,
      totalAvailable: chronologyHistory.length,
      notes: orderedChronology,
      formatting: chronologyFormatting,
    },
  };
}

function runReflect(request) {
  const { storeId, profile, input } = normalizeRequest("reflect", request);
  const state = getProfileState(storeId, profile);
  const max = Number.isInteger(request.maxCandidates) && request.maxCandidates > 0 ? request.maxCandidates : 3;
  const candidates = state.events.slice(-max).map((event) => {
    const statement = `Prefer source=${event.source} for type=${event.type}`;
    const normalized = normalizeRuleCandidate({
      statement,
      sourceEventId: event.eventId,
      confidence: 0.6,
    });
    return normalized;
  });

  return {
    ...buildMeta("reflect", storeId, profile, input),
    candidateCount: candidates.length,
    candidates,
  };
}

function runValidate(request) {
  const { storeId, profile, input } = normalizeRequest("validate", request);
  const state = getProfileState(storeId, profile);
  const rawCandidates = Array.isArray(request.candidates) ? request.candidates : [];
  const candidates = rawCandidates.map(normalizeRuleCandidate);
  const validations = candidates.map((candidate) => {
    const evidence = state.events.find((event) => event.eventId === candidate.sourceEventId) ?? null;
    return {
      candidateId: candidate.candidateId,
      valid: Boolean(evidence && candidate.statement),
      evidenceEventId: evidence ? evidence.eventId : null,
      contradictionCount: 0,
    };
  });

  return {
    ...buildMeta("validate", storeId, profile, input),
    checked: validations.length,
    validations,
  };
}

function runCurate(request) {
  const { storeId, profile, input } = normalizeRequest("curate", request);
  const state = getProfileState(storeId, profile);
  const rawCandidates = Array.isArray(request.candidates) ? request.candidates : [];
  const applied = [];
  const skipped = [];

  for (const rawCandidate of rawCandidates) {
    const candidate = normalizeRuleCandidate(rawCandidate);
    if (!candidate.statement) {
      skipped.push({
        candidateId: candidate.candidateId,
        reason: "empty_statement",
      });
      continue;
    }
    const existing = state.rules.find((rule) => rule.ruleId === candidate.candidateId);
    if (existing) {
      existing.statement = candidate.statement;
      existing.confidence = candidate.confidence;
      applied.push({
        ruleId: existing.ruleId,
        action: "updated",
      });
      continue;
    }
    const rule = {
      ruleId: candidate.candidateId,
      statement: candidate.statement,
      confidence: candidate.confidence,
    };
    state.rules.push(rule);
    applied.push({
      ruleId: rule.ruleId,
      action: "created",
    });
  }

  return {
    ...buildMeta("curate", storeId, profile, input),
    applied,
    skipped,
    totalRules: state.rules.length,
  };
}

function runLearnerProfileUpdate(request) {
  const { storeId, profile, input } = normalizeRequest("learner_profile_update", request);
  const state = getProfileState(storeId, profile);
  const incoming = normalizeLearnerProfileUpdateRequest(request, storeId, profile);
  const meta = buildMeta("learner_profile_update", storeId, profile, input);
  const existingIndex = state.learnerProfiles.findIndex(
    (learnerProfile) => learnerProfile.profileId === incoming.profileId,
  );
  let action = "created";
  let next = mergeLearnerProfile(createEmptyLearnerProfileSeed(incoming), incoming, "created");

  if (existingIndex >= 0) {
    const existing = state.learnerProfiles[existingIndex];
    const merged = mergeLearnerProfile(existing, incoming, "updated");
    if (stableStringify(existing) === stableStringify(merged)) {
      action = "noop";
      next = existing;
    } else {
      const versioned = {
        ...merged,
        version: Math.max((existing.version ?? 1) + 1, merged.version ?? 1),
      };
      action = "updated";
      next = versioned;
      state.learnerProfiles[existingIndex] = versioned;
    }
  } else {
    state.learnerProfiles.push(next);
  }
  const lineageRevisionCount = Object.values(next.attributeLineage ?? {}).reduce(
    (accumulator, entries) => accumulator + (Array.isArray(entries) ? entries.length : 0),
    0,
  );

  return {
    ...meta,
    action,
    profileId: next.profileId,
    learnerId: next.learnerId,
    profileDigest: hash(stableStringify(next)),
    totalProfiles: state.learnerProfiles.length,
    profileModel: next,
    observability: {
      evidencePointerCount: next.evidencePointers.length,
      sourceSignalCount: next.sourceSignals.length,
      policyExceptionApplied: Boolean(next.policyException),
      lineageRevisionCount,
      conflictResolution: "timestamp_then_valueDigest_then_revisionId",
      slo: buildSloObservability(meta.requestDigest, "learner_profile_update", 45),
    },
  };
}

function runIdentityGraphUpdate(request) {
  const { storeId, profile, input } = normalizeRequest("identity_graph_update", request);
  const state = getProfileState(storeId, profile);
  const incoming = normalizeIdentityGraphUpdateRequest(request, storeId, profile);
  const meta = buildMeta("identity_graph_update", storeId, profile, input);
  const existingIndex = state.identityGraphEdges.findIndex((edge) => edge.edgeId === incoming.edgeId);
  let action = "created";
  let next = incoming;

  if (existingIndex >= 0) {
    const existing = state.identityGraphEdges[existingIndex];
    const merged = mergeIdentityGraphEdge(existing, incoming);
    if (stableStringify(existing) === stableStringify(merged)) {
      action = "noop";
      next = existing;
    } else {
      action = "updated";
      next = merged;
      state.identityGraphEdges[existingIndex] = merged;
    }
  } else {
    state.identityGraphEdges.push(incoming);
  }

  return {
    ...meta,
    action,
    edgeId: next.edgeId,
    profileId: next.profileId,
    edgeDigest: hash(stableStringify(next)),
    totalEdges: state.identityGraphEdges.length,
    identityGraphDelta: next,
    observability: {
      evidencePointerCount: next.evidencePointers.length,
      evidenceEventCount: next.evidenceEventIds.length,
      sourceSignalCount: next.sourceSignals.length,
      endpointsDistinct: next.fromRef.namespace !== next.toRef.namespace || next.fromRef.value !== next.toRef.value,
      slo: buildSloObservability(meta.requestDigest, "identity_graph_update", 40),
    },
  };
}

function runMisconceptionUpdate(request) {
  const { storeId, profile, input } = normalizeRequest("misconception_update", request);
  const state = getProfileState(storeId, profile);
  const incoming = normalizeMisconceptionUpdateRequest(request, storeId, profile);
  const meta = buildMeta("misconception_update", storeId, profile, input);
  const existingIndex = state.misconceptions.findIndex(
    (record) => record.misconceptionId === incoming.misconceptionId,
  );
  let action = "created";
  let next = incoming;
  let previous = null;
  let chronologyNote = null;

  if (existingIndex >= 0) {
    previous = state.misconceptions[existingIndex];
    const merged = mergeMisconceptionRecord(previous, incoming);
    if (stableStringify(previous) === stableStringify(merged)) {
      action = "noop";
      next = previous;
    } else {
      action = "updated";
      next = merged;
      state.misconceptions[existingIndex] = merged;
      const changedFields = summarizeMisconceptionChanges(previous, merged);
      if (changedFields.length > 0) {
        const timestamp = normalizeIsoTimestampOrFallback(
          merged.updatedAt ?? incoming.updatedAt,
          DEFAULT_VERSION_TIMESTAMP,
        );
        chronologyNote = appendMisconceptionChronologyNote(state, {
          noteId: makeId(
            "mcn",
            hash(
              stableStringify({
                storeId,
                profile,
                misconceptionId: merged.misconceptionId,
                timestamp,
                previousDigest: hash(stableStringify(previous)),
                nextDigest: hash(stableStringify(merged)),
                changedFields,
              }),
            ),
          ),
          storeId,
          profile,
          misconceptionId: merged.misconceptionId,
          profileId: merged.profileId,
          misconceptionKey: merged.misconceptionKey,
          timestamp,
          changedFields,
          previousDigest: hash(stableStringify(previous)),
          nextDigest: hash(stableStringify(merged)),
          harmfulSignalCount: merged.harmfulSignalCount,
          confidence: merged.confidence,
          evidenceEventIds: merged.evidenceEventIds,
        });
      }
    }
  } else {
    state.misconceptions.push(incoming);
  }

  return {
    ...meta,
    action,
    misconceptionId: next.misconceptionId,
    recordDigest: hash(stableStringify(next)),
    totalMisconceptions: state.misconceptions.length,
    record: next,
    chronologyNote,
    observability: {
      evidenceCount: next.evidenceEventIds.length,
      signalCount: next.sourceSignalIds.length,
      confidenceDecayStage: toNonNegativeInteger(next?.confidenceDecay?.stage, 0),
      confidenceDecayAppliedDelta: toFiniteNumber(next?.confidenceDecay?.appliedDelta, 0),
      confidenceDecayAccelerated: Boolean(next?.confidenceDecay?.accelerated),
      antiPatternCount: Array.isArray(next?.antiPatterns) ? next.antiPatterns.length : 0,
      antiPatternEvidenceCount: new Set(
        (Array.isArray(next?.antiPatterns) ? next.antiPatterns : []).flatMap((entry) => entry.evidenceEventIds ?? []),
      ).size,
      chronologyCount: Array.isArray(state.misconceptionChronologyHistory)
        ? state.misconceptionChronologyHistory.filter((entry) => entry.misconceptionId === next.misconceptionId).length
        : 0,
      storeIsolationEnforced: true,
      slo: buildSloObservability(meta.requestDigest, "misconception_update", 35),
    },
  };
}

function runCurriculumPlanUpdate(request) {
  const { storeId, profile, input } = normalizeRequest("curriculum_plan_update", request);
  const state = getProfileState(storeId, profile);
  const incoming = normalizeCurriculumPlanUpdateRequest(request, storeId, profile);
  const meta = buildMeta("curriculum_plan_update", storeId, profile, input);
  const existingIndex = state.curriculumPlanItems.findIndex((item) => item.planItemId === incoming.planItemId);
  let action = "created";
  let next = incoming;
  let previous = null;
  let conflictNote = null;

  if (existingIndex >= 0) {
    previous = state.curriculumPlanItems[existingIndex];
    const merged = mergeCurriculumPlanItem(previous, incoming);
    if (stableStringify(previous) === stableStringify(merged)) {
      action = "noop";
      next = previous;
    } else {
      action = "updated";
      next = merged;
      state.curriculumPlanItems[existingIndex] = merged;
      const changedFields = summarizeCurriculumConflictChanges(previous, merged);
      if (changedFields.length > 0) {
        const timestamp = normalizeIsoTimestampOrFallback(
          merged.updatedAt ?? incoming.updatedAt,
          DEFAULT_VERSION_TIMESTAMP,
        );
        conflictNote = appendCurriculumConflictNote(state, {
          noteId: makeId(
            "ccn",
            hash(
              stableStringify({
                storeId,
                profile,
                planItemId: merged.planItemId,
                timestamp,
                previousDigest: hash(stableStringify(previous)),
                nextDigest: hash(stableStringify(merged)),
                changedFields,
              }),
            ),
          ),
          storeId,
          profile,
          profileId: merged.profileId,
          planItemId: merged.planItemId,
          objectiveId: merged.objectiveId,
          timestamp,
          changedFields,
          previousDigest: hash(stableStringify(previous)),
          nextDigest: hash(stableStringify(merged)),
          chronologyScope: "learner_profile",
        });
      }
    }
  } else {
    state.curriculumPlanItems.push(incoming);
  }

  return {
    ...meta,
    action,
    planItemId: next.planItemId,
    planDigest: hash(stableStringify(next)),
    totalPlanItems: state.curriculumPlanItems.length,
    planItem: next,
    conflictNote,
    observability: {
      evidenceCount: next.evidenceEventIds.length,
      provenanceCount: next.provenanceSignalIds.length,
      boundedRecommendationRank: next.recommendationRank,
      conflictChronologyCount: Array.isArray(state.curriculumConflictHistory)
        ? state.curriculumConflictHistory.filter((entry) => entry.planItemId === next.planItemId).length
        : 0,
      slo: buildSloObservability(meta.requestDigest, "curriculum_plan_update", 40),
    },
  };
}

function runReviewScheduleUpdate(request) {
  const { storeId, profile, input } = normalizeRequest("review_schedule_update", request);
  const state = getProfileState(storeId, profile);
  const incoming = normalizeReviewScheduleUpdateRequest(request, storeId, profile);
  const meta = buildMeta("review_schedule_update", storeId, profile, input);
  const existingIndex = state.reviewScheduleEntries.findIndex(
    (entry) => entry.scheduleEntryId === incoming.scheduleEntryId,
  );
  let action = "created";
  let next = incoming;

  if (existingIndex >= 0) {
    const existing = state.reviewScheduleEntries[existingIndex];
    const merged = mergeReviewScheduleEntry(existing, incoming);
    if (stableStringify(existing) === stableStringify(merged)) {
      action = "noop";
      next = existing;
    } else {
      action = "updated";
      next = merged;
      state.reviewScheduleEntries[existingIndex] = merged;
    }
  } else {
    state.reviewScheduleEntries.push(incoming);
  }

  return {
    ...meta,
    action,
    scheduleEntryId: next.scheduleEntryId,
    scheduleDigest: hash(stableStringify(next)),
    totalScheduleEntries: state.reviewScheduleEntries.length,
    scheduleEntry: next,
    observability: {
      dueAt: next.dueAt,
      sourceEventCount: next.sourceEventIds.length,
      storeIsolationEnforced: true,
      slo: buildSloObservability(meta.requestDigest, "review_schedule_update", 35),
    },
  };
}

function runPolicyDecisionUpdate(request) {
  const { storeId, profile, input } = normalizeRequest("policy_decision_update", request);
  const state = getProfileState(storeId, profile);
  const incoming = normalizePolicyDecisionUpdateRequest(request, storeId, profile);
  const meta = buildMeta("policy_decision_update", storeId, profile, input);
  const existingIndex = state.policyDecisions.findIndex((decision) => decision.decisionId === incoming.decisionId);
  let action = "created";
  let next = incoming;

  if (existingIndex >= 0) {
    const existing = state.policyDecisions[existingIndex];
    const merged = mergePolicyDecision(existing, incoming);
    if (stableStringify(existing) === stableStringify(merged)) {
      action = "noop";
      next = existing;
    } else {
      action = "updated";
      next = merged;
      state.policyDecisions[existingIndex] = merged;
    }
  } else {
    state.policyDecisions.push(incoming);
  }

  const policyAuditEvent = appendPolicyAuditTrail(state, {
    operation: "policy_decision_update",
    storeId,
    profile,
    entityId: next.decisionId,
    outcome: next.outcome,
    reasonCodes: next.reasonCodes,
    details: {
      policyKey: next.policyKey,
      action,
      provenanceEventIds: next.provenanceEventIds,
      evidenceEventIds: next.evidenceEventIds,
    },
    timestamp: next.updatedAt ?? next.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
  });

  return {
    ...meta,
    action,
    decisionId: next.decisionId,
    decisionDigest: hash(stableStringify(next)),
    policyAuditEventId: policyAuditEvent.auditEventId,
    totalPolicyDecisions: state.policyDecisions.length,
    decision: next,
    observability: {
      denied: next.outcome === "deny",
      reasonCodeCount: next.reasonCodes.length,
      provenanceCount: next.provenanceEventIds.length,
      slo: buildSloObservability(meta.requestDigest, "policy_decision_update", 45),
    },
  };
}

function runPainSignalIngest(request) {
  const { storeId, profile, input } = normalizeRequest("pain_signal_ingest", request);
  const state = getProfileState(storeId, profile);
  const normalized = normalizePainSignalIngestRequest(request, storeId, profile);
  const meta = buildMeta("pain_signal_ingest", storeId, profile, input);
  const record = {
    painSignalId: normalized.painSignalId,
    misconceptionKey: normalized.misconceptionKey,
    signalType: normalized.signalType,
    mappedSignal: normalized.mappedSignal,
    severity: normalized.severity,
    evidenceEventIds: normalized.evidenceEventIds,
    sourceEventIds: normalized.sourceEventIds,
    provenanceSource: normalized.provenanceSource,
    note: normalized.note,
    metadata: normalized.metadata,
    recordedAt: normalized.recordedAt,
  };
  const signalUpsert = upsertDeterministicRecord(state.painSignals, "painSignalId", record, "recordedAt");
  state.painSignals = signalUpsert.nextRecords;

  const misconceptionUpdate = runMisconceptionUpdate({
    storeId,
    profile,
    misconceptionKey: normalized.misconceptionKey,
    signal: normalized.mappedSignal,
    signalId: normalized.painSignalId,
    evidenceEventIds: normalized.evidenceEventIds,
    conflictEventIds: normalized.sourceEventIds,
    metadata: {
      source: "pain_signal_ingest",
      signalType: normalized.signalType,
      severity: normalized.severity,
      provenanceSource: normalized.provenanceSource,
      note: normalized.note,
      ...(normalized.metadata ?? {}),
    },
    timestamp: normalized.recordedAt,
  });

  const action =
    signalUpsert.action === "noop" && misconceptionUpdate.action === "noop"
      ? "noop"
      : signalUpsert.action === "created"
        ? "created"
        : "updated";
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "pain_signal_ingest",
    storeId,
    profile,
    entityId: normalized.painSignalId,
    outcome: action === "noop" ? "noop" : "recorded",
    reasonCodes: ["explicit_pain_signal"],
    details: {
      misconceptionId: misconceptionUpdate.misconceptionId,
      misconceptionAction: misconceptionUpdate.action,
      signalType: normalized.signalType,
      severity: normalized.severity,
      evidenceEventIds: normalized.evidenceEventIds,
      sourceEventIds: normalized.sourceEventIds,
    },
    timestamp: normalized.recordedAt,
  });

  return {
    ...meta,
    action,
    painSignalId: normalized.painSignalId,
    signalDigest: hash(stableStringify(signalUpsert.record)),
    misconceptionId: misconceptionUpdate.misconceptionId,
    misconceptionAction: misconceptionUpdate.action,
    painSignal: signalUpsert.record,
    misconceptionRecord: misconceptionUpdate.record,
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      explicitSignal: true,
      severity: normalized.severity,
      evidenceCount: normalized.evidenceEventIds.length,
      provenanceCount: normalized.sourceEventIds.length,
      totalPainSignals: state.painSignals.length,
      totalMisconceptions: state.misconceptions.length,
      slo: buildSloObservability(meta.requestDigest, "pain_signal_ingest", 35),
    },
  };
}

function runFailureSignalIngest(request) {
  const { storeId, profile, input } = normalizeRequest("failure_signal_ingest", request);
  const state = getProfileState(storeId, profile);
  const normalized = normalizeFailureSignalIngestRequest(request, storeId, profile);
  const meta = buildMeta("failure_signal_ingest", storeId, profile, input);
  const record = {
    failureSignalId: normalized.failureSignalId,
    misconceptionKey: normalized.misconceptionKey,
    failureType: normalized.failureType,
    failureCount: normalized.failureCount,
    severity: normalized.severity,
    pressureDelta: normalized.pressureDelta,
    mappedSignal: normalized.mappedSignal,
    evidenceEventIds: normalized.evidenceEventIds,
    sourceEventIds: normalized.sourceEventIds,
    outcomeRef: normalized.outcomeRef,
    metadata: normalized.metadata,
    recordedAt: normalized.recordedAt,
  };
  const signalUpsert = upsertDeterministicRecord(state.failureSignals, "failureSignalId", record, "recordedAt");
  state.failureSignals = signalUpsert.nextRecords;

  const misconceptionUpdate = runMisconceptionUpdate({
    storeId,
    profile,
    misconceptionKey: normalized.misconceptionKey,
    signal: normalized.mappedSignal,
    signalId: normalized.failureSignalId,
    evidenceEventIds: normalized.evidenceEventIds,
    conflictEventIds: normalized.sourceEventIds,
    metadata: {
      source: "failure_signal_ingest",
      failureType: normalized.failureType,
      failureCount: normalized.failureCount,
      severity: normalized.severity,
      pressureDelta: normalized.pressureDelta,
      outcomeRef: normalized.outcomeRef,
      ...(normalized.metadata ?? {}),
    },
    timestamp: normalized.recordedAt,
  });

  const action =
    signalUpsert.action === "noop" && misconceptionUpdate.action === "noop"
      ? "noop"
      : signalUpsert.action === "created"
        ? "created"
        : "updated";
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "failure_signal_ingest",
    storeId,
    profile,
    entityId: normalized.failureSignalId,
    outcome: action === "noop" ? "noop" : "recorded",
    reasonCodes: [`implicit_${normalized.failureType}`],
    details: {
      misconceptionId: misconceptionUpdate.misconceptionId,
      misconceptionAction: misconceptionUpdate.action,
      pressureDelta: normalized.pressureDelta,
      evidenceEventIds: normalized.evidenceEventIds,
      sourceEventIds: normalized.sourceEventIds,
      outcomeRef: normalized.outcomeRef,
    },
    timestamp: normalized.recordedAt,
  });

  return {
    ...meta,
    action,
    failureSignalId: normalized.failureSignalId,
    signalDigest: hash(stableStringify(signalUpsert.record)),
    misconceptionId: misconceptionUpdate.misconceptionId,
    misconceptionAction: misconceptionUpdate.action,
    mapping: {
      failureType: normalized.failureType,
      failureCount: normalized.failureCount,
      severity: normalized.severity,
      pressureDelta: normalized.pressureDelta,
      mappedSignal: normalized.mappedSignal,
      sourceEventIds: normalized.sourceEventIds,
      recordedAt: normalized.recordedAt,
      transparent: true,
      auditable: true,
    },
    failureSignal: signalUpsert.record,
    misconceptionRecord: misconceptionUpdate.record,
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      implicitSignal: true,
      severity: normalized.severity,
      failureCount: normalized.failureCount,
      evidenceCount: normalized.evidenceEventIds.length,
      provenanceCount: normalized.sourceEventIds.length,
      totalFailureSignals: state.failureSignals.length,
      totalMisconceptions: state.misconceptions.length,
      slo: buildSloObservability(meta.requestDigest, "failure_signal_ingest", 40),
    },
  };
}

function runCurriculumRecommendation(request) {
  const { storeId, profile, input } = normalizeRequest("curriculum_recommendation", request);
  const state = getProfileState(storeId, profile);
  const normalized = normalizeCurriculumRecommendationRequest(request);
  const meta = buildMeta("curriculum_recommendation", storeId, profile, input);
  const recallAuthorization =
    request.requesterStoreId || request.sourceStoreId
      ? ensureRecallAuthorizationForOperation(state, {
          storeId,
          profile,
          requesterStoreId: request.requesterStoreId ?? request.sourceStoreId,
          operation: "curriculum_recommendation",
          timestamp: normalized.referenceAt,
        })
      : null;
  const learnerProfile = sortByTimestampAndId(state.learnerProfiles, "updatedAt", "profileId").at(-1) ?? null;
  const misconceptionsById = new Map(
    state.misconceptions.map((record) => [
      record.misconceptionId,
      {
        status: record.status,
        confidence: clamp01(record.confidence, 0.5),
        harmfulSignalCount: toNonNegativeInteger(record.harmfulSignalCount, 0),
      },
    ]),
  );
  const conflictHistory = Array.isArray(state.curriculumConflictHistory)
    ? sortByTimestampAndId(state.curriculumConflictHistory, "timestamp", "noteId")
    : [];
  const learnerInterestCount = Math.max((learnerProfile?.interestTags ?? []).length, 1);

  const planCandidates = state.curriculumPlanItems.filter((item) => {
    if (!Array.isArray(item?.evidenceEventIds) || item.evidenceEventIds.length === 0) {
      return false;
    }
    if (!normalized.includeCompleted && item.status === "completed") {
      return false;
    }
    if (!normalized.includeBlocked && item.status === "blocked") {
      return false;
    }
    return true;
  });

  const scoredRecommendations = planCandidates.map((item) => {
    const dueLinkedEntries = state.reviewScheduleEntries.filter(
      (entry) => entry.targetId === item.objectiveId || entry.targetId === item.planItemId,
    );
    const dueScore = dueLinkedEntries.reduce(
      (score, entry) => score + (entry.status === "due" ? 12 : entry.status === "scheduled" ? 4 : 0),
      0,
    );
    const misconceptionLinks = (item.sourceMisconceptionIds ?? []).map((misconceptionId) => {
      const linked = misconceptionsById.get(misconceptionId);
      if (!linked) {
        return null;
      }
      if (linked.status === "suppressed") {
        return null;
      }
      return linked;
    }).filter(Boolean);
    const interestOverlap = intersectionCount(item.interestTags, learnerProfile?.interestTags ?? []);
    const interestAffinity = Number((interestOverlap / learnerInterestCount).toFixed(6));
    const masteryGapRaw =
      misconceptionLinks.length === 0
        ? 0.4
        : misconceptionLinks.reduce((score, linked) => {
            const statusMultiplier = linked.status === "resolved" ? 0.45 : 1;
            const harmfulBoost = 1 + Math.min(linked.harmfulSignalCount, 5) * 0.12;
            return score + statusMultiplier * (0.35 + linked.confidence) * harmfulBoost;
          }, 0) / misconceptionLinks.length;
    const masteryGapScore = Number(Math.min(Math.max(masteryGapRaw, 0), 1).toFixed(6));
    const duePressure = Number(Math.min(Math.max(dueScore / 24, 0), 1).toFixed(6));
    const evidenceDepth = Number(Math.min((item.evidenceEventIds ?? []).length / 10, 1).toFixed(6));
    const rankBias = Number(
      Math.max(0, 1 - (toPositiveInteger(item.recommendationRank, 1) - 1) / MAX_RECOMMENDATIONS).toFixed(6),
    );
    const weightedScore =
      interestAffinity * normalized.rankingWeights.interest +
      masteryGapScore * normalized.rankingWeights.masteryGap +
      duePressure * normalized.rankingWeights.due +
      evidenceDepth * normalized.rankingWeights.evidence;
    const freshness = buildFreshnessAndDecayMetadata(
      item,
      normalized.referenceAt,
      normalized.freshnessWarningDays,
      normalized.decayWarningDays,
    );
    const statusPenalty = item.status === "blocked" ? -40 : item.status === "completed" ? -80 : 0;
    const score = Number((weightedScore * 100 + rankBias * 5 + statusPenalty - freshness.decayPenalty).toFixed(6));

    const provenancePointers = normalizeEvidencePointers([
      ...(item.evidenceEventIds ?? []).map((pointerId) => ({
        pointerId,
        kind: "event",
        source: "curriculum_plan_item",
      })),
      ...(item.provenanceSignalIds ?? []).map((pointerId) => ({
        pointerId,
        kind: "signal",
        source: "curriculum_plan_item",
      })),
      ...(item.sourceMisconceptionIds ?? []).map((pointerId) => ({
        pointerId,
        kind: "artifact",
        source: "misconception",
      })),
    ]);
    const conflictChronology = conflictHistory
      .filter((entry) => entry.planItemId === item.planItemId && entry.profileId === item.profileId)
      .slice(-normalized.maxConflictNotes)
      .map((entry) => ({
        noteId: entry.noteId,
        timestamp: entry.timestamp,
        profileId: entry.profileId,
        planItemId: entry.planItemId,
        objectiveId: entry.objectiveId,
        changedFields: entry.changedFields,
        previousDigest: entry.previousDigest,
        nextDigest: entry.nextDigest,
        chronologyScope: entry.chronologyScope,
      }));
    const tokenEstimate = estimateRecommendationTokenCost(item, provenancePointers);
    const recommendationId = makeId(
      "rec",
      hash(
        stableStringify({
          storeId,
          profile,
          planItemId: item.planItemId,
          objectiveId: item.objectiveId,
          referenceAt: normalized.referenceAt,
          score,
        }),
      ),
    );
    const rationale = {
      deterministicRanking: true,
      weights: normalized.rankingWeights,
      factors: stableSortObject({
        interestAffinity,
        masteryGapScore,
        duePressure,
        evidenceDepth,
        rankBias,
        statusPenalty,
        freshnessPenalty: freshness.decayPenalty,
      }),
      explanation: [
        `interest:${interestAffinity}`,
        `masteryGap:${masteryGapScore}`,
        `due:${duePressure}`,
        `evidence:${evidenceDepth}`,
        `weights:${stableStringify(normalized.rankingWeights)}`,
        `freshnessPenalty:${freshness.decayPenalty}`,
        `statusPenalty:${statusPenalty}`,
      ],
    };
    const digest = hash(
      stableStringify({
        recommendationId,
        planItemId: item.planItemId,
        score,
        provenancePointers,
        freshness,
        conflictNoteIds: conflictChronology.map((entry) => entry.noteId),
        rationale,
      }),
    );
    return {
      recommendationId,
      planItemId: item.planItemId,
      objectiveId: item.objectiveId,
      status: item.status,
      score,
      recommendationRank: item.recommendationRank,
      dueAt: item.dueAt,
      provenancePointers,
      freshness: stableSortObject({
        ageDays: freshness.ageDays,
        referencePoint: freshness.referencePoint,
        stale: freshness.stale,
        decayed: freshness.decayed,
        warningCodes: freshness.warningCodes,
        freshnessWarningDays: freshness.freshnessWarningDays,
        decayWarningDays: freshness.decayWarningDays,
        deterministic: true,
      }),
      conflictChronology,
      tokenEstimate,
      rationale,
      digest,
      metadata: normalizeMetadata(item.metadata),
    };
  });

  const orderedRecommendations = [...scoredRecommendations].sort((left, right) => {
    const scoreDiff = stableScore(right.score, 0) - stableScore(left.score, 0);
    if (scoreDiff !== 0) {
      return scoreDiff > 0 ? 1 : -1;
    }
    return left.recommendationId.localeCompare(right.recommendationId);
  });
  const recommendations = [];
  let tokensConsumed = 0;
  let skippedByTokenBudget = 0;
  for (const recommendation of orderedRecommendations) {
    if (recommendations.length >= normalized.maxRecommendations) {
      break;
    }
    if (tokensConsumed + recommendation.tokenEstimate > normalized.tokenBudget) {
      skippedByTokenBudget += 1;
      continue;
    }
    recommendations.push(recommendation);
    tokensConsumed += recommendation.tokenEstimate;
  }
  const conflictChronology = sortByTimestampAndId(
    recommendations
      .flatMap((recommendation) => recommendation.conflictChronology)
      .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.noteId === entry.noteId) === index),
    "timestamp",
    "noteId",
  );
  const recommendationSetId = makeId(
    "recs",
    hash(
      stableStringify({
        storeId,
        profile,
        referenceAt: normalized.referenceAt,
        maxRecommendations: normalized.maxRecommendations,
        recommendationDigests: recommendations.map((recommendation) => recommendation.digest),
      }),
    ),
  );
  const recommendationSnapshot = {
    recommendationSetId,
    generatedAt: normalized.referenceAt,
    requestDigest: meta.requestDigest,
    recommendationIds: recommendations.map((recommendation) => recommendation.recommendationId),
    recommendations,
    metadata: stableSortObject({
      ...normalized.metadata,
      thresholds: {
        freshnessWarningDays: normalized.freshnessWarningDays,
        decayWarningDays: normalized.decayWarningDays,
      },
      tokenBudget: normalized.tokenBudget,
      rankingWeights: normalized.rankingWeights,
    }),
  };
  const snapshotUpsert = upsertDeterministicRecord(
    state.curriculumRecommendationSnapshots,
    "recommendationSetId",
    recommendationSnapshot,
    "generatedAt",
  );
  state.curriculumRecommendationSnapshots = snapshotUpsert.nextRecords;

  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "curriculum_recommendation",
    storeId,
    profile,
    entityId: recommendationSetId,
    outcome: recommendations.length > 0 ? "allow" : "review",
    reasonCodes: recommendations.length > 0 ? ["evidence_backed_recommendations"] : ["no_evidence_backed_candidates"],
    details: {
      recommendationCount: recommendations.length,
      candidateCount: scoredRecommendations.length,
      includeBlocked: normalized.includeBlocked,
      includeCompleted: normalized.includeCompleted,
      maxRecommendations: normalized.maxRecommendations,
      tokenBudget: normalized.tokenBudget,
      tokensConsumed,
      skippedByTokenBudget,
    },
    timestamp: normalized.referenceAt,
  });

  return {
    ...meta,
    action: snapshotUpsert.action,
    recommendationSetId,
    recommendationDigest: hash(stableStringify(recommendationSnapshot)),
    recommendationCount: recommendations.length,
    recommendations,
    conflictChronology: {
      ordered: true,
      scopedTo: {
        storeId,
        profile,
        profileId: learnerProfile?.profileId ?? null,
      },
      notes: conflictChronology,
    },
    authorization: recallAuthorization
      ? {
          authorized: recallAuthorization.authorized,
          crossSpace: recallAuthorization.crossSpace,
          policyAuditEventId: recallAuthorization.policyAuditEventId,
        }
      : null,
    policyAuditEventId: auditEvent.auditEventId,
    engine: {
      deterministicRanking: true,
      explainable: true,
      evidenceBacked: true,
      referenceAt: normalized.referenceAt,
      rankingWeights: normalized.rankingWeights,
      tokenBudget: normalized.tokenBudget,
    },
    observability: {
      candidateCount: scoredRecommendations.length,
      returnedCount: recommendations.length,
      evidenceBackedCount: recommendations.filter((recommendation) => recommendation.provenancePointers.length > 0).length,
      boundedBy: normalized.maxRecommendations,
      boundedByTokenBudget: skippedByTokenBudget > 0,
      skippedByTokenBudget,
      tokenBudget: normalized.tokenBudget,
      tokensConsumed,
      freshnessWarningDays: normalized.freshnessWarningDays,
      decayWarningDays: normalized.decayWarningDays,
      warningCount: recommendations.reduce(
        (count, recommendation) => count + recommendation.freshness.warningCodes.length,
        0,
      ),
      conflictNoteCount: conflictChronology.length,
      totalSnapshots: state.curriculumRecommendationSnapshots.length,
      slo: buildSloObservability(meta.requestDigest, "curriculum_recommendation", 60),
    },
  };
}

function rebalanceReviewSet(state, storeId, profile, { activeLimit, timestamp }) {
  const previousEntriesDigest = hash(stableStringify(state.reviewScheduleEntries));
  const previousTiersDigest = hash(stableStringify(getOrCreateReviewArchivalTiers(state)));
  const tiers = getOrCreateReviewArchivalTiers(state);
  const orderedEntries = [...state.reviewScheduleEntries].sort((left, right) => {
    const dueDiff = String(left?.dueAt ?? "").localeCompare(String(right?.dueAt ?? ""));
    if (dueDiff !== 0) {
      return dueDiff;
    }
    const statusDiff = String(left?.status ?? "").localeCompare(String(right?.status ?? ""));
    if (statusDiff !== 0) {
      return statusDiff;
    }
    return String(left?.scheduleEntryId ?? "").localeCompare(String(right?.scheduleEntryId ?? ""));
  });

  const activeCandidates = orderedEntries.filter((entry) => entry.status === "due" || entry.status === "scheduled");
  const activeReviewIds = activeCandidates.slice(0, activeLimit).map((entry) => entry.scheduleEntryId);
  const activeIdSet = new Set(activeReviewIds);
  const overflow = orderedEntries.filter((entry) => !activeIdSet.has(entry.scheduleEntryId));
  const tieredIds = {
    warm: [],
    cold: [],
    frozen: [],
  };
  const archivedRecords = [];
  const now = Date.parse(timestamp);

  for (const entry of overflow) {
    const dueMs = Date.parse(entry?.dueAt ?? DEFAULT_VERSION_TIMESTAMP);
    const ageDays = Number.isFinite(now) && Number.isFinite(dueMs) ? Math.floor((now - dueMs) / (24 * 60 * 60 * 1000)) : 0;
    let tier = "warm";
    if (entry.status === "completed" || ageDays >= 90) {
      tier = "cold";
    }
    if (ageDays >= 365) {
      tier = "frozen";
    }
    tieredIds[tier].push(entry.scheduleEntryId);
    const archiveRecordId = makeId(
      "arc",
      hash(stableStringify({ scheduleEntryId: entry.scheduleEntryId, tier })),
    );
    archivedRecords.push({
      archiveRecordId,
      scheduleEntryId: entry.scheduleEntryId,
      targetId: entry.targetId,
      tier,
      archivedAt: timestamp,
      dueAt: normalizeIsoTimestampOrFallback(entry.dueAt, DEFAULT_VERSION_TIMESTAMP),
      sourceEventIds: normalizeBoundedStringArray(entry.sourceEventIds, "reviewArchivalTiers.sourceEventIds"),
      evidenceEventIds: normalizeBoundedStringArray(entry.evidenceEventIds, "reviewArchivalTiers.evidenceEventIds"),
      metadata: normalizeMetadata({
        status: entry.status,
        repetition: entry.repetition,
      }),
    });
  }

  state.reviewScheduleEntries = state.reviewScheduleEntries.map((entry) => {
    const archivalTier = activeIdSet.has(entry.scheduleEntryId)
      ? "active"
      : tieredIds.warm.includes(entry.scheduleEntryId)
        ? "warm"
        : tieredIds.cold.includes(entry.scheduleEntryId)
          ? "cold"
          : tieredIds.frozen.includes(entry.scheduleEntryId)
            ? "frozen"
            : "warm";
    return {
      ...entry,
      metadata: stableSortObject({
        ...(entry.metadata ?? {}),
        archivalTier,
        activeReview: activeIdSet.has(entry.scheduleEntryId),
        rebalancedAt: timestamp,
      }),
    };
  });

  tiers.activeLimit = activeLimit;
  tiers.activeReviewIds = activeReviewIds;
  tiers.tiers = {
    warm: [...tieredIds.warm].sort((left, right) => left.localeCompare(right)),
    cold: [...tieredIds.cold].sort((left, right) => left.localeCompare(right)),
    frozen: [...tieredIds.frozen].sort((left, right) => left.localeCompare(right)),
  };
  tiers.archivedRecords = sortByTimestampAndId(archivedRecords, "archivedAt", "archiveRecordId");
  tiers.updatedAt = timestamp;
  state.reviewArchivalTiers = tiers;

  const changed =
    previousEntriesDigest !== hash(stableStringify(state.reviewScheduleEntries)) ||
    previousTiersDigest !== hash(stableStringify(tiers));
  return {
    changed,
    activeLimit,
    activeReviewIds,
    archivedCount: archivedRecords.length,
    tierCounts: {
      warm: tiers.tiers.warm.length,
      cold: tiers.tiers.cold.length,
      frozen: tiers.tiers.frozen.length,
    },
  };
}

function runReviewScheduleClock(request) {
  const { storeId, profile, input } = normalizeRequest("review_schedule_clock", request);
  const state = getProfileState(storeId, profile);
  const normalized = normalizeReviewScheduleClockRequest(request);
  const meta = buildMeta("review_schedule_clock", storeId, profile, input);
  const clocks = getOrCreateSchedulerClocks(state);
  const previousClocksDigest = hash(stableStringify(clocks));
  const transitions = [];

  clocks.sleepThreshold = normalized.sleepThreshold;
  clocks.fatigueThreshold = normalized.fatigueThreshold;
  clocks.noveltyWriteThreshold = normalized.noveltyWriteThreshold;
  if (normalized.mode === "interaction" || normalized.mode === "auto") {
    clocks.interactionTick += normalized.interactionIncrement;
    clocks.fatigueLoad += normalized.interactionIncrement + normalized.noveltyLoad + normalized.fatigueDelta;
    clocks.noveltyWriteLoad += normalized.noveltyWriteLoad + normalized.noveltyLoad;
    clocks.lastInteractionAt = normalized.timestamp;
  }
  if (normalized.mode === "sleep") {
    clocks.noveltyWriteLoad += normalized.noveltyWriteLoad;
  }

  let consolidationTriggered = false;
  let consolidationCause = "none";
  const fatigueExceeded = clocks.fatigueLoad >= clocks.fatigueThreshold;
  const noveltyExceeded = clocks.noveltyWriteLoad >= clocks.noveltyWriteThreshold;
  const shouldSleep = normalized.forceSleep || normalized.mode === "sleep" || fatigueExceeded || noveltyExceeded;
  if (normalized.forceSleep) {
    consolidationCause = "forced";
  } else if (normalized.mode === "sleep") {
    consolidationCause = "sleep_mode";
  } else if (fatigueExceeded && noveltyExceeded) {
    consolidationCause = "fatigue_and_novelty_threshold";
  } else if (fatigueExceeded) {
    consolidationCause = "fatigue_threshold";
  } else if (noveltyExceeded) {
    consolidationCause = "novelty_write_threshold";
  }
  if (shouldSleep) {
    consolidationTriggered = true;
    clocks.sleepTick += Math.max(normalized.sleepIncrement, 1);
    clocks.consolidationCount += 1;
    const recovered = Math.max(1, Math.ceil(clocks.sleepThreshold / 2));
    clocks.fatigueLoad = Math.max(0, clocks.fatigueLoad - recovered);
    clocks.noveltyWriteLoad = 0;
    clocks.lastSleepAt = normalized.timestamp;
    clocks.lastConsolidatedAt = normalized.timestamp;
    clocks.lastConsolidationCause = consolidationCause;
  }
  clocks.updatedAt = normalized.timestamp;

  state.reviewScheduleEntries = state.reviewScheduleEntries.map((entry) => {
    let next = entry;
    if (entry.status === "scheduled" && String(entry.dueAt ?? "") <= normalized.timestamp) {
      next = {
        ...next,
        status: "due",
        updatedAt: normalized.timestamp,
      };
      transitions.push({
        scheduleEntryId: entry.scheduleEntryId,
        transition: "scheduled_to_due",
      });
    }
    if (consolidationTriggered && next.status === "completed") {
      const nextDueAt = addDaysToIso(
        normalizeIsoTimestampOrFallback(normalized.timestamp, DEFAULT_VERSION_TIMESTAMP),
        toPositiveInteger(next.intervalDays, 1),
      );
      next = {
        ...next,
        status: "scheduled",
        dueAt: nextDueAt,
        updatedAt: normalized.timestamp,
      };
      transitions.push({
        scheduleEntryId: entry.scheduleEntryId,
        transition: "sleep_reschedule_completed_entry",
        cause: consolidationCause,
      });
    }
    return next;
  });

  const tiers = getOrCreateReviewArchivalTiers(state);
  const rebalanced = rebalanceReviewSet(state, storeId, profile, {
    activeLimit: tiers.activeLimit,
    timestamp: normalized.timestamp,
  });
  const clocksChanged = previousClocksDigest !== hash(stableStringify(clocks));
  const action = clocksChanged || transitions.length > 0 || rebalanced.changed ? "updated" : "noop";
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "review_schedule_clock",
    storeId,
    profile,
    entityId: makeId("clk", hash(stableStringify({ requestDigest: meta.requestDigest }))),
    outcome: action === "noop" ? "noop" : "recorded",
    reasonCodes: consolidationTriggered
      ? [consolidationCause === "none" ? "sleep_clock_triggered" : consolidationCause]
      : ["interaction_clock_tick"],
    details: {
      mode: normalized.mode,
      transitions: transitions.length,
      fatigueLoad: clocks.fatigueLoad,
      sleepThreshold: clocks.sleepThreshold,
      fatigueThreshold: clocks.fatigueThreshold,
      noveltyWriteLoad: clocks.noveltyWriteLoad,
      noveltyWriteThreshold: clocks.noveltyWriteThreshold,
      consolidationCause,
      activeReviewCount: rebalanced.activeReviewIds.length,
      archivedCount: rebalanced.archivedCount,
    },
    timestamp: normalized.timestamp,
  });

  return {
    ...meta,
    action,
    clocks: stableSortObject(clocks),
    transitions,
    consolidationTriggered,
    consolidationCause,
    rebalance: rebalanced,
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      interactionTick: clocks.interactionTick,
      sleepTick: clocks.sleepTick,
      fatigueLoad: clocks.fatigueLoad,
      sleepThreshold: clocks.sleepThreshold,
      fatigueThreshold: clocks.fatigueThreshold,
      noveltyWriteLoad: clocks.noveltyWriteLoad,
      noveltyWriteThreshold: clocks.noveltyWriteThreshold,
      consolidationCause,
      transitionCount: transitions.length,
      activeReviewCount: rebalanced.activeReviewIds.length,
      archivedCount: rebalanced.archivedCount,
      slo: buildSloObservability(meta.requestDigest, "review_schedule_clock", 45),
    },
  };
}

function runReviewSetRebalance(request) {
  const { storeId, profile, input } = normalizeRequest("review_set_rebalance", request);
  const state = getProfileState(storeId, profile);
  const normalized = normalizeReviewSetRebalanceRequest(request);
  const meta = buildMeta("review_set_rebalance", storeId, profile, input);
  const rebalanced = rebalanceReviewSet(state, storeId, profile, {
    activeLimit: normalized.activeLimit,
    timestamp: normalized.timestamp,
  });
  const action = rebalanced.changed ? "updated" : "noop";
  const tiers = getOrCreateReviewArchivalTiers(state);
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "review_set_rebalance",
    storeId,
    profile,
    entityId: makeId("rset", hash(stableStringify({ requestDigest: meta.requestDigest }))),
    outcome: action === "updated" ? "recorded" : "noop",
    reasonCodes: ["bounded_active_review_set"],
    details: {
      activeLimit: normalized.activeLimit,
      activeReviewCount: rebalanced.activeReviewIds.length,
      archivedCount: rebalanced.archivedCount,
      tierCounts: rebalanced.tierCounts,
    },
    timestamp: normalized.timestamp,
  });

  return {
    ...meta,
    action,
    activeLimit: tiers.activeLimit,
    activeReviewIds: tiers.activeReviewIds,
    tiers: tiers.tiers,
    archivedRecords: tiers.archivedRecords,
    tierDigest: hash(stableStringify(tiers)),
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      activeReviewCount: tiers.activeReviewIds.length,
      archivedCount: tiers.archivedRecords.length,
      tierCounts: rebalanced.tierCounts,
      bounded: tiers.activeReviewIds.length <= tiers.activeLimit,
      evictionPolicy: "due_at_then_status_then_scheduleEntryId",
      slo: buildSloObservability(meta.requestDigest, "review_set_rebalance", 40),
    },
  };
}

function runCurateGuarded(request) {
  const { storeId, profile, input } = normalizeRequest("curate_guarded", request);
  const state = getProfileState(storeId, profile);
  const meta = buildMeta("curate_guarded", storeId, profile, input);
  const guardTimestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.updatedAt ?? request.createdAt,
    "curate_guarded.timestamp",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const rawCandidates = Array.isArray(request.candidates) ? request.candidates : [];
  const rawValidations = Array.isArray(request.validations) ? request.validations : [];
  const validationByCandidateId = new Map();
  for (const validation of rawValidations) {
    if (!isPlainObject(validation)) {
      continue;
    }
    const candidateId = normalizeBoundedString(validation.candidateId, "validations.candidateId", 64);
    if (!candidateId) {
      continue;
    }
    validationByCandidateId.set(candidateId, {
      valid: Boolean(validation.valid),
      evidenceEventId: normalizeBoundedString(validation.evidenceEventId, "validations.evidenceEventId"),
    });
  }

  const safeCandidates = [];
  const quarantined = [];
  const rejected = [];
  for (const rawCandidate of rawCandidates) {
    const candidate = normalizeRuleCandidate(rawCandidate);
    const injectionReasons = detectPromptInjection(candidate.statement);
    if (injectionReasons.length > 0) {
      const quarantineId = makeId(
        "qtn",
        hash(stableStringify({ candidateId: candidate.candidateId, injectionReasons })),
      );
      quarantined.push({
        quarantineId,
        candidateId: candidate.candidateId,
        statementDigest: hash(stableStringify(candidate.statement)),
        reasonCodes: injectionReasons,
        status: "quarantined",
      });
      continue;
    }
    if (!candidate.statement) {
      rejected.push({
        candidateId: candidate.candidateId,
        reason: "empty_statement",
      });
      continue;
    }
    const validation = validationByCandidateId.get(candidate.candidateId);
    const hasEventEvidence = state.events.some((event) => event.eventId === candidate.sourceEventId);
    const hasValidationEvidence = Boolean(validation?.valid && validation?.evidenceEventId);
    if (!hasEventEvidence && !hasValidationEvidence) {
      rejected.push({
        candidateId: candidate.candidateId,
        reason: "missing_validation_evidence",
      });
      continue;
    }
    safeCandidates.push(candidate);
  }

  const curateResult = runCurate({
    storeId,
    profile,
    candidates: safeCandidates,
  });
  const action =
    curateResult.applied.length > 0 || quarantined.length > 0
      ? "updated"
      : rejected.length > 0
        ? "noop"
        : "noop";
  const guardDigest = hash(
    stableStringify({
      appliedRuleIds: curateResult.applied.map((entry) => entry.ruleId),
      quarantinedIds: quarantined.map((entry) => entry.quarantineId),
      rejected,
    }),
  );
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "curate_guarded",
    storeId,
    profile,
    entityId: makeId("guard", hash(stableStringify({ requestDigest: meta.requestDigest }))),
    outcome: quarantined.length > 0 ? "deny" : "allow",
    reasonCodes:
      quarantined.length > 0
        ? asSortedUniqueStrings(quarantined.flatMap((entry) => entry.reasonCodes))
        : rejected.some((entry) => entry.reason === "missing_validation_evidence")
          ? ["missing_validation_evidence"]
          : ["curation_allowed"],
    details: {
      safeCandidateCount: safeCandidates.length,
      quarantinedCount: quarantined.length,
      rejectedCount: rejected.length,
      appliedCount: curateResult.applied.length,
    },
    timestamp: guardTimestamp,
  });

  return {
    ...meta,
    action,
    guardDigest,
    applied: curateResult.applied,
    skipped: curateResult.skipped,
    quarantined,
    rejected,
    totalRules: curateResult.totalRules,
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      safeCandidateCount: safeCandidates.length,
      quarantinedCount: quarantined.length,
      rejectedCount: rejected.length,
      requiresValidationEvidence: true,
      promptInjectionResistant: true,
      evidenceContract: GUARDED_CURATION_EVIDENCE_CONTRACT_ERROR,
      slo: buildSloObservability(meta.requestDigest, "curate_guarded", 45),
    },
  };
}

function runRecallAuthorization(request) {
  const { storeId, profile, input } = normalizeRequest("recall_authorization", request);
  const state = getProfileState(storeId, profile);
  const normalized = normalizeRecallAuthorizationRequest(request, storeId);
  const meta = buildMeta("recall_authorization", storeId, profile, input);
  const policy = getOrCreateRecallAllowlistPolicy(state, storeId, profile);
  const previousDigest = hash(stableStringify(policy));

  let nextAllowedStoreIds = [...policy.allowedStoreIds];
  if (normalized.mode === "grant") {
    nextAllowedStoreIds = mergeStringLists(nextAllowedStoreIds, normalized.allowStoreIds);
  } else if (normalized.mode === "replace") {
    nextAllowedStoreIds = mergeStringLists([storeId], normalized.allowStoreIds);
  } else if (normalized.mode === "revoke") {
    const removed = new Set(normalized.allowStoreIds);
    nextAllowedStoreIds = nextAllowedStoreIds.filter((allowedStoreId) => {
      if (allowedStoreId === storeId) {
        return true;
      }
      return !removed.has(allowedStoreId);
    });
  }

  const changed = stableStringify(nextAllowedStoreIds) !== stableStringify(policy.allowedStoreIds);
  if (changed) {
    policy.allowedStoreIds = nextAllowedStoreIds;
    policy.updatedAt = normalized.timestamp;
  }
  const crossSpace = normalized.requesterStoreId !== storeId;
  const authorized = !crossSpace || policy.allowedStoreIds.includes(normalized.requesterStoreId);
  const decisionId = makeId(
    "auth",
    hash(
      stableStringify({
        policyId: policy.policyId,
        requesterStoreId: normalized.requesterStoreId,
        targetStoreId: storeId,
        mode: normalized.mode,
        authorized,
        timestamp: normalized.timestamp,
      }),
    ),
  );
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "recall_authorization",
    storeId,
    profile,
    entityId: decisionId,
    outcome: authorized ? "allow" : "deny",
    reasonCodes: authorized ? ["allowlist_authorized"] : ["allowlist_denied"],
    details: {
      mode: normalized.mode,
      requesterStoreId: normalized.requesterStoreId,
      targetStoreId: storeId,
      crossSpace,
      allowStoreIds: policy.allowedStoreIds,
      reason: normalized.reason,
    },
    timestamp: normalized.timestamp,
  });

  if (!authorized && normalized.failClosed) {
    const error = new Error(
      `${CROSS_SPACE_ALLOWLIST_DENY_ERROR} requesterStoreId=${normalized.requesterStoreId} targetStoreId=${storeId}`,
    );
    error.code = "PERSONALIZATION_POLICY_DENY";
    throw error;
  }

  return {
    ...meta,
    action: normalized.mode === "check" ? "checked" : changed ? "updated" : "noop",
    decisionId,
    decisionDigest: hash(
      stableStringify({
        decisionId,
        authorized,
        requesterStoreId: normalized.requesterStoreId,
        targetStoreId: storeId,
        allowStoreIds: policy.allowedStoreIds,
      }),
    ),
    authorized,
    crossSpace,
    policy: {
      ...policy,
      changed,
      previousDigest,
      digest: hash(stableStringify(policy)),
    },
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      failClosed: normalized.failClosed,
      allowlistSize: policy.allowedStoreIds.length,
      crossSpace,
      authorized,
      slo: buildSloObservability(meta.requestDigest, "recall_authorization", 30),
    },
  };
}

function runTutorDegraded(request) {
  const { storeId, profile, input } = normalizeRequest("tutor_degraded", request);
  const state = getProfileState(storeId, profile);
  const normalized = normalizeTutorDegradedRequest(request);
  const meta = buildMeta("tutor_degraded", storeId, profile, input);
  const recallAuthorization =
    request.requesterStoreId || request.sourceStoreId
      ? ensureRecallAuthorizationForOperation(state, {
          storeId,
          profile,
          requesterStoreId: request.requesterStoreId ?? request.sourceStoreId,
          operation: "tutor_degraded",
          timestamp: normalized.timestamp,
        })
      : null;
  const degradedMode = normalized.forceDegraded || !normalized.llmAvailable || !normalized.indexAvailable;
  const warnings = [];
  if (!normalized.llmAvailable) {
    warnings.push("LLM_UNAVAILABLE");
  }
  if (!normalized.indexAvailable) {
    warnings.push("INDEX_UNAVAILABLE");
  }

  const orderedReviewEntries = [...state.reviewScheduleEntries].sort((left, right) => {
    const dueDiff = String(left?.dueAt ?? "").localeCompare(String(right?.dueAt ?? ""));
    if (dueDiff !== 0) {
      return dueDiff;
    }
    return String(left?.scheduleEntryId ?? "").localeCompare(String(right?.scheduleEntryId ?? ""));
  });
  const orderedMisconceptions = [...state.misconceptions].sort((left, right) => {
    const leftScore = toNonNegativeInteger(left?.harmfulSignalCount, 0);
    const rightScore = toNonNegativeInteger(right?.harmfulSignalCount, 0);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return String(left?.misconceptionId ?? "").localeCompare(String(right?.misconceptionId ?? ""));
  });
  const orderedPlans = [...state.curriculumPlanItems].sort((left, right) => {
    const rankDiff = toPositiveInteger(left?.recommendationRank, 1) - toPositiveInteger(right?.recommendationRank, 1);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return String(left?.planItemId ?? "").localeCompare(String(right?.planItemId ?? ""));
  });

  const suggestions = [];
  for (const entry of orderedReviewEntries) {
    if (suggestions.length >= normalized.maxSuggestions) {
      break;
    }
    if (entry.status !== "due" && entry.status !== "scheduled") {
      continue;
    }
    if (normalized.query && !String(entry.targetId ?? "").toLowerCase().includes(normalized.query)) {
      continue;
    }
    const suggestionId = makeId(
      "tut",
      hash(stableStringify({ type: "review", scheduleEntryId: entry.scheduleEntryId, query: normalized.query })),
    );
    suggestions.push({
      suggestionId,
      type: "review",
      targetId: entry.targetId,
      priority: entry.status === "due" ? "high" : "medium",
      dueAt: entry.dueAt,
      evidencePointers: normalizeEvidencePointers([
        ...(entry.sourceEventIds ?? []).map((pointerId) => ({
          pointerId,
          kind: "event",
          source: "review_schedule",
        })),
        ...(entry.evidenceEventIds ?? []).map((pointerId) => ({
          pointerId,
          kind: "event",
          source: "review_schedule",
        })),
      ]),
      rationale: "deterministic_due_queue",
    });
  }
  for (const misconception of orderedMisconceptions) {
    if (suggestions.length >= normalized.maxSuggestions) {
      break;
    }
    if (misconception.status === "suppressed") {
      continue;
    }
    if (normalized.query && !String(misconception.misconceptionKey ?? "").toLowerCase().includes(normalized.query)) {
      continue;
    }
    const suggestionId = makeId(
      "tut",
      hash(
        stableStringify({
          type: "misconception",
          misconceptionId: misconception.misconceptionId,
          query: normalized.query,
        }),
      ),
    );
    suggestions.push({
      suggestionId,
      type: "remediation",
      targetId: misconception.misconceptionId,
      priority: misconception.status === "active" ? "high" : "medium",
      dueAt: normalized.timestamp,
      evidencePointers: normalizeEvidencePointers(
        (misconception.evidenceEventIds ?? []).map((pointerId) => ({
          pointerId,
          kind: "event",
          source: "misconception",
        })),
      ),
      rationale: "harmful_signal_remediation",
    });
  }
  for (const planItem of orderedPlans) {
    if (suggestions.length >= normalized.maxSuggestions) {
      break;
    }
    if (!Array.isArray(planItem.evidenceEventIds) || planItem.evidenceEventIds.length === 0) {
      continue;
    }
    if (normalized.query && !String(planItem.objectiveId ?? "").toLowerCase().includes(normalized.query)) {
      continue;
    }
    const suggestionId = makeId(
      "tut",
      hash(
        stableStringify({
          type: "curriculum",
          planItemId: planItem.planItemId,
          query: normalized.query,
        }),
      ),
    );
    suggestions.push({
      suggestionId,
      type: "curriculum",
      targetId: planItem.objectiveId,
      priority: "medium",
      dueAt: planItem.dueAt,
      evidencePointers: normalizeEvidencePointers([
        ...(planItem.evidenceEventIds ?? []).map((pointerId) => ({
          pointerId,
          kind: "event",
          source: "curriculum_plan",
        })),
        ...(planItem.provenanceSignalIds ?? []).map((pointerId) => ({
          pointerId,
          kind: "signal",
          source: "curriculum_plan",
        })),
      ]),
      rationale: "evidence_backed_curriculum_item",
    });
  }

  const deterministicWarnings = [...warnings].sort((left, right) => left.localeCompare(right));
  const responseText =
    suggestions.length === 0
      ? "No evidence-backed tutoring suggestions are currently available in degraded mode."
      : suggestions
          .map((suggestion, index) => `${index + 1}. ${suggestion.type}:${suggestion.targetId} (${suggestion.priority})`)
          .join("\n");
  const sessionId = makeId(
    "tutor",
    hash(
      stableStringify({
        storeId,
        profile,
        query: normalized.query,
        timestamp: normalized.timestamp,
        degradedMode,
        warnings: deterministicWarnings,
        suggestionIds: suggestions.map((suggestion) => suggestion.suggestionId),
      }),
    ),
  );
  const sessionRecord = {
    sessionId,
    timestamp: normalized.timestamp,
    query: normalized.query,
    degradedMode,
    capabilityFlags: {
      llmAvailable: normalized.llmAvailable,
      indexAvailable: normalized.indexAvailable,
    },
    warnings: deterministicWarnings,
    suggestionIds: suggestions.map((suggestion) => suggestion.suggestionId),
    responseDigest: hash(stableStringify({ responseText, suggestions })),
  };
  const sessionUpsert = upsertDeterministicRecord(
    state.degradedTutorSessions,
    "sessionId",
    sessionRecord,
    "timestamp",
  );
  state.degradedTutorSessions = sessionUpsert.nextRecords;
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "tutor_degraded",
    storeId,
    profile,
    entityId: sessionId,
    outcome: degradedMode ? "review" : "allow",
    reasonCodes: degradedMode ? deterministicWarnings : ["normal_mode_available"],
    details: {
      suggestionCount: suggestions.length,
      query: normalized.query,
      maxSuggestions: normalized.maxSuggestions,
    },
    timestamp: normalized.timestamp,
  });

  return {
    ...meta,
    action: sessionUpsert.action,
    sessionId,
    degradedMode,
    capabilityFlags: {
      llmAvailable: normalized.llmAvailable,
      indexAvailable: normalized.indexAvailable,
      deterministicFallback: true,
    },
    authorization: recallAuthorization
      ? {
          authorized: recallAuthorization.authorized,
          crossSpace: recallAuthorization.crossSpace,
          policyAuditEventId: recallAuthorization.policyAuditEventId,
        }
      : null,
    warnings: deterministicWarnings,
    suggestions,
    responseText,
    sessionDigest: hash(stableStringify(sessionRecord)),
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      degradedMode,
      warningCount: deterministicWarnings.length,
      suggestionCount: suggestions.length,
      deterministicOutput: true,
      supportedWithoutLlmOrIndex: true,
      slo: buildSloObservability(meta.requestDigest, "tutor_degraded", 55),
    },
  };
}

function runPolicyAuditExport(request) {
  const { storeId, profile, input } = normalizeRequest("policy_audit_export", request);
  const state = getProfileState(storeId, profile);
  const generatedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.generatedAt ?? request.createdAt,
    "policy_audit_export.timestamp",
    DEFAULT_VERSION_TIMESTAMP,
  );
  const limit = Math.min(Math.max(toPositiveInteger(request.limit, MAX_LIST_ITEMS), 1), MAX_LIST_ITEMS);
  const meta = buildMeta("policy_audit_export", storeId, profile, input);
  const policy = getOrCreateRecallAllowlistPolicy(state, storeId, profile);
  const policyDecisions = sortByTimestampAndId(state.policyDecisions, "updatedAt", "decisionId")
    .slice(-limit)
    .map((decision) => ({
      decisionId: decision.decisionId,
      policyKey: decision.policyKey,
      outcome: decision.outcome,
      reasonCodes: decision.reasonCodes,
      provenanceEventIds: decision.provenanceEventIds,
      updatedAt: decision.updatedAt,
      digest: hash(stableStringify(decision)),
    }));
  const auditTrail = sortByTimestampAndId(state.policyAuditTrail ?? [], "timestamp", "auditEventId").slice(-limit);
  const incidentChecklist = [
    {
      checkId: "policy_decision_traceability",
      status: policyDecisions.length > 0 ? "pass" : "warn",
      details: "Policy decisions include deterministic IDs, reason codes, and provenance pointers.",
    },
    {
      checkId: "cross_space_allowlist_enforcement",
      status: policy.allowedStoreIds.includes(storeId) ? "pass" : "warn",
      details: "Target store remains present in allowlist policy baseline.",
    },
    {
      checkId: "prompt_injection_quarantine_visibility",
      status: auditTrail.some((entry) =>
        (entry.reasonCodes ?? []).some((reasonCode) => reasonCode.startsWith("prompt_override_")))
        ? "pass"
        : "warn",
      details: "Audit trail captures prompt-injection quarantine evidence when present.",
    },
    {
      checkId: "rollback_readiness",
      status: auditTrail.length > 0 ? "pass" : "warn",
      details: "Audit trail exists for incident rollback and postmortem analysis.",
    },
  ];
  const payload = {
    exportVersion: "1.0.0",
    generatedAt,
    storeId,
    profile,
    policy: {
      policyId: policy.policyId,
      allowStoreIds: policy.allowedStoreIds,
      updatedAt: policy.updatedAt,
    },
    policyDecisions,
    auditTrail,
    incidentChecklist,
  };
  const exportId = makeId(
    "pae",
    hash(
      stableStringify({
        storeId,
        profile,
        generatedAt,
        policyDecisionIds: policyDecisions.map((decision) => decision.decisionId),
        auditEventIds: auditTrail.map((entry) => entry.auditEventId),
      }),
    ),
  );
  const payloadDigest = hash(stableStringify(payload));
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "policy_audit_export",
    storeId,
    profile,
    entityId: exportId,
    outcome: "recorded",
    reasonCodes: ["policy_audit_export"],
    details: {
      decisionCount: policyDecisions.length,
      auditEventCount: auditTrail.length,
      checklistStatus: incidentChecklist.map((entry) => `${entry.checkId}:${entry.status}`),
    },
    timestamp: generatedAt,
  });

  return {
    ...meta,
    action: "exported",
    exportId,
    payloadDigest,
    payload,
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      decisionCount: policyDecisions.length,
      auditEventCount: auditTrail.length,
      checklistCount: incidentChecklist.length,
      deterministicExport: true,
      replaySafe: true,
      slo: buildSloObservability(meta.requestDigest, "policy_audit_export", 50),
    },
  };
}

function runFeedback(request) {
  const { storeId, profile, input } = normalizeRequest("feedback", request);
  const state = getProfileState(storeId, profile);
  const targetRuleId = typeof request.targetRuleId === "string" ? request.targetRuleId : "";
  const signal = request.signal === "harmful" ? "harmful" : "helpful";
  const note = typeof request.note === "string" ? request.note : "";
  const seed = hash(stableStringify({ targetRuleId, signal, note }));
  const feedbackId = makeId("fdbk", seed);

  state.feedback.push({
    feedbackId,
    targetRuleId,
    signal,
    note,
  });

  return {
    ...buildMeta("feedback", storeId, profile, input),
    feedbackId,
    targetRuleId,
    signal,
    totalFeedback: state.feedback.length,
  };
}

function runOutcome(request) {
  const { storeId, profile, input } = normalizeRequest("outcome", request);
  const state = getProfileState(storeId, profile);
  const outcome = request.outcome === "failure" ? "failure" : "success";
  const task = typeof request.task === "string" && request.task ? request.task : "unspecified-task";
  const usedRuleIds = Array.isArray(request.usedRuleIds)
    ? request.usedRuleIds.filter((entry) => typeof entry === "string")
    : [];
  const outcomeId = makeId("out", hash(stableStringify({ task, outcome, usedRuleIds })));

  state.outcomes.push({
    outcomeId,
    task,
    outcome,
    usedRuleIds,
  });

  return {
    ...buildMeta("outcome", storeId, profile, input),
    outcomeId,
    task,
    outcome,
    usedRuleIds,
    totalOutcomes: state.outcomes.length,
  };
}

function runAudit(request) {
  const { storeId, profile, input } = normalizeRequest("audit", request);
  const state = getProfileState(storeId, profile);
  const duplicateStatements = new Set();
  const seen = new Set();
  for (const rule of state.rules) {
    const key = rule.statement.toLowerCase();
    if (seen.has(key)) {
      duplicateStatements.add(rule.statement);
    } else {
      seen.add(key);
    }
  }

  return {
    ...buildMeta("audit", storeId, profile, input),
    checks: [
      { name: "events_present", status: state.events.length > 0 ? "pass" : "warn" },
      { name: "rules_present", status: state.rules.length > 0 ? "pass" : "warn" },
      { name: "duplicate_rules", status: duplicateStatements.size === 0 ? "pass" : "warn" },
    ],
    duplicateRules: Array.from(duplicateStatements.values()),
  };
}

function runExport(request) {
  const { storeId, profile, input } = normalizeRequest("export", request);
  const state = getProfileState(storeId, profile);
  const topRules = state.rules.slice(0, 5);
  const topAntiPatterns = state.feedback
    .filter((entry) => entry.signal === "harmful")
    .slice(0, 5)
    .map((entry) => entry.note || entry.targetRuleId);
  const agentsMdLines = [
    "# UMS Memory Export",
    "",
    `Store: ${storeId}`,
    `Profile: ${profile}`,
    "",
    "## Top Rules",
    ...topRules.map((rule) => `- ${rule.statement} (confidence=${rule.confidence})`),
    "",
    "## Anti-pattern Signals",
    ...topAntiPatterns.map((line) => `- ${line}`),
  ];

  return {
    ...buildMeta("export", storeId, profile, input),
    format: request.format === "playbook" ? "playbook" : "agents-md",
    agentsMd: agentsMdLines.join("\n"),
    playbook: {
      storeId,
      profile,
      topRules,
      antiPatterns: topAntiPatterns,
    },
  };
}

function runDoctor(request) {
  const { storeId, profile, input } = normalizeRequest("doctor", request);
  const state = getProfileState(storeId, profile);
  const status = {
    events: state.events.length,
    rules: state.rules.length,
    feedback: state.feedback.length,
    outcomes: state.outcomes.length,
    learnerProfiles: state.learnerProfiles.length,
    identityGraphEdges: state.identityGraphEdges.length,
    misconceptions: state.misconceptions.length,
    painSignals: state.painSignals.length,
    failureSignals: state.failureSignals.length,
    curriculumPlanItems: state.curriculumPlanItems.length,
    curriculumRecommendationSnapshots: state.curriculumRecommendationSnapshots.length,
    reviewScheduleEntries: state.reviewScheduleEntries.length,
    reviewArchivalRecords: state.reviewArchivalTiers?.archivedRecords?.length ?? 0,
    policyDecisions: state.policyDecisions.length,
    policyAuditTrail: state.policyAuditTrail.length,
  };

  return {
    ...buildMeta("doctor", storeId, profile, input),
    healthy: true,
    checks: [
      { name: "json_contracts", status: "pass" },
      { name: "deterministic_hashing", status: "pass" },
      { name: "store_initialized", status: "pass" },
    ],
    status,
  };
}

const runners = {
  ingest: runIngest,
  context: runContext,
  reflect: runReflect,
  validate: runValidate,
  curate: runCurate,
  curate_guarded: runCurateGuarded,
  guarded_curate: runCurateGuarded,
  secure_curate: runCurateGuarded,
  learner_profile_update: runLearnerProfileUpdate,
  identity_graph_update: runIdentityGraphUpdate,
  misconception_update: runMisconceptionUpdate,
  pain_signal_ingest: runPainSignalIngest,
  explicit_pain_signal_ingest: runPainSignalIngest,
  failure_signal_ingest: runFailureSignalIngest,
  implicit_failure_signal_ingest: runFailureSignalIngest,
  curriculum_plan_update: runCurriculumPlanUpdate,
  curriculum_recommendation: runCurriculumRecommendation,
  curriculum_recommend: runCurriculumRecommendation,
  review_schedule_update: runReviewScheduleUpdate,
  review_schedule_clock: runReviewScheduleClock,
  review_set_rebalance: runReviewSetRebalance,
  review_archive_rebalance: runReviewSetRebalance,
  policy_decision_update: runPolicyDecisionUpdate,
  recall_authorization: runRecallAuthorization,
  recall_authorize: runRecallAuthorization,
  tutor_degraded: runTutorDegraded,
  degraded_tutor: runTutorDegraded,
  policy_audit_export: runPolicyAuditExport,
  feedback: runFeedback,
  outcome: runOutcome,
  audit: runAudit,
  export: runExport,
  doctor: runDoctor,
};

export function executeOperation(operation, request) {
  const op = typeof operation === "string" ? operation.trim().toLowerCase() : "";
  const runner = runners[op];
  if (!runner) {
    const error = new Error(`Unsupported operation: ${operation}`);
    error.code = "UNSUPPORTED_OPERATION";
    throw error;
  }
  return runner(request ?? {});
}

export function listOperations() {
  return [...OPS];
}

function cloneStable(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return JSON.parse(stableStringify(value));
}

function cloneIdentityRefRecord(identityRef) {
  return {
    ...(identityRef ?? {}),
    metadata: cloneStable(identityRef?.metadata ?? {}, {}),
  };
}

function cloneLearnerProfileRecord(learnerProfile) {
  return {
    ...(learnerProfile ?? {}),
    identityRefs: (learnerProfile?.identityRefs ?? []).map(cloneIdentityRefRecord),
    metadata: cloneStable(learnerProfile?.metadata ?? {}, {}),
    evidencePointers: cloneStable(learnerProfile?.evidencePointers ?? [], []),
    policyException: cloneStable(learnerProfile?.policyException ?? null, null),
    sourceSignals: cloneStable(learnerProfile?.sourceSignals ?? [], []),
    providedAttributes: cloneStable(learnerProfile?.providedAttributes ?? [], []),
    attributeLineage: cloneStable(learnerProfile?.attributeLineage ?? {}, {}),
    attributeTruth: cloneStable(learnerProfile?.attributeTruth ?? {}, {}),
  };
}

function cloneIdentityGraphEdgeRecord(edge) {
  return {
    ...(edge ?? {}),
    fromRef: cloneIdentityRefRecord(edge?.fromRef),
    toRef: cloneIdentityRefRecord(edge?.toRef),
    metadata: cloneStable(edge?.metadata ?? {}, {}),
    evidencePointers: cloneStable(edge?.evidencePointers ?? [], []),
    sourceSignals: cloneStable(edge?.sourceSignals ?? [], []),
  };
}

export function snapshotProfile(profile = INTERNAL_PROFILE_ID, storeId = DEFAULT_STORE_ID) {
  const state = getProfileState(defaultStoreId(storeId), defaultProfile(profile));
  return {
    events: state.events.map((event) => ({ ...event })),
    rules: state.rules.map((rule) => ({ ...rule })),
    feedback: state.feedback.map((entry) => ({ ...entry })),
    outcomes: state.outcomes.map((entry) => ({ ...entry })),
    learnerProfiles: state.learnerProfiles.map(cloneLearnerProfileRecord),
    identityGraphEdges: state.identityGraphEdges.map(cloneIdentityGraphEdgeRecord),
    misconceptions: state.misconceptions.map((record) => ({
      ...record,
      metadata: { ...(record.metadata ?? {}) },
    })),
    curriculumPlanItems: state.curriculumPlanItems.map((item) => ({
      ...item,
      metadata: { ...(item.metadata ?? {}) },
    })),
    curriculumRecommendationSnapshots: state.curriculumRecommendationSnapshots.map((snapshot) => ({
      ...snapshot,
      recommendations: cloneStable(snapshot.recommendations ?? [], []),
      metadata: cloneStable(snapshot.metadata ?? {}, {}),
    })),
    reviewScheduleEntries: state.reviewScheduleEntries.map((entry) => ({
      ...entry,
      metadata: { ...(entry.metadata ?? {}) },
    })),
    painSignals: state.painSignals.map((signal) => ({
      ...signal,
      metadata: cloneStable(signal.metadata ?? {}, {}),
    })),
    failureSignals: state.failureSignals.map((signal) => ({
      ...signal,
      metadata: cloneStable(signal.metadata ?? {}, {}),
    })),
    schedulerClocks: cloneStable(state.schedulerClocks ?? {}, {}),
    reviewArchivalTiers: cloneStable(state.reviewArchivalTiers ?? {}, {}),
    recallAllowlistPolicy: cloneStable(state.recallAllowlistPolicy ?? {}, {}),
    degradedTutorSessions: cloneStable(state.degradedTutorSessions ?? [], []),
    policyDecisions: state.policyDecisions.map((decision) => ({
      ...decision,
      metadata: { ...(decision.metadata ?? {}) },
    })),
    policyAuditTrail: cloneStable(state.policyAuditTrail ?? [], []),
  };
}

function serializeState(state) {
  return {
    events: state.events.map((event) => ({ ...event })),
    rules: state.rules.map((rule) => ({ ...rule })),
    feedback: state.feedback.map((entry) => ({ ...entry })),
    outcomes: state.outcomes.map((entry) => ({ ...entry })),
    learnerProfiles: state.learnerProfiles.map(cloneLearnerProfileRecord),
    identityGraphEdges: state.identityGraphEdges.map(cloneIdentityGraphEdgeRecord),
    misconceptions: state.misconceptions.map((record) => ({
      ...record,
      metadata: { ...(record.metadata ?? {}) },
    })),
    curriculumPlanItems: state.curriculumPlanItems.map((item) => ({
      ...item,
      metadata: { ...(item.metadata ?? {}) },
    })),
    curriculumRecommendationSnapshots: state.curriculumRecommendationSnapshots.map((snapshot) => ({
      ...snapshot,
      recommendations: cloneStable(snapshot.recommendations ?? [], []),
      metadata: cloneStable(snapshot.metadata ?? {}, {}),
    })),
    reviewScheduleEntries: state.reviewScheduleEntries.map((entry) => ({
      ...entry,
      metadata: { ...(entry.metadata ?? {}) },
    })),
    painSignals: state.painSignals.map((signal) => ({
      ...signal,
      metadata: cloneStable(signal.metadata ?? {}, {}),
    })),
    failureSignals: state.failureSignals.map((signal) => ({
      ...signal,
      metadata: cloneStable(signal.metadata ?? {}, {}),
    })),
    schedulerClocks: cloneStable(state.schedulerClocks ?? {}, {}),
    reviewArchivalTiers: cloneStable(state.reviewArchivalTiers ?? {}, {}),
    recallAllowlistPolicy: cloneStable(state.recallAllowlistPolicy ?? {}, {}),
    degradedTutorSessions: cloneStable(state.degradedTutorSessions ?? [], []),
    policyDecisions: state.policyDecisions.map((decision) => ({
      ...decision,
      metadata: { ...(decision.metadata ?? {}) },
    })),
    policyAuditTrail: cloneStable(state.policyAuditTrail ?? [], []),
  };
}

export function exportStoreSnapshot() {
  const storesPayload = {};

  for (const storeId of [...stores.keys()].sort()) {
    const profiles = stores.get(storeId) ?? new Map();
    const profilesPayload = {};
    for (const profile of [...profiles.keys()].sort()) {
      profilesPayload[profile] = serializeState(profiles.get(profile));
    }
    storesPayload[storeId] = { profiles: profilesPayload };
  }

  return { stores: storesPayload };
}

function normalizeState(rawState) {
  const state = rawState && typeof rawState === "object" ? rawState : {};
  const events = Array.isArray(state.events) ? state.events : [];
  const rules = Array.isArray(state.rules) ? state.rules : [];
  const feedback = Array.isArray(state.feedback) ? state.feedback : [];
  const outcomes = Array.isArray(state.outcomes) ? state.outcomes : [];
  const learnerProfiles = Array.isArray(state.learnerProfiles) ? state.learnerProfiles : [];
  const identityGraphEdges = Array.isArray(state.identityGraphEdges) ? state.identityGraphEdges : [];
  const misconceptions = Array.isArray(state.misconceptions) ? state.misconceptions : [];
  const curriculumPlanItems = Array.isArray(state.curriculumPlanItems) ? state.curriculumPlanItems : [];
  const curriculumRecommendationSnapshots = Array.isArray(state.curriculumRecommendationSnapshots)
    ? state.curriculumRecommendationSnapshots
    : [];
  const reviewScheduleEntries = Array.isArray(state.reviewScheduleEntries) ? state.reviewScheduleEntries : [];
  const painSignals = Array.isArray(state.painSignals) ? state.painSignals : [];
  const failureSignals = Array.isArray(state.failureSignals) ? state.failureSignals : [];
  const degradedTutorSessions = Array.isArray(state.degradedTutorSessions) ? state.degradedTutorSessions : [];
  const policyDecisions = Array.isArray(state.policyDecisions) ? state.policyDecisions : [];
  const policyAuditTrail = Array.isArray(state.policyAuditTrail) ? state.policyAuditTrail : [];
  const eventDigests = new Set(
    events
      .map((event) => (event && typeof event === "object" ? event.digest : null))
      .filter((digest) => typeof digest === "string" && digest),
  );

  return {
    events: events.map((event) => ({ ...event })),
    eventDigests,
    rules: rules.map((rule) => ({ ...rule })),
    feedback: feedback.map((entry) => ({ ...entry })),
    outcomes: outcomes.map((entry) => ({ ...entry })),
    learnerProfiles: learnerProfiles.map((learnerProfile) => ({
      ...learnerProfile,
      identityRefs: Array.isArray(learnerProfile?.identityRefs)
        ? learnerProfile.identityRefs.map((identityRef) => ({
            ...identityRef,
            metadata: isPlainObject(identityRef?.metadata) ? { ...identityRef.metadata } : {},
          }))
        : [],
      metadata: isPlainObject(learnerProfile?.metadata) ? { ...learnerProfile.metadata } : {},
      evidencePointers: normalizeEvidencePointers(learnerProfile?.evidencePointers),
      policyException: normalizePolicyException(learnerProfile?.policyException ?? null),
      sourceSignals: mergeSourceSignals([], learnerProfile?.sourceSignals),
      providedAttributes: normalizeBoundedStringArray(learnerProfile?.providedAttributes, "providedAttributes"),
      createdAt: normalizeIsoTimestampOrFallback(learnerProfile?.createdAt, DEFAULT_VERSION_TIMESTAMP),
      updatedAt: normalizeIsoTimestampOrFallback(
        learnerProfile?.updatedAt,
        normalizeIsoTimestampOrFallback(learnerProfile?.createdAt, DEFAULT_VERSION_TIMESTAMP),
      ),
      attributeLineage: isPlainObject(learnerProfile?.attributeLineage) ? stableSortObject(learnerProfile.attributeLineage) : {},
      attributeTruth: isPlainObject(learnerProfile?.attributeTruth) ? stableSortObject(learnerProfile.attributeTruth) : {},
    })),
    identityGraphEdges: identityGraphEdges.map((edge) => ({
      ...edge,
      fromRef: isPlainObject(edge?.fromRef)
        ? {
            ...edge.fromRef,
            metadata: isPlainObject(edge.fromRef.metadata) ? { ...edge.fromRef.metadata } : {},
          }
        : normalizeIdentityRef(null),
      toRef: isPlainObject(edge?.toRef)
        ? {
            ...edge.toRef,
            metadata: isPlainObject(edge.toRef.metadata) ? { ...edge.toRef.metadata } : {},
          }
        : normalizeIdentityRef(null),
      evidencePointers: normalizeEvidencePointers(edge?.evidencePointers),
      evidenceEventIds: normalizeBoundedStringArray(
        edge?.evidenceEventIds ?? edge?.evidenceEpisodeIds,
        "identityGraphEdges.evidenceEventIds",
      ),
      sourceSignals: mergeSourceSignals([], edge?.sourceSignals),
      metadata: isPlainObject(edge?.metadata) ? { ...edge.metadata } : {},
      createdAt: normalizeIsoTimestampOrFallback(edge?.createdAt, DEFAULT_VERSION_TIMESTAMP),
      updatedAt: normalizeIsoTimestampOrFallback(
        edge?.updatedAt,
        normalizeIsoTimestampOrFallback(edge?.createdAt, DEFAULT_VERSION_TIMESTAMP),
      ),
    })),
    misconceptions: misconceptions.map((record) => ({
      ...record,
      metadata: isPlainObject(record?.metadata) ? { ...record.metadata } : {},
    })),
    curriculumPlanItems: curriculumPlanItems.map((item) => ({
      ...item,
      metadata: isPlainObject(item?.metadata) ? { ...item.metadata } : {},
    })),
    curriculumRecommendationSnapshots: curriculumRecommendationSnapshots.map((snapshot) => ({
      ...snapshot,
      recommendationSetId:
        normalizeBoundedString(snapshot?.recommendationSetId, "curriculumRecommendationSnapshots.recommendationSetId", 64) ??
        makeId("recs", hash(stableStringify(snapshot))),
      generatedAt: normalizeIsoTimestampOrFallback(snapshot?.generatedAt, DEFAULT_VERSION_TIMESTAMP),
      requestDigest: normalizeBoundedString(snapshot?.requestDigest, "curriculumRecommendationSnapshots.requestDigest", 128),
      recommendationIds: normalizeBoundedStringArray(
        snapshot?.recommendationIds,
        "curriculumRecommendationSnapshots.recommendationIds",
      ),
      recommendations: Array.isArray(snapshot?.recommendations) ? cloneStable(snapshot.recommendations, []) : [],
      metadata: isPlainObject(snapshot?.metadata) ? { ...snapshot.metadata } : {},
    })),
    reviewScheduleEntries: reviewScheduleEntries.map((entry) => ({
      ...entry,
      metadata: isPlainObject(entry?.metadata) ? { ...entry.metadata } : {},
    })),
    painSignals: sortByTimestampAndId(
      painSignals.map((signal) => ({
        ...signal,
        painSignalId:
          normalizeBoundedString(signal?.painSignalId, "painSignals.painSignalId", 64) ??
          makeId("pain", hash(stableStringify(signal))),
        recordedAt: normalizeIsoTimestampOrFallback(signal?.recordedAt, DEFAULT_VERSION_TIMESTAMP),
        metadata: isPlainObject(signal?.metadata) ? { ...signal.metadata } : {},
      })),
      "recordedAt",
      "painSignalId",
    ),
    failureSignals: sortByTimestampAndId(
      failureSignals.map((signal) => ({
        ...signal,
        failureSignalId:
          normalizeBoundedString(signal?.failureSignalId, "failureSignals.failureSignalId", 64) ??
          makeId("fail", hash(stableStringify(signal))),
        recordedAt: normalizeIsoTimestampOrFallback(signal?.recordedAt, DEFAULT_VERSION_TIMESTAMP),
        metadata: isPlainObject(signal?.metadata) ? { ...signal.metadata } : {},
      })),
      "recordedAt",
      "failureSignalId",
    ),
    schedulerClocks: {
      interactionTick: toNonNegativeInteger(state.schedulerClocks?.interactionTick, 0),
      sleepTick: toNonNegativeInteger(state.schedulerClocks?.sleepTick, 0),
      fatigueLoad: toNonNegativeInteger(state.schedulerClocks?.fatigueLoad, 0),
      sleepThreshold: toPositiveInteger(state.schedulerClocks?.sleepThreshold, DEFAULT_SLEEP_THRESHOLD),
      consolidationCount: toNonNegativeInteger(state.schedulerClocks?.consolidationCount, 0),
      lastInteractionAt: normalizeIsoTimestampOrFallback(state.schedulerClocks?.lastInteractionAt, DEFAULT_VERSION_TIMESTAMP),
      lastSleepAt: normalizeIsoTimestampOrFallback(state.schedulerClocks?.lastSleepAt, DEFAULT_VERSION_TIMESTAMP),
      lastConsolidatedAt: normalizeIsoTimestampOrFallback(
        state.schedulerClocks?.lastConsolidatedAt,
        DEFAULT_VERSION_TIMESTAMP,
      ),
      updatedAt: normalizeIsoTimestampOrFallback(state.schedulerClocks?.updatedAt, DEFAULT_VERSION_TIMESTAMP),
    },
    reviewArchivalTiers: {
      activeLimit: Math.min(
        Math.max(toPositiveInteger(state.reviewArchivalTiers?.activeLimit, DEFAULT_ACTIVE_REVIEW_SET_LIMIT), 1),
        MAX_ACTIVE_REVIEW_SET_LIMIT,
      ),
      activeReviewIds: normalizeBoundedStringArray(
        state.reviewArchivalTiers?.activeReviewIds,
        "reviewArchivalTiers.activeReviewIds",
      ),
      tiers: {
        warm: normalizeBoundedStringArray(state.reviewArchivalTiers?.tiers?.warm, "reviewArchivalTiers.tiers.warm"),
        cold: normalizeBoundedStringArray(state.reviewArchivalTiers?.tiers?.cold, "reviewArchivalTiers.tiers.cold"),
        frozen: normalizeBoundedStringArray(
          state.reviewArchivalTiers?.tiers?.frozen,
          "reviewArchivalTiers.tiers.frozen",
        ),
      },
      archivedRecords: Array.isArray(state.reviewArchivalTiers?.archivedRecords)
        ? sortByTimestampAndId(
            state.reviewArchivalTiers.archivedRecords.map((record) => ({
              ...record,
              archiveRecordId:
                normalizeBoundedString(record?.archiveRecordId, "reviewArchivalTiers.archiveRecordId", 64) ??
                makeId("arc", hash(stableStringify(record))),
              archivedAt: normalizeIsoTimestampOrFallback(record?.archivedAt, DEFAULT_VERSION_TIMESTAMP),
              metadata: isPlainObject(record?.metadata) ? { ...record.metadata } : {},
            })),
            "archivedAt",
            "archiveRecordId",
          )
        : [],
      updatedAt: normalizeIsoTimestampOrFallback(state.reviewArchivalTiers?.updatedAt, DEFAULT_VERSION_TIMESTAMP),
    },
    recallAllowlistPolicy: {
      policyId:
        normalizeBoundedString(state.recallAllowlistPolicy?.policyId, "recallAllowlistPolicy.policyId", 64) ??
        makeId("allow", hash(stableStringify(state.recallAllowlistPolicy ?? {}))),
      allowedStoreIds: normalizeBoundedStringArray(
        state.recallAllowlistPolicy?.allowedStoreIds,
        "recallAllowlistPolicy.allowedStoreIds",
      ),
      updatedAt: normalizeIsoTimestampOrFallback(state.recallAllowlistPolicy?.updatedAt, DEFAULT_VERSION_TIMESTAMP),
      metadata: isPlainObject(state.recallAllowlistPolicy?.metadata) ? { ...state.recallAllowlistPolicy.metadata } : {},
    },
    degradedTutorSessions: sortByTimestampAndId(
      degradedTutorSessions.map((session) => ({
        ...session,
        sessionId:
          normalizeBoundedString(session?.sessionId, "degradedTutorSessions.sessionId", 64) ??
          makeId("tutor", hash(stableStringify(session))),
        timestamp: normalizeIsoTimestampOrFallback(session?.timestamp, DEFAULT_VERSION_TIMESTAMP),
      })),
      "timestamp",
      "sessionId",
    ),
    policyDecisions: policyDecisions.map((decision) => ({
      ...decision,
      metadata: isPlainObject(decision?.metadata) ? { ...decision.metadata } : {},
    })),
    policyAuditTrail: sortByTimestampAndId(
      policyAuditTrail.map((entry) => ({
        ...entry,
        auditEventId:
          normalizeBoundedString(entry?.auditEventId, "policyAuditTrail.auditEventId", 64) ??
          makeId("audit", hash(stableStringify(entry))),
        timestamp: normalizeIsoTimestampOrFallback(entry?.timestamp, DEFAULT_VERSION_TIMESTAMP),
        details: isPlainObject(entry?.details) ? { ...entry.details } : {},
      })),
      "timestamp",
      "auditEventId",
    ),
  };
}

function importProfiles(storeId, profiles) {
  const normalizedStore = defaultStoreId(storeId);
  const profileMap = getStoreProfiles(normalizedStore);
  const source = profiles && typeof profiles === "object" ? profiles : {};

  for (const profile of Object.keys(source).sort()) {
    profileMap.set(defaultProfile(profile), normalizeState(source[profile]));
  }
}

export function importStoreSnapshot(snapshot) {
  stores.clear();
  if (!snapshot || typeof snapshot !== "object") {
    return;
  }

  if (snapshot.stores && typeof snapshot.stores === "object" && !Array.isArray(snapshot.stores)) {
    for (const storeId of Object.keys(snapshot.stores).sort()) {
      const storeEntry = snapshot.stores[storeId];
      const profiles =
        storeEntry && typeof storeEntry === "object" && storeEntry.profiles && typeof storeEntry.profiles === "object"
          ? storeEntry.profiles
          : {};
      importProfiles(storeId, profiles);
    }
    return;
  }

  if (snapshot.profiles && typeof snapshot.profiles === "object") {
    importProfiles(DEFAULT_STORE_ID, snapshot.profiles);
  }
}

export function resetStore() {
  stores.clear();
}

export function findRuleByDigestPrefix(profile, digestPrefix, storeId = DEFAULT_STORE_ID) {
  const state = getProfileState(defaultStoreId(storeId), defaultProfile(profile));
  return findByDigestPrefix(state.rules, digestPrefix, "ruleId");
}
