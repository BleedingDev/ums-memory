import { createHash, createHmac } from "node:crypto";

import { Effect } from "effect";

const OPS = [
  "ingest",
  "context",
  "reflect",
  "validate",
  "curate",
  "shadow_write",
  "replay_eval",
  "promote",
  "demote",
  "addweight",
  "learner_profile_update",
  "identity_graph_update",
  "misconception_update",
  "curriculum_plan_update",
  "review_schedule_update",
  "policy_decision_update",
  "pain_signal_ingest",
  "failure_signal_ingest",
  "incident_escalation_signal",
  "manual_quarantine_override",
  "curriculum_recommendation",
  "review_schedule_clock",
  "review_set_rebalance",
  "curate_guarded",
  "recall_authorization",
  "tutor_degraded",
  "policy_audit_export",
  "memory_console_search",
  "memory_console_timeline",
  "memory_console_provenance",
  "memory_console_policy_audit",
  "memory_console_anomaly_alerts",
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
const MAX_WEIGHT_ADJUSTMENT_LEDGER_EVENTS = 4096;
const MAX_RECOMMENDATIONS = 64;
const MAX_RECOMMENDATION_TOKEN_BUDGET = 8192;
const DEFAULT_RECOMMENDATION_TOKEN_BUDGET = 1024;
const DEFAULT_FRESHNESS_WARNING_DAYS = 14;
const DEFAULT_DECAY_WARNING_DAYS = 30;
const DEFAULT_MAX_CONFLICT_NOTES = 8;
const DEFAULT_MEMORY_CONSOLE_LIMIT = 25;
const DEFAULT_ANOMALY_WINDOW_HOURS = 24;
const MAX_ANOMALY_WINDOW_HOURS = 720;
const MAX_ANOMALY_EVIDENCE_IDS = 16;
const ANOMALY_ALERT_RULES = Object.freeze({
  harmful_signal_spike: Object.freeze({
    minObservationCount: 3,
    minDelta: 2,
    multiplier: 2,
  }),
  unauthorized_access_spike: Object.freeze({
    minObservationCount: 2,
    minDelta: 1,
    multiplier: 2,
  }),
  policy_drift_indicator: Object.freeze({
    minObservationCount: 1,
    minDelta: 1,
    multiplier: 1.5,
  }),
});
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
const INCIDENT_ESCALATION_EVIDENCE_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: incident_escalation_signal requires at least one evidenceEventId.";
const MANUAL_OVERRIDE_TARGET_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: manual_quarantine_override requires at least one targetCandidateId or targetRuleId.";
const MANUAL_OVERRIDE_REASON_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: manual_quarantine_override requires reasonCodes or a reason.";
const MANUAL_OVERRIDE_ACTOR_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: manual_quarantine_override requires actor.";
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
const POLICY_PACK_PLUGIN_CONTRACT_VERSION = "v1";
const POLICY_PACK_PLUGIN_FAIL_CLOSED_CONTRACT_REASON_CODE =
  "policy_pack_plugin_contract_error";
const POLICY_PACK_PLUGIN_FAIL_CLOSED_FAILURE_REASON_CODE =
  "policy_pack_plugin_failure";
const SHADOW_WRITE_EVIDENCE_CONTRACT_ERROR =
  "EVIDENCE_POINTER_CONTRACT_VIOLATION: shadow_write requires at least one sourceEventId or evidenceEventId.";
const REPLAY_EVAL_CANDIDATE_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: replay_eval requires an existing shadow candidate.";
const PROMOTE_GATE_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: promote requires latest replay_eval status pass and no safety regressions.";
const PROMOTE_FRESH_EVIDENCE_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: promote requires fresh non-expired evidence links.";
const ADDWEIGHT_CANDIDATE_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: addweight requires an existing shadow candidate.";
const ADDWEIGHT_REASON_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: addweight requires a non-empty reason.";
const ADDWEIGHT_DELTA_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: addweight requires numeric delta in [-1, 1].";
const ADDWEIGHT_ADJUSTMENT_COLLISION_CONTRACT_ERROR =
  "VALIDATION_CONTRACT_VIOLATION: addweight adjustmentId already exists with a different payload.";
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
const EVIDENCE_POINTER_KINDS = new Set([
  "event",
  "episode",
  "signal",
  "artifact",
  "policy",
]);
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
const DEFAULT_UTILITY_SIGNAL_SCORE = 0.5;
const FEEDBACK_UTILITY_SIGNAL_DELTA = Object.freeze({
  helpful: 0.12,
  harmful: -0.18,
});
const OUTCOME_UTILITY_SIGNAL_DELTA = Object.freeze({
  success: 0.08,
  failure: -0.2,
});
const DEFAULT_NEGATIVE_NET_VALUE_DEMOTION_STREAK = 2;
const DEMOTION_REASON_SUSTAINED_NEGATIVE_NET_VALUE =
  "sustained_negative_net_value";
const DEMOTION_REASON_EXPLICIT_HARMFUL_FEEDBACK = "explicit_harmful_feedback";
const DEMOTION_REASON_CANDIDATE_EXPIRED = "candidate_expired";
const DEFAULT_REPLAY_SAFETY_DELTA_THRESHOLD = 0;
const DEFAULT_CANARY_SAFETY_DELTA_THRESHOLD = 0;
const SHADOW_CANDIDATE_CONFIDENCE_DECAY_PER_DAY = 0.01;
const SHADOW_CANDIDATE_CONFIDENCE_FLOOR = 0.05;
const POLICY_AUDIT_EXPORT_FORMATS = new Set(["json", "ndjson", "csv"]);
const POLICY_AUDIT_EXPORT_CSV_COLUMNS = Object.freeze([
  "recordType",
  "recordId",
  "storeId",
  "profile",
  "timestamp",
  "outcome",
  "policyKey",
  "checkId",
  "status",
  "reasonCodes",
  "provenanceEventIds",
  "details",
  "recordDigest",
]);
const POLICY_AUDIT_EXPORT_SIGNATURE_ALGORITHM = "hmac-sha256";
const POLICY_AUDIT_EXPORT_SIGNATURE_VERSION = "1.0.0";
const DEFAULT_STORE_ID = "coding-agent";
const INTERNAL_PROFILE_ID = "__store_default__";
const MEMORY_CONSOLE_ENTITY_TYPES = Object.freeze([
  "learner_profile",
  "identity_graph_edge",
  "misconception",
  "curriculum_plan_item",
  "review_schedule_entry",
  "pain_signal",
  "failure_signal",
  "incident_escalation",
  "manual_override_control",
  "policy_decision",
  "policy_audit_event",
  "shadow_candidate",
  "replay_evaluation",
  "feedback",
  "outcome",
  "degraded_tutor_session",
]);
const MEMORY_CONSOLE_ENTITY_TYPE_SET = new Set(MEMORY_CONSOLE_ENTITY_TYPES);
const MEMORY_CONSOLE_PROVENANCE_ARRAY_KEYS = new Set([
  "evidenceeventids",
  "sourceeventids",
  "provenanceeventids",
  "provenancesignalids",
  "sourcesignalids",
  "conflicteventids",
]);
const MEMORY_CONSOLE_PROVENANCE_SCALAR_KEYS = new Set([
  "evidenceeventid",
  "sourceeventid",
  "provenanceeventid",
  "provenancesignalid",
  "signalid",
]);
const MEMORY_CONSOLE_PROVENANCE_MAX_DEPTH = 4;

function stableSortObject(value: any): any {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableSortObject(value[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: any) {
  return JSON.stringify(stableSortObject(value));
}

function hash(value: any) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(value: any, secret: any) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function resolvePolicyAuditExportSigningConfig() {
  const secret =
    typeof process.env["UMS_POLICY_AUDIT_EXPORT_SIGNING_SECRET"] === "string"
      ? process.env["UMS_POLICY_AUDIT_EXPORT_SIGNING_SECRET"].trim()
      : "";
  if (!secret) {
    throw new Error(
      "SERVICE_MISCONFIGURATION: policy_audit_export signing secret is not configured."
    );
  }
  const configuredKeyId =
    typeof process.env["UMS_POLICY_AUDIT_EXPORT_SIGNING_KEY_ID"] === "string"
      ? process.env["UMS_POLICY_AUDIT_EXPORT_SIGNING_KEY_ID"].trim()
      : "";
  if (!configuredKeyId) {
    throw new Error(
      "SERVICE_MISCONFIGURATION: policy_audit_export signing key id is not configured."
    );
  }
  const keyId = configuredKeyId;
  return {
    keyId,
    secret,
  };
}

function opSeed(operation: any, storeId: any, profile: any, input: any) {
  return hash(stableStringify({ operation, storeId, profile, input }));
}

function makeId(prefix: any, seed: any) {
  return `${prefix}_${seed.slice(0, 12)}`;
}

function requireObject(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
}

function defaultStoreId(value: any) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return DEFAULT_STORE_ID;
}

function defaultProfile() {
  return INTERNAL_PROFILE_ID;
}

function normalizeProfile(value: any) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return defaultProfile();
}

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMetadata(value: any) {
  if (!isPlainObject(value)) {
    return {};
  }
  return stableSortObject(value);
}

interface PolicyPackPlugin {
  name?: string;
  evaluatePolicyDecisionUpdate: (request: unknown) => unknown;
}

function createNoopPolicyPackPlugin(): PolicyPackPlugin {
  return {
    name: "noop-policy-pack-plugin",
    evaluatePolicyDecisionUpdate(_request: unknown) {
      return {
        contractVersion: POLICY_PACK_PLUGIN_CONTRACT_VERSION,
        outcome: "pass",
        reasonCodes: [],
        metadata: {},
      };
    },
  };
}

function normalizePolicyPackPluginName(value: any) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "anonymous-policy-pack-plugin";
}

let policyPackPlugin: PolicyPackPlugin = createNoopPolicyPackPlugin();

function asSortedUniqueStrings(values: any) {
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
  return result.sort((left: any, right: any) => left.localeCompare(right));
}

function mergeStringLists(left: any, right: any) {
  return asSortedUniqueStrings([
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ]);
}

function clamp01(value: any, fallback: any = 0.5) {
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

function normalizeTimestamp(value: any) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeIsoOrDefault(
  value: any,
  fallback: any = "1970-01-01T00:00:00.000Z"
) {
  return normalizeTimestamp(value) ?? fallback;
}

function normalizeIsoTimestamp(
  value: any,
  fieldName: any,
  fallback: any = null
) {
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

function normalizeIsoTimestampOrFallback(
  value: any,
  fallback: any = DEFAULT_VERSION_TIMESTAMP
) {
  try {
    return normalizeIsoTimestamp(value, "timestamp", fallback);
  } catch {
    return fallback;
  }
}

function requireNonEmptyString(value: any, fieldName: any) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function toPositiveInteger(value: any, fallback: any = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function toNonNegativeInteger(value: any, fallback: any = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function hasOwn(input: any, key: any) {
  return Object.hasOwn(input, key);
}

function ensureBoundedCount(
  values: any,
  fieldName: any,
  maxItems: any = MAX_LIST_ITEMS
) {
  if (values.length > maxItems) {
    throw new Error(`${fieldName} may include at most ${maxItems} entries.`);
  }
  return values;
}

function normalizeBoundedString(
  value: any,
  fieldName: any,
  maxLength: any = MAX_SIGNAL_ITEM_LENGTH
) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} must be <= ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeBoundedStringLenient(
  value: any,
  maxLength: any = MAX_SIGNAL_ITEM_LENGTH
) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength);
}

function normalizeBoundedStringArrayLenient(
  values: any,
  maxLength: any = MAX_SIGNAL_ITEM_LENGTH
) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const next = normalizeBoundedStringLenient(value, maxLength);
    if (!next || seen.has(next)) {
      continue;
    }
    seen.add(next);
    normalized.push(next);
    if (normalized.length >= MAX_LIST_ITEMS) {
      break;
    }
  }
  return normalized.sort((left: any, right: any) => left.localeCompare(right));
}

function normalizeBoundedStringArray(
  values: any,
  fieldName: any,
  maxItems: any = MAX_LIST_ITEMS,
  maxLength: any = MAX_SIGNAL_ITEM_LENGTH
) {
  const normalized = asSortedUniqueStrings(values);
  ensureBoundedCount(normalized, fieldName, maxItems);
  for (const entry of normalized) {
    if (entry.length > maxLength) {
      throw new Error(
        `${fieldName} entries must be <= ${maxLength} characters.`
      );
    }
  }
  return normalized;
}

function normalizeGuardedStringArray(
  values: any,
  fieldName: any,
  {
    required = false,
    requiredError = `${fieldName} requires at least one entry.`,
  }: any = {}
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
      throw new Error(
        `${fieldName} entries must be <= ${MAX_SIGNAL_ITEM_LENGTH} characters.`
      );
    }
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
  }
  normalized.sort((left: any, right: any) => left.localeCompare(right));
  ensureBoundedCount(normalized, fieldName);
  if (required && normalized.length === 0) {
    throw new Error(requiredError);
  }
  return normalized;
}

function normalizeDeterministicEnum(
  value: any,
  fieldName: any,
  operation: any,
  allowedValues: any,
  fallback: any
) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(
      `${operation} ${fieldName} must be one of: ${[...allowedValues].sort().join(", ")}.`
    );
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!allowedValues.has(normalized)) {
    throw new Error(
      `${operation} ${fieldName} must be one of: ${[...allowedValues].sort().join(", ")}.`
    );
  }
  return normalized;
}

function normalizeOptionalEmail(value: any) {
  const email = normalizeBoundedString(value, "email", MAX_EMAIL_LENGTH);
  if (!email) {
    return null;
  }
  if (!email.includes("@")) {
    throw new Error("email must include '@'.");
  }
  return email;
}

function normalizeEvidencePointer(rawPointer: any, index: any) {
  const pointer = isPlainObject(rawPointer)
    ? rawPointer
    : { pointerId: rawPointer };
  const pointerId = normalizeBoundedString(
    pointer.pointerId ?? pointer.id ?? pointer.eventId ?? pointer.episodeId,
    `evidencePointers[${index}].pointerId`,
    MAX_SIGNAL_ITEM_LENGTH
  );
  if (!pointerId) {
    throw new Error(
      `evidencePointers[${index}].pointerId must be a non-empty string.`
    );
  }
  const rawKind =
    typeof pointer.kind === "string" ? pointer.kind.trim().toLowerCase() : "";
  const kind = EVIDENCE_POINTER_KINDS.has(rawKind) ? rawKind : "event";
  const source = normalizeBoundedString(
    pointer.source ?? pointer.namespace,
    `evidencePointers[${index}].source`,
    64
  );
  return {
    pointerId,
    kind,
    source: source ?? "unspecified",
    confidence: clamp01(pointer.confidence, 1),
    observedAt: normalizeIsoTimestamp(
      pointer.observedAt ?? pointer.timestamp,
      `evidencePointers[${index}].observedAt`,
      null
    ),
    metadata: normalizeMetadata(pointer.metadata),
  };
}

function normalizeEvidencePointers(values: any) {
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
          : (existing.observedAt ?? normalized.observedAt ?? null),
      metadata: stableSortObject({
        ...existing.metadata,
        ...normalized.metadata,
      }),
    });
  }
  const normalizedPointers = [...pointers.values()].sort(
    (left: any, right: any) => {
      const kindDiff = left.kind.localeCompare(right.kind);
      if (kindDiff !== 0) {
        return kindDiff;
      }
      const sourceDiff = left.source.localeCompare(right.source);
      if (sourceDiff !== 0) {
        return sourceDiff;
      }
      return left.pointerId.localeCompare(right.pointerId);
    }
  );
  return ensureBoundedCount(normalizedPointers, "evidencePointers");
}

function normalizeEvidencePointersFromRequest(request: any, extras: any = []) {
  const eventIds = normalizeBoundedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds"
  );
  const fromEvents = eventIds.map((eventId: any) => ({
    pointerId: eventId,
    kind: "event",
    source: "event_id",
  }));
  const basePointers = normalizeEvidencePointers(request.evidencePointers);
  return normalizeEvidencePointers([
    ...basePointers,
    ...fromEvents,
    ...(Array.isArray(extras) ? extras : []),
  ]);
}

function normalizePolicyException(value: any) {
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
    const normalized = normalizeBoundedString(
      value,
      "policyException",
      MAX_SIGNAL_ITEM_LENGTH
    );
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
    throw new Error(
      "policyException must be an object, string, or boolean true."
    );
  }
  const code = normalizeBoundedString(
    value.code ?? value.reasonCode ?? value.type,
    "policyException.code"
  );
  if (!code) {
    throw new Error("policyException.code must be a non-empty string.");
  }
  const approvedBy = normalizeBoundedString(
    value.approvedBy,
    "policyException.approvedBy",
    128
  );
  return {
    code,
    reason: normalizeBoundedString(value.reason, "policyException.reason", 512),
    approvedBy: approvedBy ?? "unspecified",
    reference: normalizeBoundedString(
      value.reference ?? value.ticket,
      "policyException.reference",
      128
    ),
    timestamp: normalizeIsoTimestamp(
      value.timestamp ?? value.createdAt,
      "policyException.timestamp",
      DEFAULT_VERSION_TIMESTAMP
    ),
    metadata: normalizeMetadata(value.metadata),
  };
}

function normalizeAgentName(value: any) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return CROSS_AGENT_NAMES.has(normalized) ? normalized : null;
}

function normalizeCodexProfileSignal(rawSignal: any) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }
  return {
    agent: "codex",
    goals: normalizeBoundedStringArray(
      rawSignal.learning_goals ?? rawSignal.goals ?? rawSignal.objectives,
      "codex.goals"
    ),
    interestTags: normalizeBoundedStringArray(
      rawSignal.interests ?? rawSignal.interest_tags,
      "codex.interestTags"
    ),
    misconceptionIds: normalizeBoundedStringArray(
      rawSignal.misconceptions ?? rawSignal.misconception_ids,
      "codex.misconceptionIds"
    ),
    profileConfidence: clamp01(
      rawSignal.confidence ?? rawSignal.profile_confidence,
      0.5
    ),
    evidencePointers: normalizeEvidencePointersFromRequest(rawSignal),
    sourceAt: normalizeIsoTimestamp(
      rawSignal.timestamp ?? rawSignal.updatedAt,
      "codex.timestamp",
      DEFAULT_VERSION_TIMESTAMP
    ),
    metadata: normalizeMetadata({
      format: "codex",
      ...rawSignal.metadata,
    }),
  };
}

function normalizeClaudeProfileSignal(rawSignal: any) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }
  return {
    agent: "claude",
    goals: normalizeBoundedStringArray(
      rawSignal.goals ?? rawSignal.learningGoals ?? rawSignal.learning_goals,
      "claude.goals"
    ),
    interestTags: normalizeBoundedStringArray(
      rawSignal.interestTags ?? rawSignal.topic_tags ?? rawSignal.interests,
      "claude.interestTags"
    ),
    misconceptionIds: normalizeBoundedStringArray(
      rawSignal.misconceptionIds ??
        rawSignal.misconceptions ??
        rawSignal.error_patterns,
      "claude.misconceptionIds"
    ),
    profileConfidence: clamp01(
      rawSignal.confidenceScore ??
        rawSignal.confidence ??
        rawSignal.profileConfidence,
      0.5
    ),
    evidencePointers: normalizeEvidencePointersFromRequest(rawSignal),
    sourceAt: normalizeIsoTimestamp(
      rawSignal.timestamp ?? rawSignal.updatedAt,
      "claude.timestamp",
      DEFAULT_VERSION_TIMESTAMP
    ),
    metadata: normalizeMetadata({
      format: "claude",
      ...rawSignal.metadata,
    }),
  };
}

function normalizeProfileSignalsByAgent(request: any) {
  const signals = [];
  const codexSignal = normalizeCodexProfileSignal(
    request.codex ?? request.codexSignal ?? request.codex_profile
  );
  if (codexSignal) {
    signals.push(codexSignal);
  }
  const claudeSignal = normalizeClaudeProfileSignal(
    request.claude ?? request.claudeSignal ?? request.claude_profile
  );
  if (claudeSignal) {
    signals.push(claudeSignal);
  }
  const sourceAgent = normalizeAgentName(
    request.sourceAgent ?? request.agent ?? request.source
  );
  const sourcePayload = isPlainObject(request.sourcePayload)
    ? request.sourcePayload
    : null;
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
      interestTags: mergeStringLists(
        existing.interestTags,
        signal.interestTags
      ),
      misconceptionIds: mergeStringLists(
        existing.misconceptionIds,
        signal.misconceptionIds
      ),
      profileConfidence: signal.profileConfidence,
      evidencePointers: normalizeEvidencePointers([
        ...existing.evidencePointers,
        ...signal.evidencePointers,
      ]),
      sourceAt:
        existing.sourceAt >= signal.sourceAt
          ? existing.sourceAt
          : signal.sourceAt,
      metadata: stableSortObject({
        ...existing.metadata,
        ...signal.metadata,
      }),
    });
  }
  return [...merged.values()].sort((left: any, right: any) =>
    left.agent.localeCompare(right.agent)
  );
}

function normalizeCodexIdentitySignal(rawSignal: any) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }
  const fromRef = normalizeIdentityRef(
    rawSignal.fromRef ?? rawSignal.source_identity ?? rawSignal.source
  );
  const toRef = normalizeIdentityRef(
    rawSignal.toRef ?? rawSignal.target_identity ?? rawSignal.target
  );
  if (fromRef.namespace === "unknown" || fromRef.value === "unknown") {
    return null;
  }
  if (toRef.namespace === "unknown" || toRef.value === "unknown") {
    return null;
  }
  return {
    agent: "codex",
    relation: normalizeIdentityRelation(
      rawSignal.relation ?? rawSignal.link_type
    ),
    fromRef,
    toRef,
    confidence: clamp01(
      rawSignal.confidence ?? rawSignal.confidence_score,
      0.5
    ),
    evidencePointers: normalizeEvidencePointersFromRequest(rawSignal),
    sourceAt: normalizeIsoTimestamp(
      rawSignal.timestamp ?? rawSignal.updatedAt,
      "codexIdentity.timestamp",
      DEFAULT_VERSION_TIMESTAMP
    ),
    metadata: normalizeMetadata({
      format: "codex",
      ...rawSignal.metadata,
    }),
  };
}

function normalizeClaudeIdentitySignal(rawSignal: any) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }
  const fromRef = normalizeIdentityRef(
    rawSignal.fromRef ?? rawSignal.from ?? rawSignal.left
  );
  const toRef = normalizeIdentityRef(
    rawSignal.toRef ?? rawSignal.to ?? rawSignal.right
  );
  if (fromRef.namespace === "unknown" || fromRef.value === "unknown") {
    return null;
  }
  if (toRef.namespace === "unknown" || toRef.value === "unknown") {
    return null;
  }
  return {
    agent: "claude",
    relation: normalizeIdentityRelation(
      rawSignal.relation ?? rawSignal.relation_type
    ),
    fromRef,
    toRef,
    confidence: clamp01(rawSignal.confidence ?? rawSignal.confidenceScore, 0.5),
    evidencePointers: normalizeEvidencePointersFromRequest(rawSignal),
    sourceAt: normalizeIsoTimestamp(
      rawSignal.timestamp ?? rawSignal.updatedAt,
      "claudeIdentity.timestamp",
      DEFAULT_VERSION_TIMESTAMP
    ),
    metadata: normalizeMetadata({
      format: "claude",
      ...rawSignal.metadata,
    }),
  };
}

function normalizeIdentitySignalsByAgent(request: any) {
  const signals = [];
  const codexSignal = normalizeCodexIdentitySignal(
    request.codex ??
      request.codexIdentity ??
      request.codex_identity ??
      request.codexEdge
  );
  if (codexSignal) {
    signals.push(codexSignal);
  }
  const claudeSignal = normalizeClaudeIdentitySignal(
    request.claude ??
      request.claudeIdentity ??
      request.claude_identity ??
      request.claudeEdge
  );
  if (claudeSignal) {
    signals.push(claudeSignal);
  }
  const sourceAgent = normalizeAgentName(
    request.sourceAgent ?? request.agent ?? request.source
  );
  const sourcePayload = isPlainObject(request.sourcePayload)
    ? request.sourcePayload
    : null;
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
  return signals.sort((left: any, right: any) =>
    left.agent.localeCompare(right.agent)
  );
}

function mergeSourceSignals(existingSignals: any, incomingSignals: any) {
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
      normalizeBoundedString(
        rawSignal.signalId,
        "sourceSignals.signalId",
        64
      ) ?? makeId("sig", hash(stableStringify(rawSignal)));
    merged.set(signalId, {
      ...rawSignal,
      signalId,
      metadata: normalizeMetadata(rawSignal.metadata),
    });
  }
  return [...merged.values()].sort((left: any, right: any) =>
    left.signalId.localeCompare(right.signalId)
  );
}

function deriveProfileId(request: any, storeId: any, profile: any) {
  const learnerId =
    typeof request.learnerId === "string" && request.learnerId.trim()
      ? request.learnerId.trim()
      : profile;
  return typeof request.profileId === "string" && request.profileId.trim()
    ? request.profileId.trim()
    : makeId("lp", hash(stableStringify({ storeId, profile, learnerId })));
}

function normalizeIdentityRef(rawRef: any) {
  const ref = isPlainObject(rawRef) ? rawRef : {};
  const namespace =
    typeof ref.namespace === "string" && ref.namespace.trim()
      ? ref.namespace.trim()
      : "unknown";
  const value =
    typeof ref.value === "string" && ref.value.trim()
      ? ref.value.trim()
      : "unknown";

  return {
    namespace,
    value,
    verified: Boolean(ref.verified),
    isPrimary: Boolean(ref.isPrimary),
    lastSeenAt: normalizeIsoTimestamp(
      ref.lastSeenAt,
      "identityRef.lastSeenAt",
      null
    ),
    metadata: normalizeMetadata(ref.metadata),
  };
}

function normalizeIdentityRefs(values: any) {
  if (!Array.isArray(values)) {
    return [];
  }
  ensureBoundedCount(values, "identityRefs", MAX_IDENTITY_REFS);

  const refs = new Map();
  for (const rawRef of values) {
    const normalized = normalizeIdentityRef(rawRef);
    if (normalized.namespace.length > MAX_IDENTITY_VALUE_LENGTH) {
      throw new Error(
        `identityRefs.namespace must be <= ${MAX_IDENTITY_VALUE_LENGTH} characters.`
      );
    }
    if (normalized.value.length > MAX_IDENTITY_VALUE_LENGTH) {
      throw new Error(
        `identityRefs.value must be <= ${MAX_IDENTITY_VALUE_LENGTH} characters.`
      );
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
          : (existing.lastSeenAt ?? normalized.lastSeenAt ?? null),
      metadata: stableSortObject({
        ...existing.metadata,
        ...normalized.metadata,
      }),
    });
  }

  const normalizedRefs = [...refs.values()].sort((left: any, right: any) => {
    const namespaceDiff = left.namespace.localeCompare(right.namespace);
    if (namespaceDiff !== 0) {
      return namespaceDiff;
    }
    return left.value.localeCompare(right.value);
  });

  if (
    normalizedRefs.length > 0 &&
    !normalizedRefs.some((ref: any) => ref.isPrimary)
  ) {
    normalizedRefs[0] = {
      ...normalizedRefs[0],
      isPrimary: true,
    };
  }

  return normalizedRefs;
}

function normalizeLearnerProfileUpdateRequest(
  request: any,
  storeId: any,
  profile: any
) {
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
    requestedIdentityRefs.length > 0
      ? requestedIdentityRefs
      : normalizeIdentityRefs([fallbackIdentity]);
  const canonicalIdentity =
    identityRefs.find((ref: any) => ref.isPrimary) ?? identityRefs[0];
  const profileId =
    typeof request.profileId === "string" && request.profileId.trim()
      ? request.profileId.trim()
      : makeId(
          "lp",
          hash(
            stableStringify({ storeId, profile, learnerId, canonicalIdentity })
          )
        );
  const normalizedSignals = sourceSignals.map((signal: any) => ({
    ...signal,
    signalId: makeId("sig", hash(stableStringify(signal))),
  }));
  const signalGoals = normalizedSignals.flatMap((signal: any) => signal.goals);
  const signalInterestTags = normalizedSignals.flatMap(
    (signal: any) => signal.interestTags
  );
  const signalMisconceptionIds = normalizedSignals.flatMap(
    (signal: any) => signal.misconceptionIds
  );
  const signalEvidencePointers = normalizedSignals.flatMap(
    (signal: any) => signal.evidencePointers
  );
  const confidenceOverrides = normalizedSignals.map(
    (signal: any) => signal.profileConfidence
  );
  const policyException = normalizePolicyException(
    request.policyException ??
      request.policy_exception ??
      (request.allowWithoutEvidence ? true : null)
  );
  const evidencePointers = normalizeEvidencePointersFromRequest(
    request,
    signalEvidencePointers
  );
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
      hasOwn(request, "interestTags") || signalInterestTags.length > 0
        ? "interestTags"
        : null,
      hasOwn(request, "misconceptionIds") || signalMisconceptionIds.length > 0
        ? "misconceptionIds"
        : null,
      hasOwn(request, "metadata") ? "metadata" : null,
    ].filter(Boolean)
  );
  const displayName = normalizeBoundedString(
    request.displayName,
    "displayName",
    MAX_DISPLAY_NAME_LENGTH
  );
  const createdAt = normalizeIsoTimestamp(
    request.createdAt ?? request.timestamp,
    "learner_profile_update.createdAt",
    DEFAULT_VERSION_TIMESTAMP
  );
  const updatedAt = normalizeIsoTimestamp(
    request.updatedAt ?? request.timestamp,
    "learner_profile_update.updatedAt",
    createdAt
  );
  const profileConfidence =
    confidenceOverrides.length > 0
      ? confidenceOverrides.at(-1)
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
      "goals"
    ),
    interestTags: normalizeBoundedStringArray(
      [
        ...normalizeBoundedStringArray(request.interestTags, "interestTags"),
        ...signalInterestTags,
      ],
      "interestTags"
    ),
    misconceptionIds: normalizeBoundedStringArray(
      [
        ...normalizeBoundedStringArray(
          request.misconceptionIds,
          "misconceptionIds"
        ),
        ...signalMisconceptionIds,
      ],
      "misconceptionIds"
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

function normalizeLineageEntry(
  attribute: any,
  value: any,
  timestamp: any,
  evidencePointers: any,
  policyException: any
) {
  const normalizedTimestamp = normalizeIsoTimestamp(
    timestamp,
    `learner_profile_update.attributeLineage.${attribute}.timestamp`,
    DEFAULT_VERSION_TIMESTAMP
  );
  const normalizedValue = stableSortObject(value === undefined ? null : value);
  const valueDigest = hash(stableStringify(normalizedValue));
  const evidencePointerIds = normalizeBoundedStringArray(
    (Array.isArray(evidencePointers) ? evidencePointers : []).map(
      (pointer: any) => pointer.pointerId
    ),
    `attributeLineage.${attribute}.evidencePointerIds`
  );
  const policyExceptionCode = policyException?.code ?? null;
  const lineageSeed = hash(
    stableStringify({
      attribute,
      timestamp: normalizedTimestamp,
      valueDigest,
      evidencePointerIds,
      policyExceptionCode,
    })
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

function compareLineageEntries(left: any, right: any) {
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

function appendLineageEntry(existingEntries: any, entry: any) {
  const entries = Array.isArray(existingEntries) ? [...existingEntries] : [];
  if (
    !entries.some(
      (candidate: any) => candidate?.revisionId === entry.revisionId
    )
  ) {
    entries.push(entry);
  }
  return entries.sort(compareLineageEntries);
}

function mergeLearnerProfile(
  existing: any,
  incoming: any,
  operationAction: any
) {
  const base = {
    ...existing,
    learnerId: incoming.learnerId,
    status: incoming.status,
    version: Math.max(existing.version ?? 1, incoming.version),
    profileConfidence: incoming.profileConfidence,
    displayName: incoming.displayName ?? existing.displayName ?? null,
    email: incoming.email ?? existing.email ?? null,
    goals: mergeStringLists(existing.goals, incoming.goals),
    interestTags: mergeStringLists(
      existing.interestTags,
      incoming.interestTags
    ),
    misconceptionIds: mergeStringLists(
      existing.misconceptionIds,
      incoming.misconceptionIds
    ),
    identityRefs: normalizeIdentityRefs([
      ...(existing.identityRefs ?? []),
      ...(incoming.identityRefs ?? []),
    ]),
    metadata: stableSortObject({
      ...existing.metadata,
      ...incoming.metadata,
    }),
    evidencePointers: normalizeEvidencePointers([
      ...(existing.evidencePointers ?? []),
      ...(incoming.evidencePointers ?? []),
    ]),
    policyException:
      incoming.policyException ?? existing.policyException ?? null,
    sourceSignals: mergeSourceSignals(
      existing.sourceSignals,
      incoming.sourceSignals
    ),
    createdAt:
      existing.createdAt ?? incoming.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
    updatedAt:
      incoming.updatedAt ?? existing.updatedAt ?? DEFAULT_VERSION_TIMESTAMP,
  };

  const timelineTimestamp = base.updatedAt ?? DEFAULT_VERSION_TIMESTAMP;
  const provided = new Set(incoming.providedAttributes);
  const lineage = isPlainObject(existing.attributeLineage)
    ? { ...existing.attributeLineage }
    : {};
  const attributeTruth = isPlainObject(existing.attributeTruth)
    ? { ...existing.attributeTruth }
    : {};

  for (const attribute of PROFILE_LINEAGE_ATTRIBUTES) {
    const existingCurrentValue = existing[attribute];
    const currentValue = hasOwn(base, attribute) ? base[attribute] : null;
    const existingTruthEntry = isPlainObject(attributeTruth[attribute])
      ? attributeTruth[attribute]
      : null;
    const existingRevision = normalizeLineageEntry(
      attribute,
      existingCurrentValue,
      existingTruthEntry?.timestamp ??
        existing.updatedAt ??
        existing.createdAt ??
        DEFAULT_VERSION_TIMESTAMP,
      existing.evidencePointers ?? [],
      existing.policyException
    );
    const incomingRevision = normalizeLineageEntry(
      attribute,
      incoming[attribute],
      incoming.updatedAt ?? timelineTimestamp,
      incoming.evidencePointers ?? [],
      incoming.policyException
    );

    let winner = existingRevision;
    let entries = appendLineageEntry(lineage[attribute], existingRevision);
    if (operationAction === "created") {
      entries = appendLineageEntry(entries, incomingRevision);
      winner = incomingRevision;
      base[attribute] = incomingRevision.value;
    } else if (provided.has(attribute)) {
      entries = appendLineageEntry(entries, incomingRevision);
      winner =
        compareLineageEntries(incomingRevision, existingRevision) >= 0
          ? incomingRevision
          : existingRevision;
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
const CURRICULUM_STATUSES = new Set([
  "proposed",
  "committed",
  "blocked",
  "completed",
]);
const REVIEW_STATUSES = new Set(["scheduled", "due", "completed", "suspended"]);
const POLICY_OUTCOMES = new Set(["allow", "review", "deny"]);
const PAIN_SIGNAL_TYPES = new Set([
  "harmful",
  "thumbs_down",
  "human_rewrite",
  "wrong_answer",
  "manual_correction",
]);
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
const INCIDENT_ESCALATION_SEVERITIES = new Set([
  "low",
  "medium",
  "high",
  "severe",
  "critical",
]);
const INCIDENT_ESCALATION_IMMEDIATE_QUARANTINE_SEVERITIES = new Set([
  "severe",
  "critical",
]);
const MANUAL_OVERRIDE_ACTIONS = new Set(["suppress", "promote"]);
const CLOCK_MODES = new Set(["auto", "interaction", "sleep"]);
const RECALL_AUTH_MODES = new Set(["check", "grant", "revoke", "replace"]);

const INJECTION_PATTERNS = Object.freeze([
  {
    code: "prompt_override_ignore_previous",
    pattern:
      /ignore (all |any |the )?(previous|prior|above) (instructions|prompts|rules)/i,
  },
  {
    code: "prompt_override_system_prompt",
    pattern: /(reveal|show|dump).*(system|developer).*(prompt|instruction)/i,
  },
  {
    code: "prompt_override_privilege_escalation",
    pattern:
      /(bypass|override|disable).*(safety|guardrail|policy|restriction)/i,
  },
  {
    code: "prompt_override_exfiltration",
    pattern: /(exfiltrate|leak|expose).*(secret|token|credential|password)/i,
  },
  {
    code: "prompt_override_instruction_hijack",
    pattern: /you are now|act as|pretend to be/i,
  },
  { code: "prompt_override_execution", pattern: /<script|javascript:|eval\(/i },
]);

function normalizeIdentityRelation(value: any) {
  if (typeof value !== "string") {
    return "alias_of";
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "alias_of";
  }
  return IDENTITY_RELATIONS.has(normalized) ? normalized : "alias_of";
}

function normalizeIdentityGraphUpdateRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const sourceSignals = normalizeIdentitySignalsByAgent(request);
  const learnerId =
    normalizeBoundedString(request.learnerId, "learnerId") ?? profile;
  const profileId =
    typeof request.profileId === "string" && request.profileId.trim()
      ? request.profileId.trim()
      : makeId("lp", hash(stableStringify({ storeId, profile, learnerId })));
  const firstSignal = sourceSignals[0] ?? null;
  const relation = normalizeIdentityRelation(
    request.relation ?? firstSignal?.relation
  );
  const fromRef = normalizeIdentityRef(request.fromRef ?? firstSignal?.fromRef);
  const toRef = normalizeIdentityRef(request.toRef ?? firstSignal?.toRef);
  if (fromRef.namespace === "unknown" || fromRef.value === "unknown") {
    throw new Error(
      "identity_graph_update requires fromRef.namespace and fromRef.value."
    );
  }
  if (toRef.namespace === "unknown" || toRef.value === "unknown") {
    throw new Error(
      "identity_graph_update requires toRef.namespace and toRef.value."
    );
  }
  if (fromRef.namespace === toRef.namespace && fromRef.value === toRef.value) {
    throw new Error("Identity graph edge endpoints must be distinct.");
  }
  const signalEvidence = sourceSignals.flatMap(
    (signal: any) => signal.evidencePointers
  );
  const evidencePointers = normalizeEvidencePointersFromRequest(
    request,
    signalEvidence
  );
  const evidenceEventIds = normalizeBoundedStringArray(
    [
      ...normalizeBoundedStringArray(
        request.evidenceEventIds ?? request.evidenceEpisodeIds,
        "evidenceEventIds"
      ),
      ...evidencePointers
        .filter(
          (pointer: any) =>
            pointer.kind === "event" || pointer.kind === "episode"
        )
        .map((pointer: any) => pointer.pointerId),
    ],
    "evidenceEventIds"
  );
  const createdAt = normalizeIsoTimestamp(
    request.createdAt ?? request.timestamp ?? firstSignal?.sourceAt,
    "identity_graph_update.createdAt",
    DEFAULT_VERSION_TIMESTAMP
  );
  const updatedAt = normalizeIsoTimestamp(
    request.updatedAt ?? request.timestamp ?? firstSignal?.sourceAt,
    "identity_graph_update.updatedAt",
    createdAt
  );

  const edgeId =
    typeof request.edgeId === "string" && request.edgeId.trim()
      ? request.edgeId.trim()
      : makeId(
          "edge",
          hash(
            stableStringify({
              storeId,
              profile,
              profileId,
              relation,
              fromRef,
              toRef,
            })
          )
        );

  return {
    edgeId,
    profileId,
    relation,
    fromRef,
    toRef,
    confidence: clamp01(request.confidence ?? firstSignal?.confidence, 0.5),
    evidencePointers,
    evidenceEventIds,
    sourceSignals: sourceSignals.map((signal: any) => ({
      ...signal,
      signalId: makeId("sig", hash(stableStringify(signal))),
    })),
    metadata: normalizeMetadata(request.metadata),
    createdAt,
    updatedAt,
  };
}

function mergeIdentityGraphEdge(existing: any, incoming: any) {
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
    evidenceEventIds: mergeStringLists(
      existing.evidenceEventIds,
      incoming.evidenceEventIds
    ),
    sourceSignals: mergeSourceSignals(
      existing.sourceSignals,
      incoming.sourceSignals
    ),
    metadata: stableSortObject({
      ...existing.metadata,
      ...incoming.metadata,
    }),
    createdAt:
      existing.createdAt ?? incoming.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
    updatedAt:
      incoming.updatedAt ?? existing.updatedAt ?? DEFAULT_VERSION_TIMESTAMP,
  };
}

function normalizeMisconceptionUpdateRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const profileId = deriveProfileId(request, storeId, profile);
  const misconceptionKey = requireNonEmptyString(
    request.misconceptionKey,
    "misconceptionKey"
  );
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    { required: true, requiredError: MISCONCEPTION_EVIDENCE_CONTRACT_ERROR }
  );
  const signal = normalizeDeterministicEnum(
    request.signal,
    "signal",
    "misconception_update",
    MISCONCEPTION_SIGNALS,
    "harmful"
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
            })
          )
        );
  const misconceptionId =
    typeof request.misconceptionId === "string" &&
    request.misconceptionId.trim()
      ? request.misconceptionId.trim()
      : makeId(
          "mis",
          hash(stableStringify({ storeId, profileId, misconceptionKey }))
        );
  const createdAt = normalizeIsoOrDefault(
    request.createdAt ?? request.timestamp
  );
  const updatedAt = normalizeIsoOrDefault(
    request.updatedAt ?? request.timestamp,
    createdAt
  );
  const requestedStatus = normalizeDeterministicEnum(
    request.status,
    "status",
    "misconception_update",
    MISCONCEPTION_STATUSES,
    "active"
  );
  const status = requestedStatus === "suppressed" ? "suppressed" : "active";
  const confidence = clamp01(
    request.confidence,
    signal === "harmful" ? 0.35 : 0.65
  );
  const metadata = normalizeMetadata({
    ...normalizeMetadata(request.metadata),
    note: note || undefined,
  });
  const severity = clamp01(metadata.severity, 0);
  const confidenceDecay = resolveMisconceptionConfidenceShift(
    signal,
    signal === "harmful" ? 1 : 0,
    severity
  );
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

function mergeMisconceptionRecord(existing: any, incoming: any) {
  const seenSignal = (existing.sourceSignalIds ?? []).includes(
    incoming.signalId
  );
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
  const confidenceDecay = resolveMisconceptionConfidenceShift(
    incoming.signal,
    harmfulSignalCount,
    signalSeverity
  );
  const confidenceBase = clamp01(
    (existing.confidence ?? 0.5) + confidenceDecay.delta,
    existing.confidence ?? 0.5
  );
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
  const evidenceEventIds = mergeStringLists(
    existing.evidenceEventIds,
    incoming.evidenceEventIds
  );
  const sourceSignalIds = mergeStringLists(
    existing.sourceSignalIds,
    incoming.sourceSignalIds
  );
  const antiPatterns = buildMisconceptionAntiPatterns({
    misconceptionId: existing.misconceptionId ?? incoming.misconceptionId,
    misconceptionKey: incoming.misconceptionKey,
    harmfulSignalCount,
    evidenceEventIds,
    sourceSignalIds,
    updatedAt:
      incoming.updatedAt ?? existing.updatedAt ?? DEFAULT_VERSION_TIMESTAMP,
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
    conflictEventIds: mergeStringLists(
      existing.conflictEventIds,
      incoming.conflictEventIds
    ),
    metadata: stableSortObject({
      ...existing.metadata,
      ...incoming.metadata,
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

function normalizeCurriculumPlanUpdateRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const profileId = deriveProfileId(request, storeId, profile);
  const objectiveId = requireNonEmptyString(request.objectiveId, "objectiveId");
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    { required: true, requiredError: CURRICULUM_EVIDENCE_CONTRACT_ERROR }
  );
  const status = normalizeDeterministicEnum(
    request.status,
    "status",
    "curriculum_plan_update",
    CURRICULUM_STATUSES,
    "proposed"
  );
  const recommendationRank = toPositiveInteger(
    request.recommendationRank ?? request.rank,
    1
  );
  const planItemId =
    typeof request.planItemId === "string" && request.planItemId.trim()
      ? request.planItemId.trim()
      : makeId(
          "cp",
          hash(stableStringify({ storeId, profileId, objectiveId }))
        );
  const createdAt = normalizeIsoOrDefault(
    request.createdAt ?? request.timestamp
  );
  const updatedAt = normalizeIsoOrDefault(
    request.updatedAt ?? request.timestamp,
    createdAt
  );
  const dueAt = normalizeIsoOrDefault(
    request.dueAt ?? request.targetAt ?? createdAt,
    createdAt
  );

  return {
    planItemId,
    profileId,
    objectiveId,
    status,
    recommendationRank,
    dueAt,
    sourceMisconceptionIds: asSortedUniqueStrings(
      request.sourceMisconceptionIds
    ),
    interestTags: asSortedUniqueStrings(request.interestTags),
    evidenceEventIds,
    provenanceSignalIds: asSortedUniqueStrings(
      request.provenanceSignalIds ?? request.sourceSignalIds
    ),
    metadata: normalizeMetadata(request.metadata),
    createdAt,
    updatedAt,
  };
}

function mergeCurriculumPlanItem(existing: any, incoming: any) {
  return {
    ...existing,
    profileId: incoming.profileId,
    objectiveId: incoming.objectiveId,
    status: existing.status === "blocked" ? "blocked" : incoming.status,
    recommendationRank: Math.min(
      existing.recommendationRank ?? 1,
      incoming.recommendationRank ?? 1
    ),
    dueAt: incoming.dueAt ?? existing.dueAt,
    sourceMisconceptionIds: mergeStringLists(
      existing.sourceMisconceptionIds,
      incoming.sourceMisconceptionIds
    ),
    interestTags: mergeStringLists(
      existing.interestTags,
      incoming.interestTags
    ),
    evidenceEventIds: mergeStringLists(
      existing.evidenceEventIds,
      incoming.evidenceEventIds
    ),
    provenanceSignalIds: mergeStringLists(
      existing.provenanceSignalIds,
      incoming.provenanceSignalIds
    ),
    metadata: stableSortObject({
      ...existing.metadata,
      ...incoming.metadata,
    }),
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
}

function normalizeReviewScheduleUpdateRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const profileId = deriveProfileId(request, storeId, profile);
  const targetId = requireNonEmptyString(request.targetId, "targetId");
  const sourceEventIds = normalizeGuardedStringArray(
    request.sourceEventIds,
    "sourceEventIds",
    {
      required: true,
      requiredError: REVIEW_SOURCE_EVENT_CONTRACT_ERROR,
    }
  );
  const status = normalizeDeterministicEnum(
    request.status,
    "status",
    "review_schedule_update",
    REVIEW_STATUSES,
    "scheduled"
  );
  const createdAt = normalizeIsoOrDefault(
    request.createdAt ?? request.timestamp
  );
  const updatedAt = normalizeIsoOrDefault(
    request.updatedAt ?? request.timestamp,
    createdAt
  );
  const dueAt = normalizeIsoOrDefault(request.dueAt ?? createdAt, createdAt);
  const scheduleEntryId =
    typeof request.scheduleEntryId === "string" &&
    request.scheduleEntryId.trim()
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
    evidenceEventIds: asSortedUniqueStrings(
      request.evidenceEventIds ?? request.evidenceEpisodeIds
    ),
    metadata: normalizeMetadata(request.metadata),
    createdAt,
    updatedAt,
  };
}

function mergeReviewScheduleEntry(existing: any, incoming: any) {
  return {
    ...existing,
    profileId: incoming.profileId,
    targetId: incoming.targetId,
    status: incoming.status,
    repetition: Math.max(existing.repetition ?? 0, incoming.repetition ?? 0),
    intervalDays: incoming.intervalDays ?? existing.intervalDays,
    easeFactor: incoming.easeFactor ?? existing.easeFactor,
    dueAt: incoming.dueAt ?? existing.dueAt,
    sourceEventIds: mergeStringLists(
      existing.sourceEventIds,
      incoming.sourceEventIds
    ),
    evidenceEventIds: mergeStringLists(
      existing.evidenceEventIds,
      incoming.evidenceEventIds
    ),
    metadata: stableSortObject({
      ...existing.metadata,
      ...incoming.metadata,
    }),
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
}

function normalizePolicyPackPluginResponse(response: any) {
  if (!isPlainObject(response)) {
    throw new Error("policy pack plugin response must be an object.");
  }
  const contractVersion = normalizeBoundedStringLenient(
    response.contractVersion,
    16
  );
  if (contractVersion !== POLICY_PACK_PLUGIN_CONTRACT_VERSION) {
    throw new Error(
      `policy pack plugin response contractVersion must be '${POLICY_PACK_PLUGIN_CONTRACT_VERSION}'.`
    );
  }
  const outcome = normalizeBoundedStringLenient(response.outcome, 16);
  if (outcome !== "pass" && outcome !== "deny") {
    throw new Error(
      "policy pack plugin response outcome must be either 'pass' or 'deny'."
    );
  }
  const reasonCodes = normalizeBoundedStringArray(
    response.reasonCodes,
    "policyPackPlugin.reasonCodes"
  );
  if (outcome === "deny" && reasonCodes.length === 0) {
    throw new Error("policy pack plugin deny outcome requires reasonCodes.");
  }
  return {
    contractVersion,
    outcome,
    reasonCodes: outcome === "deny" ? reasonCodes : [],
    metadata: normalizeMetadata(response.metadata),
  };
}

function toPolicyPackPluginFailureMessage(error: any, fallback: any) {
  if (error instanceof Error) {
    return normalizeBoundedStringLenient(error.message, 256) ?? fallback;
  }
  if (typeof error === "string") {
    return normalizeBoundedStringLenient(error, 256) ?? fallback;
  }
  return fallback;
}

function toFailClosedPolicyPackInvocation(
  pluginName: any,
  reasonCode: any,
  failureMessage: any
) {
  return {
    pluginName,
    contractVersion: POLICY_PACK_PLUGIN_CONTRACT_VERSION,
    status: "fail_closed",
    outcome: "deny",
    reasonCodes: [reasonCode],
    failureCode: reasonCode,
    failureMessage,
    metadata: {},
  };
}

function resolvePolicyPackPluginRawResponse(rawResponse: any) {
  if (Effect.isEffect(rawResponse)) {
    return Effect.runSync(
      rawResponse as Effect.Effect<unknown, unknown, never>
    );
  }
  if (rawResponse && typeof rawResponse.then === "function") {
    throw new Error(
      "policy pack plugin promises are not supported; return a synchronous response or Effect.sync."
    );
  }
  return rawResponse;
}

function invokePolicyPackPluginForDecisionUpdate(storeId: any, incoming: any) {
  const activePlugin = policyPackPlugin;
  const pluginName = normalizePolicyPackPluginName(activePlugin?.name);
  const request = {
    contractVersion: POLICY_PACK_PLUGIN_CONTRACT_VERSION,
    operation: "policy_decision_update",
    storeId,
    profileId: incoming.profileId,
    decisionId: incoming.decisionId,
    policyKey: incoming.policyKey,
    action: incoming.action,
    surface: incoming.surface,
    outcome: incoming.outcome,
    reasonCodes: [...incoming.reasonCodes],
    provenanceEventIds: [...incoming.provenanceEventIds],
    evidenceEventIds: [...incoming.evidenceEventIds],
    metadata: normalizeMetadata(incoming.metadata),
    createdAt: incoming.createdAt,
    updatedAt: incoming.updatedAt,
  };

  let rawResponse;
  try {
    rawResponse = activePlugin.evaluatePolicyDecisionUpdate(request);
    rawResponse = resolvePolicyPackPluginRawResponse(rawResponse);
  } catch (error) {
    return toFailClosedPolicyPackInvocation(
      pluginName,
      POLICY_PACK_PLUGIN_FAIL_CLOSED_FAILURE_REASON_CODE,
      toPolicyPackPluginFailureMessage(error, "policy pack plugin threw.")
    );
  }

  let normalizedResponse;
  try {
    normalizedResponse = normalizePolicyPackPluginResponse(rawResponse);
  } catch (error) {
    return toFailClosedPolicyPackInvocation(
      pluginName,
      POLICY_PACK_PLUGIN_FAIL_CLOSED_CONTRACT_REASON_CODE,
      toPolicyPackPluginFailureMessage(
        error,
        "policy pack plugin contract validation failed."
      )
    );
  }

  return {
    pluginName,
    contractVersion: normalizedResponse.contractVersion,
    status: "executed",
    outcome: normalizedResponse.outcome,
    reasonCodes: normalizedResponse.reasonCodes,
    failureCode: null,
    failureMessage: null,
    metadata: normalizedResponse.metadata,
  };
}

function applyPolicyPackInvocationToDecision(incoming: any, invocation: any) {
  const enforcedOutcome =
    invocation.status === "fail_closed" || invocation.outcome === "deny"
      ? "deny"
      : incoming.outcome;
  const reasonCodes =
    enforcedOutcome === "deny"
      ? mergeStringLists(incoming.reasonCodes, invocation.reasonCodes)
      : incoming.reasonCodes;

  return {
    ...incoming,
    outcome: enforcedOutcome,
    reasonCodes,
    metadata: stableSortObject({
      ...incoming.metadata,
      policyPackPlugin: {
        pluginName: invocation.pluginName,
        contractVersion: invocation.contractVersion,
        status: invocation.status,
        outcome: invocation.outcome,
        reasonCodes: invocation.reasonCodes,
        failureCode: invocation.failureCode,
        failureMessage: invocation.failureMessage,
        metadata: invocation.metadata,
      },
    }),
  };
}

function toPolicyPackPluginAuditMetadata(invocation: any) {
  return stableSortObject({
    pluginName: invocation.pluginName,
    contractVersion: invocation.contractVersion,
    status: invocation.status,
    outcome: invocation.outcome,
    reasonCodes: invocation.reasonCodes,
    failureCode: invocation.failureCode,
    failureMessage: invocation.failureMessage,
  });
}

function normalizePolicyDecisionUpdateRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const profileId = deriveProfileId(request, storeId, profile);
  const policyKey = requireNonEmptyString(request.policyKey, "policyKey");
  const action =
    typeof request.action === "string" && request.action.trim()
      ? request.action.trim()
      : "evaluate";
  const surface =
    typeof request.surface === "string" && request.surface.trim()
      ? request.surface.trim()
      : "general";
  const outcome = normalizeDeterministicEnum(
    request.outcome,
    "outcome",
    "policy_decision_update",
    POLICY_OUTCOMES,
    "review"
  );
  const reasonCodes = normalizeGuardedStringArray(
    request.reasonCodes,
    "reasonCodes"
  );
  if (outcome === "deny" && reasonCodes.length === 0) {
    throw new Error(POLICY_REASON_CODES_CONTRACT_ERROR);
  }
  const provenanceEventIds = normalizeGuardedStringArray(
    request.provenanceEventIds,
    "provenanceEventIds",
    {
      required: true,
      requiredError: POLICY_PROVENANCE_EVENT_CONTRACT_ERROR,
    }
  );
  const decisionId =
    typeof request.decisionId === "string" && request.decisionId.trim()
      ? request.decisionId.trim()
      : makeId(
          "pol",
          hash(
            stableStringify({ storeId, profileId, policyKey, surface, action })
          )
        );
  const createdAt = normalizeIsoOrDefault(
    request.createdAt ?? request.timestamp
  );
  const updatedAt = normalizeIsoOrDefault(
    request.updatedAt ?? request.timestamp,
    createdAt
  );

  return {
    decisionId,
    profileId,
    policyKey,
    action,
    surface,
    outcome,
    reasonCodes,
    provenanceEventIds,
    evidenceEventIds: asSortedUniqueStrings(
      request.evidenceEventIds ?? request.evidenceEpisodeIds
    ),
    metadata: normalizeMetadata(request.metadata),
    createdAt,
    updatedAt,
  };
}

function mergePolicyDecision(existing: any, incoming: any) {
  const severity = {
    allow: 1,
    review: 2,
    deny: 3,
  } as const;
  const existingOutcome =
    normalizeBoundedStringLenient(existing.outcome, 16)?.toLowerCase() ??
    "review";
  const incomingOutcome =
    normalizeBoundedStringLenient(incoming.outcome, 16)?.toLowerCase() ??
    "review";
  const normalizedExistingOutcome =
    existingOutcome in severity
      ? (existingOutcome as keyof typeof severity)
      : "review";
  const normalizedIncomingOutcome =
    incomingOutcome in severity
      ? (incomingOutcome as keyof typeof severity)
      : "review";
  const outcome =
    severity[normalizedExistingOutcome] >= severity[normalizedIncomingOutcome]
      ? normalizedExistingOutcome
      : normalizedIncomingOutcome;

  return {
    ...existing,
    profileId: incoming.profileId,
    policyKey: incoming.policyKey,
    action: incoming.action,
    surface: incoming.surface,
    outcome,
    reasonCodes: mergeStringLists(existing.reasonCodes, incoming.reasonCodes),
    provenanceEventIds: mergeStringLists(
      existing.provenanceEventIds,
      incoming.provenanceEventIds
    ),
    evidenceEventIds: mergeStringLists(
      existing.evidenceEventIds,
      incoming.evidenceEventIds
    ),
    metadata: stableSortObject({
      ...existing.metadata,
      ...incoming.metadata,
    }),
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
}

function getStoreProfiles(storeId: any) {
  const existing = stores.get(storeId);
  if (existing) {
    return existing;
  }
  const created = new Map();
  stores.set(storeId, created);
  return created;
}

function getProfileState(storeId: any, profile: any) {
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
    incidentEscalations: [],
    manualOverrideControls: [],
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
    weightAdjustmentLedger: [],
    shadowCandidates: [],
    replayEvaluations: [],
  };
  profiles.set(profile, created);
  return created;
}

function normalizeEvent(raw: any, index: any) {
  const event = raw && typeof raw === "object" ? raw : {};
  const explicitEventId =
    typeof event.id === "string" && event.id.trim().length > 0
      ? event.id.trim()
      : null;
  const dedupeMaterial = stableStringify({
    source: event.source ?? "unknown",
    type: event.type ?? "note",
    content: event.content ?? "",
    eventId: explicitEventId,
  });
  const material = stableStringify({
    source: event.source ?? "unknown",
    type: event.type ?? "note",
    content: event.content ?? "",
    ordinal: index,
  });
  const dedupeDigest = hash(dedupeMaterial);
  const digest = hash(material);
  return {
    eventId: explicitEventId ?? makeId("evt", digest),
    type: event.type ?? "note",
    source: event.source ?? "unknown",
    content: event.content ?? "",
    dedupeDigest,
    digest,
  };
}

function normalizeRuleCandidate(raw: any) {
  const candidate = raw && typeof raw === "object" ? raw : {};
  const statement =
    typeof candidate.statement === "string" ? candidate.statement.trim() : "";
  const source =
    typeof candidate.sourceEventId === "string"
      ? candidate.sourceEventId
      : "unknown";
  const material = stableStringify({ statement, source });
  const digest = hash(material);
  return {
    candidateId: makeId("cand", digest),
    statement,
    sourceEventId: source,
    confidence: Number.isFinite(candidate.confidence)
      ? Number(candidate.confidence)
      : 0.5,
  };
}

function normalizeShadowCandidate(
  rawCandidate: any,
  request: any,
  storeId: any,
  profile: any,
  timestamp: any
) {
  const candidate = isPlainObject(rawCandidate) ? rawCandidate : {};
  const statement =
    normalizeBoundedString(
      candidate.statement ?? request.statement,
      "shadow_write.statement",
      1024
    ) ?? "";
  if (!statement) {
    throw new Error(
      "shadow_write requires candidate.statement to be a non-empty string."
    );
  }

  const requestedSourceEventIds =
    candidate.sourceEventIds ??
    (candidate.sourceEventId ? [candidate.sourceEventId] : null) ??
    request.sourceEventIds ??
    (request.sourceEventId ? [request.sourceEventId] : null) ??
    request.evidenceEventIds ??
    request.evidenceEpisodeIds;
  const sourceEventIds = normalizeGuardedStringArray(
    requestedSourceEventIds,
    "sourceEventIds",
    {
      required: true,
      requiredError: SHADOW_WRITE_EVIDENCE_CONTRACT_ERROR,
    }
  );

  const requestedEvidenceEventIds =
    candidate.evidenceEventIds ??
    candidate.evidenceEpisodeIds ??
    request.evidenceEventIds ??
    request.evidenceEpisodeIds ??
    sourceEventIds;
  const evidenceEventIds = normalizeGuardedStringArray(
    requestedEvidenceEventIds,
    "evidenceEventIds",
    {
      required: true,
      requiredError: SHADOW_WRITE_EVIDENCE_CONTRACT_ERROR,
    }
  );

  const scope =
    normalizeBoundedString(
      candidate.scope ?? request.scope,
      "shadow_write.scope",
      128
    ) ?? "global";
  const confidence = clamp01(candidate.confidence ?? request.confidence, 0.5);
  const policyException = normalizePolicyException(
    candidate.policyException ?? request.policyException ?? null
  );
  const createdAt = normalizeIsoTimestamp(
    candidate.createdAt ??
      candidate.timestamp ??
      request.createdAt ??
      request.timestamp,
    "shadow_write.createdAt",
    timestamp
  );
  const expiresAt = normalizeIsoTimestamp(
    candidate.expiresAt ?? request.expiresAt,
    "shadow_write.expiresAt",
    addDaysToIso(createdAt, 30)
  );
  const candidateSeed = hash(
    stableStringify({
      storeId,
      profile,
      statement,
      scope,
      sourceEventIds,
      evidenceEventIds,
    })
  );
  const candidateId =
    normalizeBoundedString(
      candidate.candidateId ?? request.candidateId,
      "shadow_write.candidateId",
      64
    ) ?? makeId("mcand", candidateSeed);
  const ruleId =
    normalizeBoundedString(
      candidate.ruleId ?? request.ruleId,
      "shadow_write.ruleId",
      64
    ) ??
    makeId("rule", hash(stableStringify({ candidateId, statement, scope })));

  return {
    candidateId,
    ruleId,
    statement,
    scope,
    confidence,
    sourceEventIds,
    evidenceEventIds,
    metadata: normalizeMetadata({
      ...(isPlainObject(request.metadata) ? request.metadata : {}),
      ...(isPlainObject(candidate.metadata) ? candidate.metadata : {}),
    }),
    policyException,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    status: "shadow",
    latestReplayEvalId: null,
    latestReplayStatus: "unevaluated",
    latestNetValueScore: null,
    negativeNetValueStreak: 0,
    promotedAt: null,
    demotedAt: null,
    latestDemotionReasonCodes: [],
    lastTemporalDecayAt: createdAt,
    temporalDecayTickCount: 0,
    temporalDecayDaysAccumulated: 0,
  };
}

function buildShadowWriteAppliedEntry(candidate: any, action: any) {
  return {
    action,
    candidateId: candidate?.candidateId ?? null,
    ruleId: candidate?.ruleId ?? null,
    statement: candidate?.statement ?? "",
    scope: candidate?.scope ?? "global",
    confidence: clamp01(candidate?.confidence, 0.5),
    sourceEventIds: mergeStringLists([], candidate?.sourceEventIds),
    evidenceEventIds: mergeStringLists([], candidate?.evidenceEventIds),
    policyException: candidate?.policyException ?? null,
    status: candidate?.status ?? "shadow",
    createdAt: candidate?.createdAt ?? null,
    updatedAt: candidate?.updatedAt ?? null,
    expiresAt: candidate?.expiresAt ?? null,
  };
}

function resolveMemoryCandidate(state: any, candidateId: any) {
  const candidates = Array.isArray(state.shadowCandidates)
    ? state.shadowCandidates
    : [];
  const candidateIndex = candidates.findIndex(
    (candidate: any) => candidate?.candidateId === candidateId
  );
  if (candidateIndex === -1) {
    return { candidateIndex: -1, candidate: null };
  }
  return {
    candidateIndex,
    candidate: candidates[candidateIndex],
  };
}

function resolveDemotionTargetCandidateIds(
  state: any,
  targetRuleIds: any = [],
  targetCandidateIds: any = []
) {
  const normalizedRuleIds = asSortedUniqueStrings(targetRuleIds);
  const normalizedCandidateIds = asSortedUniqueStrings(targetCandidateIds);
  const candidates = Array.isArray(state.shadowCandidates)
    ? state.shadowCandidates
    : [];
  const matchedCandidateIds = [];
  for (const candidate of candidates) {
    const candidateId = normalizeBoundedString(
      candidate?.candidateId,
      "shadowCandidates.candidateId",
      64
    );
    if (!candidateId) {
      continue;
    }
    const matchesCandidate = normalizedCandidateIds.includes(candidateId);
    const matchesRule = normalizedRuleIds.includes(candidate?.ruleId);
    if (matchesCandidate || matchesRule) {
      matchedCandidateIds.push(candidateId);
    }
  }
  return asSortedUniqueStrings([
    ...normalizedCandidateIds,
    ...matchedCandidateIds,
  ]);
}

function applyCandidateDemotion(
  state: any,
  resolved: any,
  { demotedAt, reasonCodes = [] }: any
) {
  const normalizedReasonCodes = asSortedUniqueStrings(reasonCodes);
  const existingCandidate = resolved?.candidate ?? null;
  if (!existingCandidate || existingCandidate.status === "demoted") {
    return {
      action: "noop",
      candidate: existingCandidate,
      removedRuleId: null,
      reasonCodes: normalizedReasonCodes,
    };
  }

  const nextCandidate = {
    ...existingCandidate,
    status: "demoted",
    demotedAt,
    updatedAt: demotedAt,
    latestDemotionReasonCodes: normalizedReasonCodes,
  };
  state.shadowCandidates[resolved.candidateIndex] = nextCandidate;
  state.shadowCandidates = sortByTimestampAndId(
    state.shadowCandidates,
    "updatedAt",
    "candidateId"
  );

  let removedRuleId = null;
  const existingRuleIndex = state.rules.findIndex(
    (rule: any) => rule.ruleId === existingCandidate.ruleId
  );
  if (existingRuleIndex !== -1) {
    removedRuleId = state.rules.splice(existingRuleIndex, 1)[0]?.ruleId ?? null;
  }

  return {
    action: "demoted",
    candidate: nextCandidate,
    removedRuleId,
    reasonCodes: normalizedReasonCodes,
  };
}

function computeTrailingNegativeNetValueStreak(
  replayEvaluations: any,
  candidateId: any
) {
  if (!Array.isArray(replayEvaluations) || !candidateId) {
    return 0;
  }
  let streak = 0;
  for (let index = replayEvaluations.length - 1; index >= 0; index -= 1) {
    const evaluation = replayEvaluations[index];
    if (evaluation?.candidateId !== candidateId) {
      continue;
    }
    if (stableScore(evaluation?.netValueScore, 0) < 0) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

function normalizeAddWeightRequest(request: any, storeId: any, profile: any) {
  const candidateId = requireNonEmptyString(request.candidateId, "candidateId");
  const parsedDelta = Number(
    request.delta ??
      request.weightDelta ??
      request.adjustmentDelta ??
      request.adjustment ??
      request.amount
  );
  if (!Number.isFinite(parsedDelta) || parsedDelta < -1 || parsedDelta > 1) {
    throw new Error(ADDWEIGHT_DELTA_CONTRACT_ERROR);
  }
  const requestedDelta = roundNumber(parsedDelta, 6);
  const reason = normalizeBoundedString(
    request.reason,
    "addweight.reason",
    512
  );
  if (!reason) {
    throw new Error(ADDWEIGHT_REASON_CONTRACT_ERROR);
  }
  const actor =
    normalizeBoundedString(
      request.actor ??
        request.approvedBy ??
        request.createdByUserId ??
        request.userId,
      "addweight.actor",
      128
    ) ?? "human_unspecified";
  const timestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.adjustedAt ?? request.createdAt,
    "addweight.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const sourceEventIds = normalizeGuardedStringArray(
    request.sourceEventIds ??
      (request.sourceEventId ? [request.sourceEventId] : null),
    "sourceEventIds"
  );
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ??
      request.evidenceEpisodeIds ??
      (request.evidenceEventId ? [request.evidenceEventId] : null) ??
      sourceEventIds,
    "evidenceEventIds"
  );
  const metadata = normalizeMetadata(request.metadata);
  const reasonCodes = mergeStringLists(
    normalizeGuardedStringArray(request.reasonCodes, "reasonCodes"),
    [
      requestedDelta >= 0 ? "human_weight_increase" : "human_weight_decrease",
      "addweight_manual",
    ]
  );
  const idempotencyDigest = hash(
    stableStringify({
      storeId,
      profile,
      candidateId,
      requestedDelta,
      reason,
      actor,
      sourceEventIds,
      evidenceEventIds,
      metadata,
      reasonCodes,
      timestamp,
    })
  );
  const adjustmentId =
    normalizeBoundedString(
      request.adjustmentId,
      "addweight.adjustmentId",
      64
    ) ?? makeId("wadj", idempotencyDigest);

  return {
    candidateId,
    adjustmentId,
    requestedDelta,
    reason,
    actor,
    sourceEventIds,
    evidenceEventIds,
    metadata,
    reasonCodes,
    timestamp,
    idempotencyDigest,
  };
}

function findExistingAddWeightAuditEvent(state: any, adjustmentId: any) {
  const auditTrail = Array.isArray(state.policyAuditTrail)
    ? state.policyAuditTrail
    : [];
  return (
    auditTrail.find(
      (entry: any) =>
        entry?.operation === "addweight" &&
        entry?.details?.adjustmentId === adjustmentId
    ) ?? null
  );
}

function findWeightAdjustmentLedgerEntry(state: any, adjustmentId: any) {
  const ledger = Array.isArray(state.weightAdjustmentLedger)
    ? state.weightAdjustmentLedger
    : [];
  return (
    ledger.find((entry: any) => entry?.adjustmentId === adjustmentId) ?? null
  );
}

function upsertWeightAdjustmentLedgerEntry(state: any, rawEntry: any) {
  const entry = isPlainObject(rawEntry) ? rawEntry : {};
  const adjustmentId =
    normalizeBoundedString(
      entry.adjustmentId,
      "weightAdjustmentLedger.adjustmentId",
      64
    ) ?? makeId("wadj", hash(stableStringify(entry)));
  const idempotencyDigest =
    normalizeBoundedString(
      entry.idempotencyDigest,
      "weightAdjustmentLedger.idempotencyDigest",
      128
    ) ?? hash(stableStringify({ adjustmentId }));
  const timestamp = normalizeIsoTimestampOrFallback(
    entry.timestamp,
    DEFAULT_VERSION_TIMESTAMP
  );
  const nextEntry = {
    adjustmentId,
    idempotencyDigest,
    candidateId: normalizeBoundedString(
      entry.candidateId,
      "weightAdjustmentLedger.candidateId",
      64
    ),
    auditEventId: normalizeBoundedString(
      entry.auditEventId,
      "weightAdjustmentLedger.auditEventId",
      64
    ),
    timestamp,
  };
  const ledger = Array.isArray(state.weightAdjustmentLedger)
    ? state.weightAdjustmentLedger
    : [];
  const existingIndex = ledger.findIndex(
    (candidate: any) => candidate?.adjustmentId === adjustmentId
  );
  if (existingIndex !== -1) {
    const existing = ledger[existingIndex];
    const existingDigest =
      normalizeBoundedString(
        existing?.idempotencyDigest,
        "weightAdjustmentLedger.idempotencyDigest",
        128
      ) ?? null;
    if (existingDigest && existingDigest !== idempotencyDigest) {
      throw new Error(ADDWEIGHT_ADJUSTMENT_COLLISION_CONTRACT_ERROR);
    }
    state.weightAdjustmentLedger = sortByTimestampAndId(
      ledger,
      "timestamp",
      "adjustmentId"
    ).slice(-MAX_WEIGHT_ADJUSTMENT_LEDGER_EVENTS);
    return existing;
  }

  state.weightAdjustmentLedger = sortByTimestampAndId(
    [...ledger, nextEntry],
    "timestamp",
    "adjustmentId"
  ).slice(-MAX_WEIGHT_ADJUSTMENT_LEDGER_EVENTS);
  return nextEntry;
}

function normalizeReplayEvalMetrics(request: any) {
  return {
    successRateDelta: stableScore(
      request.successRateDelta ?? request.success_rate_delta,
      0
    ),
    reopenRateDelta: stableScore(
      request.reopenRateDelta ?? request.reopen_rate_delta,
      0
    ),
    latencyP95DeltaMs: stableScore(
      request.latencyP95DeltaMs ?? request.latency_p95_delta_ms,
      0
    ),
    tokenCostDelta: stableScore(
      request.tokenCostDelta ?? request.token_cost_delta,
      0
    ),
    policyViolationsDelta: stableScore(
      request.policyViolationsDelta ?? request.policy_violations_delta,
      0
    ),
    hallucinationFlagDelta: stableScore(
      request.hallucinationFlagDelta ?? request.hallucination_flag_delta,
      0
    ),
  };
}

function normalizeReplayEvalCanaryMetrics(request: any) {
  return {
    successRateDelta: stableScore(
      request.canarySuccessRateDelta ?? request.canary_success_rate_delta,
      0
    ),
    errorRateDelta: stableScore(
      request.canaryErrorRateDelta ?? request.canary_error_rate_delta,
      0
    ),
    latencyP95DeltaMs: stableScore(
      request.canaryLatencyP95DeltaMs ?? request.canary_latency_p95_delta_ms,
      0
    ),
    policyViolationsDelta: stableScore(
      request.canaryPolicyViolationsDelta ??
        request.canary_policy_violations_delta,
      0
    ),
    hallucinationFlagDelta: stableScore(
      request.canaryHallucinationFlagDelta ??
        request.canary_hallucination_flag_delta,
      0
    ),
  };
}

function computeReplayEvalScoreBreakdown(metrics: any, canaryMetrics: any) {
  const components = {
    replaySuccessReward: roundNumber(metrics.successRateDelta * 100, 6),
    replayReopenPenalty: roundNumber(metrics.reopenRateDelta * -80, 6),
    replayLatencyPenalty: roundNumber(metrics.latencyP95DeltaMs * -0.05, 6),
    replayTokenPenalty: roundNumber(metrics.tokenCostDelta * -0.1, 6),
    replayPolicyPenalty: roundNumber(metrics.policyViolationsDelta * -200, 6),
    replayHallucinationPenalty: roundNumber(
      metrics.hallucinationFlagDelta * -120,
      6
    ),
    canarySuccessReward: roundNumber(canaryMetrics.successRateDelta * 60, 6),
    canaryErrorPenalty: roundNumber(canaryMetrics.errorRateDelta * -90, 6),
    canaryLatencyPenalty: roundNumber(
      canaryMetrics.latencyP95DeltaMs * -0.04,
      6
    ),
    canaryPolicyPenalty: roundNumber(
      canaryMetrics.policyViolationsDelta * -220,
      6
    ),
    canaryHallucinationPenalty: roundNumber(
      canaryMetrics.hallucinationFlagDelta * -140,
      6
    ),
  };
  const total = roundNumber(
    Object.values(components).reduce(
      (accumulator: any, value: any) => accumulator + stableScore(value, 0),
      0
    ),
    6
  );
  return {
    components: stableSortObject(components),
    total,
  };
}

function computeReplayEvalSafetyDeltas(
  metrics: any,
  canaryMetrics: any,
  replayThreshold: any,
  canaryThreshold: any
) {
  const replaySafetyDeltas = {
    policyViolationsDelta: roundNumber(metrics.policyViolationsDelta, 6),
    hallucinationFlagDelta: roundNumber(metrics.hallucinationFlagDelta, 6),
  };
  const canarySafetyDeltas = {
    policyViolationsDelta: roundNumber(canaryMetrics.policyViolationsDelta, 6),
    hallucinationFlagDelta: roundNumber(
      canaryMetrics.hallucinationFlagDelta,
      6
    ),
    errorRateDelta: roundNumber(canaryMetrics.errorRateDelta, 6),
  };
  const replayRegressionCount = Object.values(replaySafetyDeltas).filter(
    (delta: any) => stableScore(delta, 0) > replayThreshold
  ).length;
  const canaryRegressionCount = Object.values(canarySafetyDeltas).filter(
    (delta: any) => stableScore(delta, 0) > canaryThreshold
  ).length;
  const safetyDeltaScore = roundNumber(
    Object.values(replaySafetyDeltas).reduce(
      (accumulator: any, delta: any) =>
        accumulator + Math.max(0, stableScore(delta, 0) - replayThreshold),
      0
    ) +
      Object.values(canarySafetyDeltas).reduce(
        (accumulator: any, delta: any) =>
          accumulator + Math.max(0, stableScore(delta, 0) - canaryThreshold),
        0
      ),
    6
  );
  const totalRegressionCount = replayRegressionCount + canaryRegressionCount;
  const severity =
    totalRegressionCount >= 3
      ? "critical"
      : totalRegressionCount > 0
        ? "high"
        : "none";

  return {
    replay: replaySafetyDeltas,
    canary: canarySafetyDeltas,
    replayThreshold: roundNumber(replayThreshold, 6),
    canaryThreshold: roundNumber(canaryThreshold, 6),
    replayRegressionCount,
    canaryRegressionCount,
    totalRegressionCount,
    safetyDeltaScore,
    severity,
  };
}

function normalizeRequest(operation: any, request: any) {
  requireObject(request);
  const storeId = defaultStoreId(request.storeId ?? request.store);
  const profile = normalizeProfile(request.profile);
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

function findByDigestPrefix(items: any, digestPrefix: any, field: any) {
  if (typeof digestPrefix !== "string" || !digestPrefix) {
    return null;
  }
  return (
    items.find((item: any) => item[field].startsWith(digestPrefix)) ?? null
  );
}

function buildMeta(operation: any, storeId: any, profile: any, input: any) {
  const seed = opSeed(operation, storeId, profile, input);
  return {
    operation,
    storeId,
    profile,
    requestDigest: seed,
    deterministic: true,
  };
}

function deterministicLatencyMs(
  requestDigest: any,
  min: any = 4,
  max: any = 40
) {
  const seed = Number.parseInt(
    typeof requestDigest === "string" ? requestDigest.slice(0, 8) : "",
    16
  );
  if (!Number.isFinite(seed)) {
    return min;
  }
  return min + (seed % (max - min + 1));
}

function latencyBucket(latencyMs: any) {
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

function buildSloObservability(
  requestDigest: any,
  operation: any,
  targetP95Ms: any
) {
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

function buildLifecycleCandidateThroughputMetric(
  state: any,
  { processedCount = 0, mutatedCount = 0, actionCounts = null }: any = {}
) {
  const totalCandidates = Array.isArray(state.shadowCandidates)
    ? state.shadowCandidates.length
    : 0;
  const normalizedProcessedCount = toNonNegativeInteger(processedCount, 0);
  const normalizedMutatedCount = toNonNegativeInteger(mutatedCount, 0);
  const throughput: {
    processedCount: number;
    mutatedCount: number;
    mutationRate: number;
    totalCandidates: number;
    actionCounts?: Record<string, unknown>;
  } = {
    processedCount: normalizedProcessedCount,
    mutatedCount: normalizedMutatedCount,
    mutationRate:
      normalizedProcessedCount > 0
        ? roundNumber(normalizedMutatedCount / normalizedProcessedCount, 6)
        : 0,
    totalCandidates,
  };
  if (isPlainObject(actionCounts)) {
    throughput.actionCounts = stableSortObject(actionCounts);
  }
  return throughput;
}

function buildLifecycleGatePassRateMetric(state: any, candidateIds: any = []) {
  const scopedCandidateIds = asSortedUniqueStrings(candidateIds);
  const scopedCandidateIdSet =
    scopedCandidateIds.length > 0 ? new Set(scopedCandidateIds) : null;
  const replayEvaluations = Array.isArray(state.replayEvaluations)
    ? state.replayEvaluations
    : [];
  const relevantEvaluations = replayEvaluations.filter((evaluation: any) => {
    if (!evaluation || typeof evaluation !== "object") {
      return false;
    }
    if (
      scopedCandidateIdSet &&
      !scopedCandidateIdSet.has(evaluation.candidateId)
    ) {
      return false;
    }
    return evaluation.pass === true || evaluation.pass === false;
  });
  const passCount = relevantEvaluations.reduce(
    (count: any, evaluation: any) => count + (evaluation.pass === true ? 1 : 0),
    0
  );
  const totalCount = relevantEvaluations.length;
  return {
    scope: scopedCandidateIds.length > 0 ? "candidate" : "profile",
    candidateIds: scopedCandidateIds,
    passCount,
    totalCount,
    failCount: Math.max(totalCount - passCount, 0),
    rate: totalCount > 0 ? roundNumber(passCount / totalCount, 6) : null,
  };
}

function buildLifecycleDemotionReasonsMetric(
  state: any,
  reasonCodes: any = []
) {
  const normalizedReasonCodes = asSortedUniqueStrings(reasonCodes);
  const candidates = Array.isArray(state.shadowCandidates)
    ? state.shadowCandidates
    : [];
  const profileCounts: Record<string, number> = {};
  for (const candidate of candidates) {
    const candidateReasonCodes = asSortedUniqueStrings(
      candidate?.latestDemotionReasonCodes
    );
    for (const reasonCode of candidateReasonCodes) {
      profileCounts[reasonCode] =
        toNonNegativeInteger(profileCounts[reasonCode], 0) + 1;
    }
  }
  const operationEventCounts: Record<string, number> = {};
  for (const reasonCode of normalizedReasonCodes) {
    operationEventCounts[reasonCode] =
      toNonNegativeInteger(operationEventCounts[reasonCode], 0) + 1;
  }
  const operationReasonHistoryCounts: Record<string, number> = {};
  const operationReasonHistory = Array.isArray(state.policyAuditTrail)
    ? state.policyAuditTrail
    : [];
  for (const entry of operationReasonHistory) {
    const operation = normalizeBoundedString(
      entry?.operation,
      "policyAuditTrail.operation",
      64
    );
    if (operation !== "demote") {
      continue;
    }
    const reasonHistoryCodes = asSortedUniqueStrings(entry?.reasonCodes);
    for (const reasonCode of reasonHistoryCodes) {
      operationReasonHistoryCounts[reasonCode] =
        toNonNegativeInteger(operationReasonHistoryCounts[reasonCode], 0) + 1;
    }
  }
  return {
    reasonCodes: normalizedReasonCodes,
    reasonCount: normalizedReasonCodes.length,
    operationEventCounts: stableSortObject(operationEventCounts),
    operationReasonHistoryCounts: stableSortObject(
      operationReasonHistoryCounts
    ),
    profileCounts: stableSortObject(profileCounts),
  };
}

function buildLifecycleLatencyMetric(requestDigest: any) {
  const observedLatencyMs = deterministicLatencyMs(requestDigest);
  return {
    observedLatencyMs,
    latencyBucket: latencyBucket(observedLatencyMs),
  };
}

function buildLifecycleObservabilityMetrics(
  state: any,
  {
    requestDigest,
    candidateIds = [],
    processedCount = 0,
    mutatedCount = 0,
    actionCounts = null,
    demotionReasonCodes = [],
  }: any = {}
) {
  const scopedCandidateIds = asSortedUniqueStrings(candidateIds);
  return stableSortObject({
    candidateThroughput: buildLifecycleCandidateThroughputMetric(state, {
      processedCount,
      mutatedCount,
      actionCounts,
    }),
    gatePassRate: buildLifecycleGatePassRateMetric(state, scopedCandidateIds),
    demotionReasons: buildLifecycleDemotionReasonsMetric(
      state,
      demotionReasonCodes
    ),
    latency: buildLifecycleLatencyMetric(requestDigest),
    deterministic: true,
    replaySafe: true,
  });
}

function buildLifecycleTrace(
  meta: any,
  { action = "noop", candidateIds = [], metrics = {}, details = {} }: any = {}
) {
  const payload = stableSortObject({
    operation: meta.operation,
    action,
    storeId: meta.storeId,
    profile: meta.profile,
    requestDigest: meta.requestDigest,
    candidateIds: asSortedUniqueStrings(candidateIds),
    metrics: stableSortObject(metrics),
    details: isPlainObject(details) ? stableSortObject(details) : {},
    deterministic: true,
    replaySafe: true,
  });
  const traceSeed = hash(stableStringify(payload));
  return {
    traceId: makeId("trace", traceSeed),
    spanId: makeId(
      "span",
      hash(stableStringify({ traceSeed, operation: meta.operation }))
    ),
    parentSpanId: makeId(
      "span",
      hash(
        stableStringify({
          requestDigest: meta.requestDigest,
          operation: "lifecycle",
        })
      )
    ),
    payload,
    deterministic: true,
    replaySafe: true,
  };
}

function compareByIsoTimestampThenId(
  leftTimestamp: any,
  leftId: any,
  rightTimestamp: any,
  rightId: any
) {
  const timestampDiff = String(leftTimestamp ?? "").localeCompare(
    String(rightTimestamp ?? "")
  );
  if (timestampDiff !== 0) {
    return timestampDiff;
  }
  return String(leftId ?? "").localeCompare(String(rightId ?? ""));
}

function sortByTimestampAndId(values: any, timestampField: any, idField: any) {
  return [...values].sort((left: any, right: any) =>
    compareByIsoTimestampThenId(
      left?.[timestampField],
      left?.[idField],
      right?.[timestampField],
      right?.[idField]
    )
  );
}

function getOrCreateSchedulerClocks(state: any) {
  const current = isPlainObject(state.schedulerClocks)
    ? state.schedulerClocks
    : {};
  const fatigueThreshold = toPositiveInteger(
    current.fatigueThreshold ?? current.sleepThreshold,
    DEFAULT_SLEEP_THRESHOLD
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
      fatigueThreshold
    ),
    consolidationCount: toNonNegativeInteger(current.consolidationCount, 0),
    lastConsolidationCause:
      normalizeBoundedString(
        current.lastConsolidationCause,
        "schedulerClocks.lastConsolidationCause",
        64
      ) ?? "none",
    lastInteractionAt: normalizeIsoTimestampOrFallback(
      current.lastInteractionAt,
      DEFAULT_VERSION_TIMESTAMP
    ),
    lastSleepAt: normalizeIsoTimestampOrFallback(
      current.lastSleepAt,
      DEFAULT_VERSION_TIMESTAMP
    ),
    lastConsolidatedAt: normalizeIsoTimestampOrFallback(
      current.lastConsolidatedAt,
      DEFAULT_VERSION_TIMESTAMP
    ),
    updatedAt: normalizeIsoTimestampOrFallback(
      current.updatedAt,
      DEFAULT_VERSION_TIMESTAMP
    ),
  };
  state.schedulerClocks = normalized;
  return normalized;
}

function getOrCreateReviewArchivalTiers(state: any) {
  const current = isPlainObject(state.reviewArchivalTiers)
    ? state.reviewArchivalTiers
    : {};
  const tiers = isPlainObject(current.tiers) ? current.tiers : {};
  const normalized = {
    activeLimit: Math.min(
      Math.max(
        toPositiveInteger(current.activeLimit, DEFAULT_ACTIVE_REVIEW_SET_LIMIT),
        1
      ),
      MAX_ACTIVE_REVIEW_SET_LIMIT
    ),
    activeReviewIds: normalizeBoundedStringArray(
      current.activeReviewIds,
      "reviewArchivalTiers.activeReviewIds"
    ),
    tiers: {
      warm: normalizeBoundedStringArray(
        tiers.warm,
        "reviewArchivalTiers.tiers.warm"
      ),
      cold: normalizeBoundedStringArray(
        tiers.cold,
        "reviewArchivalTiers.tiers.cold"
      ),
      frozen: normalizeBoundedStringArray(
        tiers.frozen,
        "reviewArchivalTiers.tiers.frozen"
      ),
    },
    archivedRecords: Array.isArray(current.archivedRecords)
      ? sortByTimestampAndId(
          current.archivedRecords
            .filter((record: any) => isPlainObject(record))
            .map((record: any) => ({
              archiveRecordId:
                normalizeBoundedString(
                  record.archiveRecordId,
                  "reviewArchivalTiers.archiveRecordId",
                  64
                ) ?? makeId("arc", hash(stableStringify(record))),
              scheduleEntryId:
                normalizeBoundedString(
                  record.scheduleEntryId,
                  "reviewArchivalTiers.scheduleEntryId"
                ) ?? "unknown",
              targetId:
                normalizeBoundedString(
                  record.targetId,
                  "reviewArchivalTiers.targetId"
                ) ?? "unknown",
              tier: normalizeDeterministicEnum(
                record.tier,
                "tier",
                "review_set_rebalance",
                new Set(["warm", "cold", "frozen"]),
                "warm"
              ),
              archivedAt: normalizeIsoTimestampOrFallback(
                record.archivedAt,
                DEFAULT_VERSION_TIMESTAMP
              ),
              dueAt: normalizeIsoTimestampOrFallback(
                record.dueAt,
                DEFAULT_VERSION_TIMESTAMP
              ),
              sourceEventIds: normalizeBoundedStringArray(
                record.sourceEventIds,
                "reviewArchivalTiers.sourceEventIds"
              ),
              evidenceEventIds: normalizeBoundedStringArray(
                record.evidenceEventIds,
                "reviewArchivalTiers.evidenceEventIds"
              ),
              metadata: normalizeMetadata(record.metadata),
            })),
          "archivedAt",
          "archiveRecordId"
        )
      : [],
    updatedAt: normalizeIsoTimestampOrFallback(
      current.updatedAt,
      DEFAULT_VERSION_TIMESTAMP
    ),
  };
  state.reviewArchivalTiers = normalized;
  return normalized;
}

function getOrCreateRecallAllowlistPolicy(
  state: any,
  storeId: any,
  profile: any
) {
  const current = isPlainObject(state.recallAllowlistPolicy)
    ? state.recallAllowlistPolicy
    : {};
  const policyId =
    normalizeBoundedString(
      current.policyId,
      "recallAllowlistPolicy.policyId",
      64
    ) ?? makeId("allow", hash(stableStringify({ storeId, profile })));
  const allowedStoreIds = mergeStringLists(current.allowedStoreIds, [storeId]);
  const normalized = {
    policyId,
    allowedStoreIds,
    updatedAt: normalizeIsoTimestampOrFallback(
      current.updatedAt,
      DEFAULT_VERSION_TIMESTAMP
    ),
    metadata: normalizeMetadata(current.metadata),
  };
  state.recallAllowlistPolicy = normalized;
  return normalized;
}

function ensureRecallAuthorizationForOperation(
  state: any,
  {
    storeId,
    profile,
    requesterStoreId,
    operation,
    timestamp = DEFAULT_VERSION_TIMESTAMP,
  }: any
) {
  const requester =
    normalizeBoundedString(requesterStoreId, "requesterStoreId", 128) ??
    storeId;
  const crossSpace = requester !== storeId;
  const policy = getOrCreateRecallAllowlistPolicy(state, storeId, profile);
  const authorized = !crossSpace || policy.allowedStoreIds.includes(requester);
  const reasonCodes = authorized
    ? ["allowlist_authorized"]
    : ["allowlist_denied"];
  const auditEvent = appendPolicyAuditTrail(state, {
    operation,
    storeId,
    profile,
    entityId: makeId(
      "auth",
      hash(
        stableStringify({
          operation,
          requesterStoreId: requester,
          storeId,
          profile,
          timestamp,
        })
      )
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
    const error = new Error(
      `${CROSS_SPACE_ALLOWLIST_DENY_ERROR} requesterStoreId=${requester} targetStoreId=${storeId}`
    ) as Error & { code?: string; policyAuditEventId?: string };
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

function appendPolicyAuditTrail(state: any, rawEvent: any) {
  const event = isPlainObject(rawEvent) ? rawEvent : {};
  const timestamp = normalizeIsoTimestampOrFallback(
    event.timestamp,
    DEFAULT_VERSION_TIMESTAMP
  );
  const material = stableSortObject({
    operation: event.operation ?? "unknown",
    storeId: event.storeId ?? DEFAULT_STORE_ID,
    profile: event.profile ?? INTERNAL_PROFILE_ID,
    entityId: event.entityId ?? null,
    outcome: event.outcome ?? "recorded",
    reasonCodes: normalizeBoundedStringArray(
      event.reasonCodes,
      "policyAuditTrail.reasonCodes"
    ),
    details: normalizeMetadata(event.details),
    timestamp,
  });
  const auditEventId =
    normalizeBoundedString(
      event.auditEventId,
      "policyAuditTrail.auditEventId",
      64
    ) ?? makeId("audit", hash(stableStringify(material)));
  const nextEvent = {
    auditEventId,
    operation: String(event.operation ?? "unknown"),
    storeId: String(event.storeId ?? DEFAULT_STORE_ID),
    profile: String(event.profile ?? INTERNAL_PROFILE_ID),
    entityId: event.entityId ?? null,
    outcome: String(event.outcome ?? "recorded"),
    reasonCodes: normalizeBoundedStringArray(
      event.reasonCodes,
      "policyAuditTrail.reasonCodes"
    ),
    details: normalizeMetadata(event.details),
    timestamp,
  };

  const existing = Array.isArray(state.policyAuditTrail)
    ? state.policyAuditTrail
    : [];
  if (existing.some((entry: any) => entry?.auditEventId === auditEventId)) {
    state.policyAuditTrail = sortByTimestampAndId(
      existing,
      "timestamp",
      "auditEventId"
    ).slice(-MAX_POLICY_AUDIT_EVENTS);
    return nextEvent;
  }

  state.policyAuditTrail = sortByTimestampAndId(
    [...existing, nextEvent],
    "timestamp",
    "auditEventId"
  ).slice(-MAX_POLICY_AUDIT_EVENTS);
  return nextEvent;
}

function addDaysToIso(baseIso: any, days: any) {
  const parsed = Date.parse(baseIso);
  if (!Number.isFinite(parsed)) {
    return baseIso;
  }
  const safeDays = Number.isFinite(days) ? Number(days) : 0;
  return new Date(
    parsed + Math.trunc(safeDays) * 24 * 60 * 60 * 1000
  ).toISOString();
}

function addHoursToIso(baseIso: any, hours: any) {
  const parsed = Date.parse(baseIso);
  if (!Number.isFinite(parsed)) {
    return baseIso;
  }
  const safeHours = Number.isFinite(hours) ? Number(hours) : 0;
  return new Date(
    parsed + Math.trunc(safeHours) * 60 * 60 * 1000
  ).toISOString();
}

function detectPromptInjection(statement: any) {
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
  return matches.sort((left: any, right: any) => left.localeCompare(right));
}

function stableScore(value: any, fallback: any = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function roundNumber(value: any, decimals: any = 6) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  const safeDecimals =
    Number.isInteger(decimals) && decimals >= 0 ? decimals : 6;
  const factor = 10 ** safeDecimals;
  return Math.round(parsed * factor) / factor;
}

function toFiniteNumber(value: any, fallback: any = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizeRecommendationWeights(value: any) {
  const candidate = isPlainObject(value) ? value : {};
  const raw = {
    interest: Math.max(
      toFiniteNumber(
        candidate.interest,
        DEFAULT_RECOMMENDATION_WEIGHTS.interest
      ),
      0
    ),
    masteryGap: Math.max(
      toFiniteNumber(
        candidate.masteryGap,
        DEFAULT_RECOMMENDATION_WEIGHTS.masteryGap
      ),
      0
    ),
    due: Math.max(
      toFiniteNumber(candidate.due, DEFAULT_RECOMMENDATION_WEIGHTS.due),
      0
    ),
    evidence: Math.max(
      toFiniteNumber(
        candidate.evidence,
        DEFAULT_RECOMMENDATION_WEIGHTS.evidence
      ),
      0
    ),
  };
  const total = raw.interest + raw.masteryGap + raw.due + raw.evidence;
  if (total <= 0) {
    return stableSortObject(DEFAULT_RECOMMENDATION_WEIGHTS);
  }
  const normalized = {
    interest: Number((raw.interest / total).toFixed(6)),
    masteryGap: 0,
    due: Number((raw.due / total).toFixed(6)),
    evidence: Number((raw.evidence / total).toFixed(6)),
  };
  normalized.masteryGap = Number(
    Math.max(
      0,
      1 - (normalized.interest + normalized.due + normalized.evidence)
    ).toFixed(6)
  );
  return stableSortObject(normalized);
}

function isoAgeDays(referenceAt: any, targetAt: any) {
  const referenceMs = Date.parse(referenceAt);
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(referenceMs) || !Number.isFinite(targetMs)) {
    return 0;
  }
  return Math.max(
    0,
    Math.floor((referenceMs - targetMs) / (24 * 60 * 60 * 1000))
  );
}

function buildFreshnessAndDecayMetadata(
  planItem: any,
  referenceAt: any,
  freshnessWarningDays: any,
  decayWarningDays: any
) {
  const referencePoint = normalizeIsoTimestampOrFallback(
    planItem.updatedAt ?? planItem.dueAt ?? planItem.createdAt,
    DEFAULT_VERSION_TIMESTAMP
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
    warningCodes: warningCodes.sort((left: any, right: any) =>
      left.localeCompare(right)
    ),
    freshnessWarningDays,
    decayWarningDays,
    decayPenalty,
  };
}

function estimateRecommendationTokenCost(
  planItem: any,
  provenancePointers: any
) {
  const objectiveText = String(planItem?.objectiveId ?? "");
  const metadataLength = stableStringify(planItem?.metadata ?? {}).length;
  const estimate =
    Math.ceil(objectiveText.length / 4) +
    Math.ceil(metadataLength / 20) +
    provenancePointers.length * 8 +
    12;
  return Math.max(24, estimate);
}

function resolveMisconceptionDecayStage(harmfulSignalCount: any) {
  const count = toNonNegativeInteger(harmfulSignalCount, 0);
  if (
    count <
    (MISCONCEPTION_DECAY_STAGE_THRESHOLDS[0] ?? Number.POSITIVE_INFINITY)
  ) {
    return 0;
  }
  if (
    count <
    (MISCONCEPTION_DECAY_STAGE_THRESHOLDS[1] ?? Number.POSITIVE_INFINITY)
  ) {
    return 1;
  }
  if (
    count <
    (MISCONCEPTION_DECAY_STAGE_THRESHOLDS[2] ?? Number.POSITIVE_INFINITY)
  ) {
    return 2;
  }
  if (
    count <
    (MISCONCEPTION_DECAY_STAGE_THRESHOLDS[3] ?? Number.POSITIVE_INFINITY)
  ) {
    return 3;
  }
  return 4;
}

function resolveMisconceptionConfidenceShift(
  signal: any,
  harmfulSignalCount: any,
  severity: any
) {
  const decayStage = resolveMisconceptionDecayStage(harmfulSignalCount);
  if (signal !== "harmful") {
    const nonHarmfulSignal: keyof typeof MISCONCEPTION_SIGNAL_BASE_DELTA =
      signal === "helpful" || signal === "correction" || signal === "harmful"
        ? signal
        : "harmful";
    return {
      delta: MISCONCEPTION_SIGNAL_BASE_DELTA[nonHarmfulSignal] ?? 0,
      stage: decayStage,
      accelerated: false,
      accelerationMultiplier: 1,
      severityPenalty: 0,
    };
  }
  const baseDecay =
    MISCONCEPTION_DECAY_BY_STAGE[decayStage] ?? MISCONCEPTION_DECAY_BY_STAGE[4];
  const accelerationMultiplier =
    decayStage >= 2 ? Number((1 + (decayStage - 1) * 0.35).toFixed(6)) : 1;
  const severityPenalty = Number(
    (clamp01(severity, 0) * MISCONCEPTION_HARMFUL_SEVERITY_MULTIPLIER).toFixed(
      6
    )
  );
  return {
    delta: Number((-(baseDecay + severityPenalty)).toFixed(6)),
    stage: decayStage,
    accelerated: decayStage >= 2,
    accelerationMultiplier,
    severityPenalty,
  };
}

function buildMisconceptionAntiPatterns(record: any) {
  const harmfulSignalCount = toNonNegativeInteger(
    record?.harmfulSignalCount,
    0
  );
  if (harmfulSignalCount <= 0) {
    return [];
  }
  const evidenceEventIds = normalizeBoundedStringArray(
    record?.evidenceEventIds,
    "misconception.antiPattern.evidenceEventIds"
  );
  const sourceSignalIds = normalizeBoundedStringArray(
    record?.sourceSignalIds,
    "misconception.antiPattern.sourceSignalIds"
  );
  const antiPatterns = [];
  for (
    let index = 0;
    index < MISCONCEPTION_ANTI_PATTERN_THRESHOLDS.length;
    index += 1
  ) {
    const threshold =
      MISCONCEPTION_ANTI_PATTERN_THRESHOLDS[index] ?? Number.POSITIVE_INFINITY;
    if (harmfulSignalCount < threshold) {
      continue;
    }
    const antiPatternId = makeId(
      "anti",
      hash(
        stableStringify({
          misconceptionId: record?.misconceptionId ?? "unknown",
          threshold,
        })
      )
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
      activatedAt: normalizeIsoTimestampOrFallback(
        record?.updatedAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
    });
  }
  return antiPatterns.sort((left: any, right: any) =>
    compareByIsoTimestampThenId(
      left.activatedAt,
      left.antiPatternId,
      right.activatedAt,
      right.antiPatternId
    )
  );
}

function summarizeCurriculumConflictChanges(previous: any, next: any) {
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
  return changedFields.sort((left: any, right: any) =>
    left.localeCompare(right)
  );
}

function appendCurriculumConflictNote(state: any, conflictNote: any) {
  const existing = Array.isArray(state.curriculumConflictHistory)
    ? state.curriculumConflictHistory
    : [];
  if (existing.some((entry: any) => entry?.noteId === conflictNote.noteId)) {
    state.curriculumConflictHistory = sortByTimestampAndId(
      existing,
      "timestamp",
      "noteId"
    );
    return conflictNote;
  }
  state.curriculumConflictHistory = sortByTimestampAndId(
    [...existing, conflictNote],
    "timestamp",
    "noteId"
  ).slice(-MAX_POLICY_AUDIT_EVENTS);
  return conflictNote;
}

function summarizeMisconceptionChanges(previous: any, next: any) {
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
  return changedFields.sort((left: any, right: any) =>
    left.localeCompare(right)
  );
}

function appendMisconceptionChronologyNote(state: any, chronologyNote: any) {
  const existing = Array.isArray(state.misconceptionChronologyHistory)
    ? state.misconceptionChronologyHistory
    : [];
  if (existing.some((entry: any) => entry?.noteId === chronologyNote.noteId)) {
    state.misconceptionChronologyHistory = sortByTimestampAndId(
      existing,
      "timestamp",
      "noteId"
    );
    return chronologyNote;
  }
  state.misconceptionChronologyHistory = sortByTimestampAndId(
    [...existing, chronologyNote],
    "timestamp",
    "noteId"
  ).slice(-MAX_POLICY_AUDIT_EVENTS);
  return chronologyNote;
}

function createEmptyLearnerProfileSeed(incoming: any) {
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
    updatedAt:
      incoming.updatedAt ?? incoming.createdAt ?? DEFAULT_VERSION_TIMESTAMP,
    attributeLineage: {},
    attributeTruth: {},
  };
}

function upsertDeterministicRecord(
  records: any,
  idField: any,
  record: any,
  timestampField: any = "createdAt"
) {
  const source = Array.isArray(records) ? records : [];
  const identifier = record?.[idField];
  const existingIndex = source.findIndex(
    (entry: any) => entry?.[idField] === identifier
  );
  if (existingIndex !== -1) {
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
    nextRecords: sortByTimestampAndId(
      [...source, record],
      timestampField,
      idField
    ),
    record,
  };
}

function normalizePainSignalIngestRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const misconceptionKey = requireNonEmptyString(
    request.misconceptionKey ?? request.targetId ?? request.targetRuleId,
    "misconceptionKey"
  );
  const signalType = normalizeDeterministicEnum(
    request.signalType ?? request.signal ?? request.painType,
    "signalType",
    "pain_signal_ingest",
    PAIN_SIGNAL_TYPES,
    "harmful"
  );
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    { required: true, requiredError: PAIN_SIGNAL_EVIDENCE_CONTRACT_ERROR }
  );
  const sourceEventIds = normalizeGuardedStringArray(
    request.sourceEventIds,
    "sourceEventIds"
  );
  const provenanceSource =
    normalizeBoundedString(
      request.provenanceSource ?? request.source ?? request.actor,
      "provenanceSource",
      128
    ) ?? "human_feedback";
  const severity = clamp01(request.severity, 0.92);
  const note = normalizeBoundedString(
    request.note ?? request.message ?? request.feedbackText,
    "note",
    1024
  );
  const recordedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.recordedAt ?? request.createdAt,
    "pain_signal_ingest.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const mappedSignal = "harmful";
  const painSignalId =
    normalizeBoundedString(
      request.painSignalId ?? request.signalId,
      "painSignalId",
      64
    ) ??
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
        })
      )
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

function normalizeFailureSignalIngestRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const misconceptionKey = requireNonEmptyString(
    request.misconceptionKey ?? request.targetId ?? request.targetRuleId,
    "misconceptionKey"
  );
  const failureType = normalizeDeterministicEnum(
    request.failureType ?? request.signalType ?? request.type,
    "failureType",
    "failure_signal_ingest",
    FAILURE_SIGNAL_TYPES,
    "test_failure"
  );
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    { required: true, requiredError: FAILURE_SIGNAL_EVIDENCE_CONTRACT_ERROR }
  );
  const sourceEventIds = normalizeGuardedStringArray(
    request.sourceEventIds ?? request.provenanceEventIds,
    "sourceEventIds"
  );
  const failureCount = Math.max(
    toPositiveInteger(request.failureCount ?? request.count, 1),
    1
  );
  const severity = clamp01(
    request.severity,
    FAILURE_SIGNAL_DEFAULT_SEVERITY[
      failureType as keyof typeof FAILURE_SIGNAL_DEFAULT_SEVERITY
    ] ?? 0.75
  );
  const pressureDelta = Number(
    (severity * Math.max(1, failureCount) * 0.2).toFixed(4)
  );
  const outcomeRef =
    normalizeBoundedString(
      request.outcomeId ?? request.taskId ?? request.task,
      "outcomeRef",
      128
    ) ?? "unspecified";
  const recordedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.recordedAt ?? request.createdAt,
    "failure_signal_ingest.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const failureSignalId =
    normalizeBoundedString(
      request.failureSignalId ?? request.signalId,
      "failureSignalId",
      64
    ) ??
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
        })
      )
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

function normalizeIncidentEscalationSignalRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const severity = normalizeDeterministicEnum(
    request.severity ?? request.escalationSeverity ?? request.level,
    "severity",
    "incident_escalation_signal",
    INCIDENT_ESCALATION_SEVERITIES,
    "high"
  );
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds",
    {
      required: true,
      requiredError: INCIDENT_ESCALATION_EVIDENCE_CONTRACT_ERROR,
    }
  );
  const sourceEventIds = normalizeGuardedStringArray(
    request.sourceEventIds ?? request.provenanceEventIds,
    "sourceEventIds"
  );
  const targetCandidateIds = normalizeGuardedStringArray(
    request.targetCandidateIds ??
      (request.targetCandidateId ? [request.targetCandidateId] : null) ??
      request.candidateIds ??
      (request.candidateId ? [request.candidateId] : null),
    "targetCandidateIds"
  );
  const targetRuleIds = normalizeGuardedStringArray(
    request.targetRuleIds ??
      (request.targetRuleId ? [request.targetRuleId] : null) ??
      request.ruleIds ??
      (request.ruleId ? [request.ruleId] : null),
    "targetRuleIds"
  );
  const incidentRef =
    normalizeBoundedString(
      request.incidentRef ??
        request.incidentId ??
        request.ticketId ??
        request.outcomeId ??
        request.taskId,
      "incidentRef",
      128
    ) ?? "unspecified_incident";
  const escalationType =
    normalizeBoundedString(
      request.escalationType ??
        request.failureType ??
        request.signalType ??
        request.type,
      "escalationType",
      64
    ) ?? "failure_event";
  const note = normalizeBoundedString(
    request.note ?? request.message ?? request.summary,
    "note",
    1024
  );
  const reasonCodes = mergeStringLists(
    normalizeGuardedStringArray(request.reasonCodes, "reasonCodes"),
    ["incident_escalation_signal", `incident_severity_${severity}`]
  );
  const recordedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.recordedAt ?? request.createdAt,
    "incident_escalation_signal.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const quarantineRequired =
    INCIDENT_ESCALATION_IMMEDIATE_QUARANTINE_SEVERITIES.has(severity);
  const metadata = normalizeMetadata(request.metadata);
  const idempotencyDigest = hash(
    stableStringify({
      storeId,
      profile,
      severity,
      escalationType,
      incidentRef,
      note: note ?? null,
      targetCandidateIds,
      targetRuleIds,
      evidenceEventIds,
      sourceEventIds,
      reasonCodes,
      quarantineRequired,
      metadata,
      recordedAt,
    })
  );
  const escalationSignalId =
    normalizeBoundedString(
      request.escalationSignalId ??
        request.incidentSignalId ??
        request.signalId,
      "escalationSignalId",
      64
    ) ?? makeId("esc", idempotencyDigest);

  return {
    escalationSignalId,
    idempotencyDigest,
    incidentRef,
    escalationType,
    severity,
    note,
    targetCandidateIds,
    targetRuleIds,
    evidenceEventIds,
    sourceEventIds,
    reasonCodes,
    quarantineRequired,
    metadata,
    recordedAt,
  };
}

function normalizeManualQuarantineOverrideRequest(
  request: any,
  storeId: any,
  profile: any
) {
  const overrideAction = normalizeDeterministicEnum(
    request.action ?? request.overrideAction ?? request.controlAction,
    "action",
    "manual_quarantine_override",
    MANUAL_OVERRIDE_ACTIONS,
    "suppress"
  );
  const targetCandidateIds = normalizeGuardedStringArray(
    request.targetCandidateIds ??
      (request.targetCandidateId ? [request.targetCandidateId] : null) ??
      request.candidateIds ??
      (request.candidateId ? [request.candidateId] : null),
    "targetCandidateIds"
  );
  const targetRuleIds = normalizeGuardedStringArray(
    request.targetRuleIds ??
      (request.targetRuleId ? [request.targetRuleId] : null) ??
      request.ruleIds ??
      (request.ruleId ? [request.ruleId] : null),
    "targetRuleIds"
  );
  if (targetCandidateIds.length === 0 && targetRuleIds.length === 0) {
    throw new Error(MANUAL_OVERRIDE_TARGET_CONTRACT_ERROR);
  }
  const actor = normalizeBoundedString(
    request.actor ?? request.operator ?? request.requestedBy,
    "manual_quarantine_override.actor",
    128
  );
  if (!actor) {
    throw new Error(MANUAL_OVERRIDE_ACTOR_CONTRACT_ERROR);
  }
  const reason = normalizeBoundedString(
    request.reason ?? request.note ?? request.summary,
    "manual_quarantine_override.reason",
    512
  );
  const providedReasonCodes = normalizeGuardedStringArray(
    request.reasonCodes,
    "reasonCodes"
  );
  if (providedReasonCodes.length === 0 && !reason) {
    throw new Error(MANUAL_OVERRIDE_REASON_CONTRACT_ERROR);
  }
  const reasonCodes = mergeStringLists(providedReasonCodes, [
    "manual_quarantine_override",
    `manual_override_action_${overrideAction}`,
  ]);
  const evidenceEventIds = normalizeGuardedStringArray(
    request.evidenceEventIds ?? request.evidenceEpisodeIds,
    "evidenceEventIds"
  );
  const sourceEventIds = normalizeGuardedStringArray(
    request.sourceEventIds ?? request.provenanceEventIds,
    "sourceEventIds"
  );
  const recordedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.recordedAt ?? request.createdAt,
    "manual_quarantine_override.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const metadata = normalizeMetadata(request.metadata);
  const idempotencyDigest = hash(
    stableStringify({
      storeId,
      profile,
      overrideAction,
      actor,
      reason: reason ?? null,
      reasonCodes,
      targetCandidateIds,
      targetRuleIds,
      evidenceEventIds,
      sourceEventIds,
      metadata,
      recordedAt,
    })
  );
  const overrideControlId =
    normalizeBoundedString(
      request.overrideControlId ??
        request.controlId ??
        request.overrideId ??
        request.signalId,
      "overrideControlId",
      64
    ) ?? makeId("movr", idempotencyDigest);

  return {
    overrideControlId,
    idempotencyDigest,
    overrideAction,
    actor,
    reason,
    reasonCodes,
    targetCandidateIds,
    targetRuleIds,
    evidenceEventIds,
    sourceEventIds,
    metadata,
    recordedAt,
  };
}

function normalizeCurriculumRecommendationRequest(request: any) {
  const referenceAt = normalizeIsoTimestamp(
    request.referenceAt ?? request.timestamp ?? request.generatedAt,
    "curriculum_recommendation.referenceAt",
    DEFAULT_VERSION_TIMESTAMP
  );
  const maxRecommendations = Math.min(
    Math.max(
      toPositiveInteger(request.maxRecommendations ?? request.limit, 5),
      1
    ),
    MAX_RECOMMENDATIONS
  );
  const freshnessWarningDays = Math.min(
    Math.max(
      toPositiveInteger(
        request.freshnessWarningDays ?? request.freshnessThresholdDays,
        DEFAULT_FRESHNESS_WARNING_DAYS
      ),
      1
    ),
    365
  );
  const decayWarningDays = Math.min(
    Math.max(
      toPositiveInteger(
        request.decayWarningDays ?? request.decayThresholdDays,
        DEFAULT_DECAY_WARNING_DAYS
      ),
      freshnessWarningDays
    ),
    730
  );
  const tokenBudget = Math.min(
    Math.max(
      toPositiveInteger(
        request.tokenBudget ?? request.recallTokenBudget,
        DEFAULT_RECOMMENDATION_TOKEN_BUDGET
      ),
      32
    ),
    MAX_RECOMMENDATION_TOKEN_BUDGET
  );
  const maxConflictNotes = Math.min(
    Math.max(
      toPositiveInteger(request.maxConflictNotes, DEFAULT_MAX_CONFLICT_NOTES),
      1
    ),
    MAX_LIST_ITEMS
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

function normalizeReviewScheduleClockRequest(request: any) {
  const mode = normalizeDeterministicEnum(
    request.mode ?? request.clockMode,
    "mode",
    "review_schedule_clock",
    CLOCK_MODES,
    "auto"
  );
  const interactionIncrement = toNonNegativeInteger(
    request.interactionIncrement ??
      request.interactions ??
      (mode === "sleep" ? 0 : 1),
    mode === "sleep" ? 0 : 1
  );
  const sleepIncrement = toNonNegativeInteger(
    request.sleepIncrement ?? (mode === "interaction" ? 0 : 1),
    mode === "interaction" ? 0 : 1
  );
  const noveltyLoad = toNonNegativeInteger(request.noveltyLoad, 0);
  const noveltyWriteLoad = toNonNegativeInteger(
    request.noveltyWriteLoad ??
      request.noveltyWriteWrites ??
      request.noveltyWrites,
    0
  );
  const fatigueDelta = toNonNegativeInteger(request.fatigueDelta, 0);
  const requestedFatigueThreshold = toPositiveInteger(
    request.fatigueThreshold ?? request.sleepThreshold,
    DEFAULT_SLEEP_THRESHOLD
  );
  const noveltyWriteThreshold = toPositiveInteger(
    request.noveltyWriteThreshold,
    requestedFatigueThreshold
  );
  const timestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.at ?? request.updatedAt,
    "review_schedule_clock.timestamp",
    DEFAULT_VERSION_TIMESTAMP
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

function normalizeReviewSetRebalanceRequest(request: any) {
  const activeLimit = Math.min(
    Math.max(
      toPositiveInteger(
        request.activeLimit ?? request.maxActive,
        DEFAULT_ACTIVE_REVIEW_SET_LIMIT
      ),
      1
    ),
    MAX_ACTIVE_REVIEW_SET_LIMIT
  );
  const timestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.rebalancedAt ?? request.updatedAt,
    "review_set_rebalance.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  return {
    activeLimit,
    timestamp,
  };
}

function normalizeRecallAuthorizationRequest(request: any, storeId: any) {
  const mode = normalizeDeterministicEnum(
    request.mode,
    "mode",
    "recall_authorization",
    RECALL_AUTH_MODES,
    "check"
  );
  const requesterStoreId = normalizeBoundedString(
    request.requesterStoreId ?? request.sourceStoreId ?? request.fromStoreId,
    "requesterStoreId",
    128
  );
  const allowStoreIds = normalizeBoundedStringArray(
    request.allowStoreIds ?? request.allowSpaceIds,
    "allowStoreIds"
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
      DEFAULT_VERSION_TIMESTAMP
    ),
  };
}

function normalizeTutorDegradedRequest(request: any) {
  const query =
    typeof request.query === "string" ? request.query.trim().toLowerCase() : "";
  const maxSuggestions = Math.min(
    Math.max(toPositiveInteger(request.maxSuggestions ?? request.limit, 5), 1),
    MAX_RECOMMENDATIONS
  );
  const llmAvailable = Boolean(request.llmAvailable);
  const indexAvailable = Boolean(request.indexAvailable);
  const forceDegraded = request.forceDegraded !== false;
  const timestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.generatedAt ?? request.createdAt,
    "tutor_degraded.timestamp",
    DEFAULT_VERSION_TIMESTAMP
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

function intersectionCount(left: any, right: any) {
  const rightSet = new Set(Array.isArray(right) ? right : []);
  let count = 0;
  for (const value of Array.isArray(left) ? left : []) {
    if (rightSet.has(value)) {
      count += 1;
    }
  }
  return count;
}

function runIngest(request: any) {
  const { storeId, profile, input } = normalizeRequest("ingest", request);
  const state = getProfileState(storeId, profile);
  const events = Array.isArray(request.events) ? request.events : [];
  const refs = [];
  const requestDigests = new Set();
  let accepted = 0;
  let duplicates = 0;

  for (const [index, event] of events.entries()) {
    const normalized = normalizeEvent(event, index);
    if (requestDigests.has(normalized.dedupeDigest)) {
      duplicates += 1;
      refs.push({
        eventId: normalized.eventId,
        digest: normalized.digest,
        status: "duplicate",
      });
      continue;
    }
    if (state.eventDigests.has(normalized.digest)) {
      duplicates += 1;
      refs.push({
        eventId: normalized.eventId,
        digest: normalized.digest,
        status: "duplicate",
      });
      continue;
    }
    requestDigests.add(normalized.dedupeDigest);
    state.eventDigests.add(normalized.digest);
    state.events.push(normalized);
    accepted += 1;
    refs.push({
      eventId: normalized.eventId,
      digest: normalized.digest,
      status: "accepted",
    });
  }

  const ledgerDigest = hash(
    stableStringify(state.events.map((event: any) => event.digest))
  );

  return {
    ...buildMeta("ingest", storeId, profile, input),
    accepted,
    duplicates,
    eventRefs: refs,
    ledgerDigest,
  };
}

function runContext(request: any) {
  const { storeId, profile, input } = normalizeRequest("context", request);
  const state = getProfileState(storeId, profile);
  const requestTimestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.requestedAt,
    "context.timestamp",
    DEFAULT_VERSION_TIMESTAMP
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
  const query =
    typeof request.query === "string" ? request.query.toLowerCase() : "";
  const limit =
    Number.isInteger(request.limit) && request.limit > 0 ? request.limit : 5;
  const chronologyLimit = Math.min(
    Math.max(
      toPositiveInteger(
        request.misconceptionChronologyLimit ?? request.chronologyLimit,
        limit
      ),
      1
    ),
    MAX_LIST_ITEMS
  );

  const matched = state.events
    .map((event: any) => {
      const content =
        `${event.type} ${event.source} ${event.content}`.toLowerCase();
      const match = query ? content.includes(query) : true;
      return { event, match };
    })
    .filter((item: any) => item.match)
    .slice(0, limit)
    .map((item: any) => ({
      eventId: item.event.eventId,
      type: item.event.type,
      source: item.event.source,
      excerpt: item.event.content.slice(0, 180),
      digest: item.event.digest,
    }));
  const chronologyHistory = Array.isArray(state.misconceptionChronologyHistory)
    ? sortByTimestampAndId(
        state.misconceptionChronologyHistory,
        "timestamp",
        "noteId"
      )
    : [];
  const scoredChronology = chronologyHistory.map((note: any) => {
    const searchable =
      `${note.misconceptionKey ?? ""} ${(note.changedFields ?? []).join(" ")}`.toLowerCase();
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
    .sort((left: any, right: any) => {
      if (right.relevance !== left.relevance) {
        return right.relevance - left.relevance;
      }
      const recency = String(right.note?.timestamp ?? "").localeCompare(
        String(left.note?.timestamp ?? "")
      );
      if (recency !== 0) {
        return recency;
      }
      return String(left.note?.noteId ?? "").localeCompare(
        String(right.note?.noteId ?? "")
      );
    })
    .slice(0, chronologyLimit)
    .map((entry: any) => ({
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
  const orderedChronology = sortByTimestampAndId(
    prioritizedChronology,
    "timestamp",
    "noteId"
  );
  const chronologyFormatting = orderedChronology.map(
    (note: any, index: any) =>
      `${index + 1}. ${note.timestamp} ${note.misconceptionKey} -> ${note.changedFields.join("|")}`
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
    rules: state.rules.slice(0, 5).map((rule: any) => ({
      ruleId: rule.ruleId,
      statement: rule.statement,
      confidence: rule.confidence,
    })),
    misconceptionChronology: {
      bounded: orderedChronology.length <= chronologyLimit,
      deterministicFormatting: true,
      prioritization: query
        ? "query_relevance_then_recency_then_noteId"
        : "severity_then_recency_then_noteId",
      limit: chronologyLimit,
      totalAvailable: chronologyHistory.length,
      notes: orderedChronology,
      formatting: chronologyFormatting,
    },
  };
}

function runReflect(request: any) {
  const { storeId, profile, input } = normalizeRequest("reflect", request);
  const state = getProfileState(storeId, profile);
  const max =
    Number.isInteger(request.maxCandidates) && request.maxCandidates > 0
      ? request.maxCandidates
      : 3;
  const candidates = state.events.slice(-max).map((event: any) => {
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

function runValidate(request: any) {
  const { storeId, profile, input } = normalizeRequest("validate", request);
  const state = getProfileState(storeId, profile);
  const rawCandidates = Array.isArray(request.candidates)
    ? request.candidates
    : [];
  const candidates = rawCandidates.map(normalizeRuleCandidate);
  const validations = candidates.map((candidate: any) => {
    const evidence =
      state.events.find(
        (event: any) => event.eventId === candidate.sourceEventId
      ) ?? null;
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

function runCurate(request: any) {
  const { storeId, profile, input } = normalizeRequest("curate", request);
  const state = getProfileState(storeId, profile);
  const rawCandidates = Array.isArray(request.candidates)
    ? request.candidates
    : [];
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
    const existing = state.rules.find(
      (rule: any) => rule.ruleId === candidate.candidateId
    );
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

function runShadowWrite(request: any) {
  const { storeId, profile, input } = normalizeRequest("shadow_write", request);
  const state = getProfileState(storeId, profile);
  const timestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.createdAt,
    "shadow_write.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const rawCandidates =
    Array.isArray(request.candidates) && request.candidates.length > 0
      ? request.candidates
      : [request];
  const applied = [];

  if (!Array.isArray(state.shadowCandidates)) {
    state.shadowCandidates = [];
  }

  for (const rawCandidate of rawCandidates) {
    const incoming = normalizeShadowCandidate(
      rawCandidate,
      request,
      storeId,
      profile,
      timestamp
    );
    const resolved = resolveMemoryCandidate(state, incoming.candidateId);
    if (!resolved.candidate) {
      state.shadowCandidates.push(incoming);
      applied.push(buildShadowWriteAppliedEntry(incoming, "created"));
      continue;
    }

    const merged = {
      ...resolved.candidate,
      ruleId: incoming.ruleId,
      statement: incoming.statement,
      scope: incoming.scope,
      confidence: incoming.confidence,
      sourceEventIds: mergeStringLists(
        resolved.candidate.sourceEventIds,
        incoming.sourceEventIds
      ),
      evidenceEventIds: mergeStringLists(
        resolved.candidate.evidenceEventIds,
        incoming.evidenceEventIds
      ),
      metadata: stableSortObject({
        ...resolved.candidate.metadata,
        ...incoming.metadata,
      }),
      policyException:
        incoming.policyException ?? resolved.candidate.policyException ?? null,
      expiresAt: incoming.expiresAt ?? resolved.candidate.expiresAt,
      updatedAt: timestamp,
      status: resolved.candidate.status === "promoted" ? "promoted" : "shadow",
      lastTemporalDecayAt: normalizeIsoTimestampOrFallback(
        resolved.candidate.lastTemporalDecayAt ??
          resolved.candidate.updatedAt ??
          resolved.candidate.createdAt,
        incoming.createdAt
      ),
      temporalDecayTickCount: toNonNegativeInteger(
        resolved.candidate.temporalDecayTickCount,
        0
      ),
      temporalDecayDaysAccumulated: toNonNegativeInteger(
        resolved.candidate.temporalDecayDaysAccumulated,
        0
      ),
    };

    if (stableStringify(resolved.candidate) === stableStringify(merged)) {
      applied.push(buildShadowWriteAppliedEntry(resolved.candidate, "noop"));
      continue;
    }

    state.shadowCandidates[resolved.candidateIndex] = merged;
    applied.push(buildShadowWriteAppliedEntry(merged, "updated"));
  }

  state.shadowCandidates = sortByTimestampAndId(
    state.shadowCandidates,
    "updatedAt",
    "candidateId"
  );
  const createdCount = applied.filter(
    (entry: any) => entry.action === "created"
  ).length;
  const updatedCount = applied.filter(
    (entry: any) => entry.action === "updated"
  ).length;
  const noopCount = applied.filter(
    (entry: any) => entry.action === "noop"
  ).length;
  const meta = buildMeta("shadow_write", storeId, profile, input);
  const lifecycleCandidateIds = asSortedUniqueStrings(
    applied.map((entry: any) => entry?.candidateId).filter(Boolean)
  );
  const lifecycleMutatedCount = createdCount + updatedCount;
  const lifecycleAction =
    lifecycleMutatedCount === 0
      ? "noop"
      : createdCount > 0 && updatedCount > 0
        ? "mixed"
        : createdCount > 0
          ? "created"
          : "updated";
  const lifecycleMetrics = buildLifecycleObservabilityMetrics(state, {
    requestDigest: meta.requestDigest,
    candidateIds: lifecycleCandidateIds,
    processedCount: rawCandidates.length,
    mutatedCount: lifecycleMutatedCount,
    actionCounts: {
      created: createdCount,
      updated: updatedCount,
      noop: noopCount,
    },
    demotionReasonCodes: [],
  });
  const lifecycleTrace = buildLifecycleTrace(meta, {
    action: lifecycleAction,
    candidateIds: lifecycleCandidateIds,
    metrics: lifecycleMetrics,
    details: {
      counts: {
        created: createdCount,
        updated: updatedCount,
        noop: noopCount,
        total: state.shadowCandidates.length,
      },
    },
  });

  return {
    ...meta,
    applied,
    trace: lifecycleTrace,
    counts: {
      created: createdCount,
      updated: updatedCount,
      noop: noopCount,
      total: state.shadowCandidates.length,
    },
    observability: {
      candidateCount: rawCandidates.length,
      replaySafe: true,
      evidenceLinked: true,
      lifecycleMetrics,
      tracePayload: lifecycleTrace.payload,
      slo: buildSloObservability(meta.requestDigest, "shadow_write", 40),
    },
  };
}

function runReplayEval(request: any) {
  const { storeId, profile, input } = normalizeRequest("replay_eval", request);
  const state = getProfileState(storeId, profile);
  const candidateId = requireNonEmptyString(request.candidateId, "candidateId");
  const resolved = resolveMemoryCandidate(state, candidateId);
  if (!resolved.candidate) {
    throw new Error(REPLAY_EVAL_CANDIDATE_CONTRACT_ERROR);
  }

  if (!Array.isArray(state.replayEvaluations)) {
    state.replayEvaluations = [];
  }

  const evaluatedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.evaluatedAt,
    "replay_eval.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const metrics = normalizeReplayEvalMetrics(request);
  const canaryMetrics = normalizeReplayEvalCanaryMetrics(request);
  const scoreBreakdown = computeReplayEvalScoreBreakdown(
    metrics,
    canaryMetrics
  );
  const netValueScore = scoreBreakdown.total;
  const gateThreshold = stableScore(request.gateThreshold, 0);
  const replaySafetyDeltaThreshold = Math.max(
    stableScore(
      request.safetyDeltaThreshold ?? request.safety_delta_threshold,
      DEFAULT_REPLAY_SAFETY_DELTA_THRESHOLD
    ),
    0
  );
  const canarySafetyDeltaThreshold = Math.max(
    stableScore(
      request.canaryDeltaThreshold ?? request.canary_delta_threshold,
      DEFAULT_CANARY_SAFETY_DELTA_THRESHOLD
    ),
    0
  );
  const safetyDeltas = computeReplayEvalSafetyDeltas(
    metrics,
    canaryMetrics,
    replaySafetyDeltaThreshold,
    canarySafetyDeltaThreshold
  );
  const safetyRegressionCount = safetyDeltas.totalRegressionCount;
  const pass = safetyRegressionCount === 0 && netValueScore >= gateThreshold;
  const evaluationPackId =
    normalizeBoundedString(
      request.evaluationPackId,
      "replay_eval.evaluationPackId",
      64
    ) ??
    makeId(
      "pack",
      hash(
        stableStringify({
          storeId,
          profile,
          candidateId,
          gateThreshold,
          evaluatedAt,
        })
      )
    );
  const replayEvalId =
    normalizeBoundedString(
      request.replayEvalId,
      "replay_eval.replayEvalId",
      64
    ) ??
    makeId(
      "reval",
      hash(
        stableStringify({
          candidateId,
          evaluationPackId,
          metrics,
          canaryMetrics,
          gateThreshold,
          replaySafetyDeltaThreshold,
          canarySafetyDeltaThreshold,
        })
      )
    );

  const evaluation = {
    replayEvalId,
    candidateId,
    evaluationPackId,
    metrics: stableSortObject(metrics),
    canaryMetrics: stableSortObject(canaryMetrics),
    scoreBreakdown: stableSortObject(scoreBreakdown),
    safetyDeltas: stableSortObject(safetyDeltas),
    netValueScore,
    gateThreshold,
    safetyRegressionCount,
    pass,
    evaluatedAt,
    metadata: normalizeMetadata(request.metadata),
  };
  const existingIndex = state.replayEvaluations.findIndex(
    (entry: any) => entry?.replayEvalId === replayEvalId
  );
  let action = "created";
  if (existingIndex !== -1) {
    if (
      stableStringify(state.replayEvaluations[existingIndex]) ===
      stableStringify(evaluation)
    ) {
      action = "noop";
    } else {
      action = "updated";
      state.replayEvaluations[existingIndex] = evaluation;
    }
  } else {
    state.replayEvaluations.push(evaluation);
  }
  state.replayEvaluations = sortByTimestampAndId(
    state.replayEvaluations,
    "evaluatedAt",
    "replayEvalId"
  );
  const previousNegativeNetValueStreak = toNonNegativeInteger(
    resolved.candidate.negativeNetValueStreak,
    0
  );
  let negativeNetValueStreak = previousNegativeNetValueStreak;
  if (action === "created") {
    negativeNetValueStreak =
      netValueScore < 0 ? previousNegativeNetValueStreak + 1 : 0;
  } else if (action === "updated") {
    negativeNetValueStreak = computeTrailingNegativeNetValueStreak(
      state.replayEvaluations,
      candidateId
    );
  }

  const nextCandidate = {
    ...resolved.candidate,
    latestReplayEvalId: replayEvalId,
    latestReplayStatus: pass ? "pass" : "fail",
    latestNetValueScore: netValueScore,
    negativeNetValueStreak,
    updatedAt: evaluatedAt,
  };
  state.shadowCandidates[resolved.candidateIndex] = nextCandidate;
  state.shadowCandidates = sortByTimestampAndId(
    state.shadowCandidates,
    "updatedAt",
    "candidateId"
  );
  const autoDemotionTriggerReached =
    negativeNetValueStreak >= DEFAULT_NEGATIVE_NET_VALUE_DEMOTION_STREAK;
  const autoDemotion =
    action !== "noop" && autoDemotionTriggerReached
      ? applyCandidateDemotion(
          state,
          resolveMemoryCandidate(state, candidateId),
          {
            demotedAt: evaluatedAt,
            reasonCodes: [DEMOTION_REASON_SUSTAINED_NEGATIVE_NET_VALUE],
          }
        )
      : null;
  const meta = buildMeta("replay_eval", storeId, profile, input);
  const lifecycleMetrics = buildLifecycleObservabilityMetrics(state, {
    requestDigest: meta.requestDigest,
    candidateIds: [candidateId],
    processedCount: 1,
    mutatedCount: action === "noop" ? 0 : 1,
    actionCounts: {
      created: action === "created" ? 1 : 0,
      updated: action === "updated" ? 1 : 0,
      noop: action === "noop" ? 1 : 0,
    },
    demotionReasonCodes: autoDemotion?.reasonCodes ?? [],
  });
  const lifecycleTrace = buildLifecycleTrace(meta, {
    action,
    candidateIds: [candidateId],
    metrics: lifecycleMetrics,
    details: {
      replayEvalId,
      evaluationPackId,
      gate: {
        pass,
        gateThreshold,
        safetyRegressionCount,
        severity: safetyDeltas.severity,
      },
      autoDemotion: autoDemotion
        ? {
            action: autoDemotion.action,
            reasonCodes: autoDemotion.reasonCodes,
            removedRuleId: autoDemotion.removedRuleId,
          }
        : null,
    },
  });

  return {
    ...meta,
    action,
    candidateId,
    replayEvalId,
    evaluation,
    trace: lifecycleTrace,
    autoDemotion: autoDemotion
      ? {
          action: autoDemotion.action,
          reasonCodes: autoDemotion.reasonCodes,
          removedRuleId: autoDemotion.removedRuleId,
          trigger: DEMOTION_REASON_SUSTAINED_NEGATIVE_NET_VALUE,
        }
      : null,
    gate: {
      pass,
      gateThreshold,
      safetyRegressionCount,
      replayRegressionCount: safetyDeltas.replayRegressionCount,
      canaryRegressionCount: safetyDeltas.canaryRegressionCount,
      safetyDeltaScore: safetyDeltas.safetyDeltaScore,
      severity: safetyDeltas.severity,
      replayThreshold: safetyDeltas.replayThreshold,
      canaryThreshold: safetyDeltas.canaryThreshold,
    },
    observability: {
      replaySafe: true,
      negativeNetValueStreak,
      negativeNetValueStreakThreshold:
        DEFAULT_NEGATIVE_NET_VALUE_DEMOTION_STREAK,
      autoDemotionApplied: autoDemotion?.action === "demoted",
      hasSafetyRegression: safetyRegressionCount > 0,
      safetySeverity: safetyDeltas.severity,
      lifecycleMetrics,
      tracePayload: lifecycleTrace.payload,
      slo: buildSloObservability(meta.requestDigest, "replay_eval", 45),
    },
  };
}

function runPromote(request: any) {
  const { storeId, profile, input } = normalizeRequest("promote", request);
  const state = getProfileState(storeId, profile);
  const candidateId = requireNonEmptyString(request.candidateId, "candidateId");
  const resolved = resolveMemoryCandidate(state, candidateId);
  if (!resolved.candidate) {
    throw new Error(REPLAY_EVAL_CANDIDATE_CONTRACT_ERROR);
  }

  const replayEvaluations = Array.isArray(state.replayEvaluations)
    ? state.replayEvaluations
    : [];
  const latestEvaluation =
    replayEvaluations.find(
      (entry: any) =>
        entry?.replayEvalId === resolved.candidate.latestReplayEvalId
    ) ??
    sortByTimestampAndId(
      replayEvaluations.filter(
        (entry: any) => entry?.candidateId === candidateId
      ),
      "evaluatedAt",
      "replayEvalId"
    ).at(-1) ??
    null;
  if (
    !latestEvaluation ||
    latestEvaluation.pass !== true ||
    latestEvaluation.safetyRegressionCount > 0
  ) {
    throw new Error(PROMOTE_GATE_CONTRACT_ERROR);
  }

  const promotedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.promotedAt,
    "promote.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const freshEvidenceWindowDays = Math.min(
    Math.max(
      toPositiveInteger(
        request.freshEvidenceThresholdDays ?? request.freshEvidenceWindowDays,
        DEFAULT_FRESHNESS_WARNING_DAYS
      ),
      1
    ),
    3650
  );
  const evidenceReferencePoint = normalizeIsoTimestampOrFallback(
    resolved.candidate.updatedAt ?? resolved.candidate.createdAt,
    DEFAULT_VERSION_TIMESTAMP
  );
  const freshEvidenceAgeDays = isoAgeDays(promotedAt, evidenceReferencePoint);
  const evidenceNotExpired =
    normalizeIsoTimestampOrFallback(
      resolved.candidate.expiresAt,
      DEFAULT_VERSION_TIMESTAMP
    ).localeCompare(promotedAt) >= 0;
  const hasEvidenceLinks =
    Array.isArray(resolved.candidate.evidenceEventIds) &&
    resolved.candidate.evidenceEventIds.length > 0;
  const freshEvidencePass =
    hasEvidenceLinks &&
    evidenceNotExpired &&
    freshEvidenceAgeDays <= freshEvidenceWindowDays;
  if (!freshEvidencePass) {
    const error = new Error(PROMOTE_FRESH_EVIDENCE_CONTRACT_ERROR) as Error & {
      code?: string;
      freshEvidenceWindowDays?: number;
      freshEvidenceAgeDays?: number;
      evidenceNotExpired?: boolean;
      hasEvidenceLinks?: boolean;
    };
    error.code = "PROMOTE_FRESH_EVIDENCE_STALE";
    error.freshEvidenceWindowDays = freshEvidenceWindowDays;
    error.freshEvidenceAgeDays = freshEvidenceAgeDays;
    error.evidenceNotExpired = evidenceNotExpired;
    error.hasEvidenceLinks = hasEvidenceLinks;
    throw error;
  }
  const nextCandidate = {
    ...resolved.candidate,
    status: "promoted",
    promotedAt: resolved.candidate.promotedAt ?? promotedAt,
    demotedAt: null,
    latestReplayEvalId: latestEvaluation.replayEvalId,
    latestReplayStatus: "pass",
    latestNetValueScore: latestEvaluation.netValueScore,
    updatedAt: promotedAt,
  };
  state.shadowCandidates[resolved.candidateIndex] = nextCandidate;
  state.shadowCandidates = sortByTimestampAndId(
    state.shadowCandidates,
    "updatedAt",
    "candidateId"
  );

  const promotedConfidence = clamp01(
    resolved.candidate.confidence + latestEvaluation.netValueScore / 200,
    resolved.candidate.confidence
  );
  const nextRule = {
    ruleId: resolved.candidate.ruleId,
    statement: resolved.candidate.statement,
    confidence: roundNumber(promotedConfidence, 6),
    scope: resolved.candidate.scope,
    sourceEventIds: [...resolved.candidate.sourceEventIds],
    evidenceEventIds: [...resolved.candidate.evidenceEventIds],
    promotedFromCandidateId: resolved.candidate.candidateId,
    promotedByReplayEvalId: latestEvaluation.replayEvalId,
    promotedAt: nextCandidate.promotedAt,
    updatedAt: promotedAt,
  };
  const existingRuleIndex = state.rules.findIndex(
    (rule: any) => rule.ruleId === nextRule.ruleId
  );
  let ruleAction = "created";
  if (existingRuleIndex !== -1) {
    if (
      stableStringify(state.rules[existingRuleIndex]) ===
      stableStringify(nextRule)
    ) {
      ruleAction = "noop";
    } else {
      ruleAction = "updated";
      state.rules[existingRuleIndex] = nextRule;
    }
  } else {
    state.rules.push(nextRule);
  }
  const meta = buildMeta("promote", storeId, profile, input);
  const promoteAction =
    resolved.candidate.status === "promoted" && ruleAction === "noop"
      ? "noop"
      : "promoted";
  const lifecycleMetrics = buildLifecycleObservabilityMetrics(state, {
    requestDigest: meta.requestDigest,
    candidateIds: [candidateId],
    processedCount: 1,
    mutatedCount: promoteAction === "noop" ? 0 : 1,
    actionCounts: {
      promoted: promoteAction === "promoted" ? 1 : 0,
      noop: promoteAction === "noop" ? 1 : 0,
      ruleCreated: ruleAction === "created" ? 1 : 0,
      ruleUpdated: ruleAction === "updated" ? 1 : 0,
      ruleNoop: ruleAction === "noop" ? 1 : 0,
    },
    demotionReasonCodes: nextCandidate.latestDemotionReasonCodes,
  });
  const lifecycleTrace = buildLifecycleTrace(meta, {
    action: promoteAction,
    candidateIds: [candidateId],
    metrics: lifecycleMetrics,
    details: {
      replayEvalId: latestEvaluation.replayEvalId,
      ruleAction,
      freshEvidencePass,
      freshEvidenceWindowDays,
      freshEvidenceAgeDays,
      evidenceNotExpired,
      hasEvidenceLinks,
    },
  });

  return {
    ...meta,
    action: promoteAction,
    candidate: nextCandidate,
    rule: nextRule,
    ruleAction,
    replayEvalId: latestEvaluation.replayEvalId,
    trace: lifecycleTrace,
    observability: {
      replayGatePass: true,
      safetyRegressionCount: latestEvaluation.safetyRegressionCount,
      freshEvidencePass,
      freshEvidenceWindowDays,
      freshEvidenceAgeDays,
      evidenceNotExpired,
      hasEvidenceLinks,
      replaySafe: true,
      lifecycleMetrics,
      tracePayload: lifecycleTrace.payload,
      slo: buildSloObservability(meta.requestDigest, "promote", 45),
    },
  };
}

function runDemote(request: any) {
  const { storeId, profile, input } = normalizeRequest("demote", request);
  const state = getProfileState(storeId, profile);
  const candidateId = requireNonEmptyString(request.candidateId, "candidateId");
  const resolved = resolveMemoryCandidate(state, candidateId);
  if (!resolved.candidate) {
    throw new Error(REPLAY_EVAL_CANDIDATE_CONTRACT_ERROR);
  }

  const demotedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.demotedAt,
    "demote.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const netValueThreshold = stableScore(request.netValueThreshold, 0);
  const force = request.force === true;
  const replayFailed = resolved.candidate.latestReplayStatus === "fail";
  const belowThreshold =
    stableScore(resolved.candidate.latestNetValueScore, 0) < netValueThreshold;
  const shouldDemote = force || replayFailed || belowThreshold;
  const defaultReasons = asSortedUniqueStrings(
    [
      replayFailed ? "replay_eval_fail" : null,
      belowThreshold ? "net_value_below_threshold" : null,
      force ? "manual_override" : null,
    ].filter(Boolean)
  );
  const providedReasonCodes = normalizeGuardedStringArray(
    request.reasonCodes,
    "reasonCodes"
  );
  const reasonCodes =
    providedReasonCodes.length > 0 ? providedReasonCodes : defaultReasons;
  const meta = buildMeta("demote", storeId, profile, input);
  const lifecycleCandidateIds = [candidateId];
  const lifecycleDetails = {
    threshold: netValueThreshold,
    replayFailed,
    belowThreshold,
    force,
  };

  if (!shouldDemote) {
    const existingAudit = findPolicyAuditTrailByOperationEntity(
      state,
      "demote",
      candidateId
    );
    const lifecycleMetrics = buildLifecycleObservabilityMetrics(state, {
      requestDigest: meta.requestDigest,
      candidateIds: lifecycleCandidateIds,
      processedCount: 1,
      mutatedCount: 0,
      actionCounts: {
        noop: 1,
      },
      demotionReasonCodes: reasonCodes,
    });
    const lifecycleTrace = buildLifecycleTrace(meta, {
      action: "noop",
      candidateIds: lifecycleCandidateIds,
      metrics: lifecycleMetrics,
      details: {
        ...lifecycleDetails,
        reasonCodes,
        demotionApplied: false,
      },
    });
    return {
      ...meta,
      action: "noop",
      candidate: resolved.candidate,
      reasonCodes,
      threshold: netValueThreshold,
      trace: lifecycleTrace,
      policyAuditEventId: existingAudit?.auditEventId ?? null,
      observability: {
        replaySafe: true,
        demotionApplied: false,
        lifecycleMetrics,
        tracePayload: lifecycleTrace.payload,
        slo: buildSloObservability(meta.requestDigest, "demote", 40),
      },
    };
  }

  const demotion = applyCandidateDemotion(state, resolved, {
    demotedAt,
    reasonCodes,
  });
  const existingAudit = findPolicyAuditTrailByOperationEntity(
    state,
    "demote",
    candidateId
  );
  const auditEvent =
    demotion.action !== "demoted"
      ? null
      : appendPolicyAuditTrail(state, {
          operation: "demote",
          storeId,
          profile,
          entityId: candidateId,
          outcome: "demoted",
          reasonCodes,
          details: {
            threshold: netValueThreshold,
            replayFailed,
            belowThreshold,
            force,
            demotedAt,
            removedRuleId: demotion.removedRuleId,
          },
          timestamp: demotedAt,
        });
  const lifecycleMetrics = buildLifecycleObservabilityMetrics(state, {
    requestDigest: meta.requestDigest,
    candidateIds: lifecycleCandidateIds,
    processedCount: 1,
    mutatedCount: demotion.action === "demoted" ? 1 : 0,
    actionCounts: {
      demoted: demotion.action === "demoted" ? 1 : 0,
      noop: demotion.action === "noop" ? 1 : 0,
    },
    demotionReasonCodes: reasonCodes,
  });
  const lifecycleTrace = buildLifecycleTrace(meta, {
    action: demotion.action,
    candidateIds: lifecycleCandidateIds,
    metrics: lifecycleMetrics,
    details: {
      ...lifecycleDetails,
      reasonCodes,
      demotionApplied: demotion.action === "demoted",
      removedRuleId: demotion.removedRuleId,
    },
  });

  return {
    ...meta,
    action: demotion.action,
    candidate: demotion.candidate ?? resolved.candidate,
    removedRuleId: demotion.removedRuleId,
    reasonCodes,
    threshold: netValueThreshold,
    trace: lifecycleTrace,
    policyAuditEventId:
      auditEvent?.auditEventId ?? existingAudit?.auditEventId ?? null,
    observability: {
      replaySafe: true,
      demotionApplied: demotion.action === "demoted",
      ruleRemoved: Boolean(demotion.removedRuleId),
      lifecycleMetrics,
      tracePayload: lifecycleTrace.payload,
      slo: buildSloObservability(meta.requestDigest, "demote", 40),
    },
  };
}

function runAddWeight(request: any) {
  const { storeId, profile, input } = normalizeRequest("addweight", request);
  const state = getProfileState(storeId, profile);
  const normalized = normalizeAddWeightRequest(request, storeId, profile);
  const ledgerEntry = findWeightAdjustmentLedgerEntry(
    state,
    normalized.adjustmentId
  );
  if (ledgerEntry) {
    const existingDigest =
      normalizeBoundedString(
        ledgerEntry.idempotencyDigest,
        "weightAdjustmentLedger.idempotencyDigest",
        128
      ) ?? null;
    if (existingDigest && existingDigest !== normalized.idempotencyDigest) {
      throw new Error(ADDWEIGHT_ADJUSTMENT_COLLISION_CONTRACT_ERROR);
    }
    const resolvedCandidate = resolveMemoryCandidate(
      state,
      normalized.candidateId
    );
    const meta = buildMeta("addweight", storeId, profile, input);
    return {
      ...meta,
      action: "noop",
      candidate: resolvedCandidate.candidate
        ? buildShadowWriteAppliedEntry(resolvedCandidate.candidate, "noop")
        : null,
      adjustment: {
        adjustmentId: normalized.adjustmentId,
        requestedDelta: normalized.requestedDelta,
        appliedDelta: 0,
        reason: normalized.reason,
        actor: normalized.actor,
        sourceEventIds: normalized.sourceEventIds,
        evidenceEventIds: normalized.evidenceEventIds,
        metadata: normalized.metadata,
        timestamp: normalized.timestamp,
      },
      ruleAction: "noop",
      policyAuditEventId: ledgerEntry.auditEventId ?? null,
      observability: {
        replaySafe: true,
        deterministicNoop: true,
        slo: buildSloObservability(meta.requestDigest, "addweight", 35),
      },
    };
  }

  const resolved = resolveMemoryCandidate(state, normalized.candidateId);
  if (!resolved.candidate) {
    throw new Error(ADDWEIGHT_CANDIDATE_CONTRACT_ERROR);
  }
  const meta = buildMeta("addweight", storeId, profile, input);
  const existingAuditEvent = findExistingAddWeightAuditEvent(
    state,
    normalized.adjustmentId
  );
  if (existingAuditEvent) {
    const existingDigest =
      normalizeBoundedString(
        existingAuditEvent?.details?.idempotencyDigest,
        "policyAuditTrail.idempotencyDigest",
        128
      ) ?? null;
    if (existingDigest && existingDigest !== normalized.idempotencyDigest) {
      throw new Error(ADDWEIGHT_ADJUSTMENT_COLLISION_CONTRACT_ERROR);
    }
    const persisted = upsertWeightAdjustmentLedgerEntry(state, {
      adjustmentId: normalized.adjustmentId,
      idempotencyDigest: normalized.idempotencyDigest,
      candidateId: normalized.candidateId,
      auditEventId: existingAuditEvent.auditEventId,
      timestamp: normalized.timestamp,
    });
    return {
      ...meta,
      action: "noop",
      candidate: buildShadowWriteAppliedEntry(resolved.candidate, "noop"),
      adjustment: {
        adjustmentId: normalized.adjustmentId,
        requestedDelta: normalized.requestedDelta,
        appliedDelta: 0,
        reason: normalized.reason,
        actor: normalized.actor,
        sourceEventIds: normalized.sourceEventIds,
        evidenceEventIds: normalized.evidenceEventIds,
        metadata: normalized.metadata,
        timestamp: normalized.timestamp,
      },
      ruleAction: "noop",
      policyAuditEventId:
        persisted.auditEventId ?? existingAuditEvent.auditEventId,
      observability: {
        replaySafe: true,
        deterministicNoop: true,
        slo: buildSloObservability(meta.requestDigest, "addweight", 35),
      },
    };
  }

  const previousConfidence = clamp01(resolved.candidate.confidence, 0.5);
  const nextConfidence = roundNumber(
    clamp01(previousConfidence + normalized.requestedDelta, previousConfidence),
    6
  );
  const appliedDelta = roundNumber(nextConfidence - previousConfidence, 6);
  const nextCandidate = {
    ...resolved.candidate,
    confidence: nextConfidence,
    updatedAt: normalized.timestamp,
    metadata: stableSortObject({
      ...resolved.candidate.metadata,
      latestWeightAdjustment: {
        adjustmentId: normalized.adjustmentId,
        requestedDelta: normalized.requestedDelta,
        appliedDelta,
        reason: normalized.reason,
        actor: normalized.actor,
        sourceEventIds: normalized.sourceEventIds,
        evidenceEventIds: normalized.evidenceEventIds,
        metadata: normalized.metadata,
        timestamp: normalized.timestamp,
      },
    }),
  };
  state.shadowCandidates[resolved.candidateIndex] = nextCandidate;
  state.shadowCandidates = sortByTimestampAndId(
    state.shadowCandidates,
    "updatedAt",
    "candidateId"
  );

  let ruleAction = "skipped";
  if (Array.isArray(state.rules)) {
    const existingRuleIndex = state.rules.findIndex(
      (rule: any) => rule.ruleId === resolved.candidate.ruleId
    );
    if (existingRuleIndex !== -1) {
      const existingRule = state.rules[existingRuleIndex];
      const nextRule = {
        ...existingRule,
        confidence: nextConfidence,
        updatedAt: normalized.timestamp,
      };
      if (stableStringify(existingRule) === stableStringify(nextRule)) {
        ruleAction = "noop";
      } else {
        ruleAction = "updated";
        state.rules[existingRuleIndex] = nextRule;
      }
    }
  }

  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "addweight",
    storeId,
    profile,
    entityId: normalized.candidateId,
    outcome: "recorded",
    reasonCodes: normalized.reasonCodes,
    details: {
      adjustmentId: normalized.adjustmentId,
      idempotencyDigest: normalized.idempotencyDigest,
      candidateId: normalized.candidateId,
      ruleId: resolved.candidate.ruleId ?? null,
      requestedDelta: normalized.requestedDelta,
      appliedDelta,
      previousConfidence,
      nextConfidence,
      reason: normalized.reason,
      actor: normalized.actor,
      sourceEventIds: normalized.sourceEventIds,
      evidenceEventIds: normalized.evidenceEventIds,
      metadata: normalized.metadata,
      timestamp: normalized.timestamp,
      ruleAction,
    },
    timestamp: normalized.timestamp,
  });
  upsertWeightAdjustmentLedgerEntry(state, {
    adjustmentId: normalized.adjustmentId,
    idempotencyDigest: normalized.idempotencyDigest,
    candidateId: normalized.candidateId,
    auditEventId: auditEvent.auditEventId,
    timestamp: normalized.timestamp,
  });

  return {
    ...meta,
    action: "adjusted",
    candidate: buildShadowWriteAppliedEntry(nextCandidate, "updated"),
    adjustment: {
      adjustmentId: normalized.adjustmentId,
      requestedDelta: normalized.requestedDelta,
      appliedDelta,
      previousConfidence,
      nextConfidence,
      reason: normalized.reason,
      actor: normalized.actor,
      sourceEventIds: normalized.sourceEventIds,
      evidenceEventIds: normalized.evidenceEventIds,
      metadata: normalized.metadata,
      timestamp: normalized.timestamp,
      effective: appliedDelta !== 0,
    },
    ruleAction,
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      replaySafe: true,
      weightAdjusted: appliedDelta !== 0,
      slo: buildSloObservability(meta.requestDigest, "addweight", 35),
    },
  };
}

function runLearnerProfileUpdate(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "learner_profile_update",
    request
  );
  const state = getProfileState(storeId, profile);
  const incoming = normalizeLearnerProfileUpdateRequest(
    request,
    storeId,
    profile
  );
  const meta = buildMeta("learner_profile_update", storeId, profile, input);
  const existingIndex = state.learnerProfiles.findIndex(
    (learnerProfile: any) => learnerProfile.profileId === incoming.profileId
  );
  let action = "created";
  let next = mergeLearnerProfile(
    createEmptyLearnerProfileSeed(incoming),
    incoming,
    "created"
  );

  if (existingIndex !== -1) {
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
  const lineageRevisionCount = Object.values(
    next.attributeLineage ?? {}
  ).reduce(
    (accumulator: any, entries: any) =>
      accumulator + (Array.isArray(entries) ? entries.length : 0),
    0
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
      slo: buildSloObservability(
        meta.requestDigest,
        "learner_profile_update",
        45
      ),
    },
  };
}

function runIdentityGraphUpdate(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "identity_graph_update",
    request
  );
  const state = getProfileState(storeId, profile);
  const incoming = normalizeIdentityGraphUpdateRequest(
    request,
    storeId,
    profile
  );
  const meta = buildMeta("identity_graph_update", storeId, profile, input);
  const existingIndex = state.identityGraphEdges.findIndex(
    (edge: any) => edge.edgeId === incoming.edgeId
  );
  let action = "created";
  let next = incoming;

  if (existingIndex !== -1) {
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
      endpointsDistinct:
        next.fromRef.namespace !== next.toRef.namespace ||
        next.fromRef.value !== next.toRef.value,
      slo: buildSloObservability(
        meta.requestDigest,
        "identity_graph_update",
        40
      ),
    },
  };
}

function runMisconceptionUpdate(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "misconception_update",
    request
  );
  const state = getProfileState(storeId, profile);
  const incoming = normalizeMisconceptionUpdateRequest(
    request,
    storeId,
    profile
  );
  const meta = buildMeta("misconception_update", storeId, profile, input);
  const existingIndex = state.misconceptions.findIndex(
    (record: any) => record.misconceptionId === incoming.misconceptionId
  );
  let action = "created";
  let next = incoming;
  let previous = null;
  let chronologyNote = null;

  if (existingIndex !== -1) {
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
          DEFAULT_VERSION_TIMESTAMP
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
              })
            )
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
      confidenceDecayStage: toNonNegativeInteger(
        next?.confidenceDecay?.stage,
        0
      ),
      confidenceDecayAppliedDelta: toFiniteNumber(
        next?.confidenceDecay?.appliedDelta,
        0
      ),
      confidenceDecayAccelerated: Boolean(next?.confidenceDecay?.accelerated),
      antiPatternCount: Array.isArray(next?.antiPatterns)
        ? next.antiPatterns.length
        : 0,
      antiPatternEvidenceCount: new Set(
        (Array.isArray(next?.antiPatterns) ? next.antiPatterns : []).flatMap(
          (entry: any) => entry.evidenceEventIds ?? []
        )
      ).size,
      chronologyCount: Array.isArray(state.misconceptionChronologyHistory)
        ? state.misconceptionChronologyHistory.filter(
            (entry: any) => entry.misconceptionId === next.misconceptionId
          ).length
        : 0,
      storeIsolationEnforced: true,
      slo: buildSloObservability(
        meta.requestDigest,
        "misconception_update",
        35
      ),
    },
  };
}

function runCurriculumPlanUpdate(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "curriculum_plan_update",
    request
  );
  const state = getProfileState(storeId, profile);
  const incoming = normalizeCurriculumPlanUpdateRequest(
    request,
    storeId,
    profile
  );
  const meta = buildMeta("curriculum_plan_update", storeId, profile, input);
  const existingIndex = state.curriculumPlanItems.findIndex(
    (item: any) => item.planItemId === incoming.planItemId
  );
  let action = "created";
  let next = incoming;
  let previous = null;
  let conflictNote = null;

  if (existingIndex !== -1) {
    previous = state.curriculumPlanItems[existingIndex];
    const merged = mergeCurriculumPlanItem(previous, incoming);
    if (stableStringify(previous) === stableStringify(merged)) {
      action = "noop";
      next = previous;
    } else {
      action = "updated";
      next = merged;
      state.curriculumPlanItems[existingIndex] = merged;
      const changedFields = summarizeCurriculumConflictChanges(
        previous,
        merged
      );
      if (changedFields.length > 0) {
        const timestamp = normalizeIsoTimestampOrFallback(
          merged.updatedAt ?? incoming.updatedAt,
          DEFAULT_VERSION_TIMESTAMP
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
              })
            )
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
        ? state.curriculumConflictHistory.filter(
            (entry: any) => entry.planItemId === next.planItemId
          ).length
        : 0,
      slo: buildSloObservability(
        meta.requestDigest,
        "curriculum_plan_update",
        40
      ),
    },
  };
}

function runReviewScheduleUpdate(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "review_schedule_update",
    request
  );
  const state = getProfileState(storeId, profile);
  const incoming = normalizeReviewScheduleUpdateRequest(
    request,
    storeId,
    profile
  );
  const meta = buildMeta("review_schedule_update", storeId, profile, input);
  const existingIndex = state.reviewScheduleEntries.findIndex(
    (entry: any) => entry.scheduleEntryId === incoming.scheduleEntryId
  );
  let action = "created";
  let next = incoming;

  if (existingIndex !== -1) {
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
      slo: buildSloObservability(
        meta.requestDigest,
        "review_schedule_update",
        35
      ),
    },
  };
}

function runPolicyDecisionUpdate(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "policy_decision_update",
    request
  );
  const state = getProfileState(storeId, profile);
  const incoming = normalizePolicyDecisionUpdateRequest(
    request,
    storeId,
    profile
  );
  const pluginInvocation = invokePolicyPackPluginForDecisionUpdate(
    storeId,
    incoming
  );
  const pluginAwareIncoming = applyPolicyPackInvocationToDecision(
    incoming,
    pluginInvocation
  );
  const meta = buildMeta("policy_decision_update", storeId, profile, input);
  const existingIndex = state.policyDecisions.findIndex(
    (decision: any) => decision.decisionId === pluginAwareIncoming.decisionId
  );
  let action = "created";
  let next = pluginAwareIncoming;

  if (existingIndex !== -1) {
    const existing = state.policyDecisions[existingIndex];
    const merged = mergePolicyDecision(existing, pluginAwareIncoming);
    if (stableStringify(existing) === stableStringify(merged)) {
      action = "noop";
      next = existing;
    } else {
      action = "updated";
      next = merged;
      state.policyDecisions[existingIndex] = merged;
    }
  } else {
    state.policyDecisions.push(pluginAwareIncoming);
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
      pluginInvocation: toPolicyPackPluginAuditMetadata(pluginInvocation),
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
      pluginFailClosed: pluginInvocation.status === "fail_closed",
      slo: buildSloObservability(
        meta.requestDigest,
        "policy_decision_update",
        45
      ),
    },
  };
}

function runPainSignalIngest(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "pain_signal_ingest",
    request
  );
  const state = getProfileState(storeId, profile);
  const normalized = normalizePainSignalIngestRequest(
    request,
    storeId,
    profile
  );
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
  const signalUpsert = upsertDeterministicRecord(
    state.painSignals,
    "painSignalId",
    record,
    "recordedAt"
  );
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
      ...normalized.metadata,
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

function runFailureSignalIngest(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "failure_signal_ingest",
    request
  );
  const state = getProfileState(storeId, profile);
  const normalized = normalizeFailureSignalIngestRequest(
    request,
    storeId,
    profile
  );
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
  const signalUpsert = upsertDeterministicRecord(
    state.failureSignals,
    "failureSignalId",
    record,
    "recordedAt"
  );
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
      ...normalized.metadata,
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
      slo: buildSloObservability(
        meta.requestDigest,
        "failure_signal_ingest",
        40
      ),
    },
  };
}

function applyManualPromotionOverride(
  state: any,
  {
    overrideControlId,
    reasonCodes = [],
    targetCandidateIds = [],
    targetRuleIds = [],
    recordedAt = DEFAULT_VERSION_TIMESTAMP,
  }: any = {}
) {
  const normalizedReasonCodes = mergeStringLists(reasonCodes, [
    "manual_override_promote",
  ]);
  const resolvedCandidateIds = resolveDemotionTargetCandidateIds(
    state,
    targetRuleIds,
    targetCandidateIds
  );
  const explicitRuleIds = asSortedUniqueStrings(targetRuleIds);
  const unresolvedRuleIds = new Set(explicitRuleIds);
  const candidateActions = [];
  const promotedCandidateIds = [];
  const promotedRuleIds = [];
  const alreadyPromotedCandidateIds = [];
  const missingCandidateIds = [];

  for (const candidateId of resolvedCandidateIds) {
    const resolved = resolveMemoryCandidate(state, candidateId);
    if (!resolved.candidate) {
      missingCandidateIds.push(candidateId);
      candidateActions.push({
        candidateId,
        action: "missing",
      });
      continue;
    }

    const previousCandidate = resolved.candidate;
    const previousStatus = previousCandidate.status ?? "shadow";
    unresolvedRuleIds.delete(previousCandidate.ruleId);

    const nextCandidate =
      previousStatus === "promoted"
        ? previousCandidate
        : {
            ...previousCandidate,
            status: "promoted",
            promotedAt: previousCandidate.promotedAt ?? recordedAt,
            demotedAt: null,
            latestDemotionReasonCodes: [],
            updatedAt: recordedAt,
          };
    if (previousStatus !== "promoted") {
      state.shadowCandidates[resolved.candidateIndex] = nextCandidate;
      promotedCandidateIds.push(candidateId);
    }

    const nextRule = {
      ruleId: nextCandidate.ruleId,
      statement: nextCandidate.statement,
      confidence: roundNumber(clamp01(nextCandidate.confidence, 0.5), 6),
      scope: nextCandidate.scope,
      sourceEventIds: mergeStringLists([], nextCandidate.sourceEventIds),
      evidenceEventIds: mergeStringLists([], nextCandidate.evidenceEventIds),
      promotedFromCandidateId: nextCandidate.candidateId,
      promotedByReplayEvalId: nextCandidate.latestReplayEvalId,
      promotedAt: nextCandidate.promotedAt ?? recordedAt,
      updatedAt: recordedAt,
    };

    let ruleAction = "created";
    const existingRuleIndex = state.rules.findIndex(
      (rule: any) => rule?.ruleId === nextCandidate.ruleId
    );
    if (existingRuleIndex !== -1) {
      const existingRule = state.rules[existingRuleIndex];
      if (stableStringify(existingRule) === stableStringify(nextRule)) {
        ruleAction = "noop";
      } else {
        ruleAction = "updated";
        state.rules[existingRuleIndex] = nextRule;
      }
    } else {
      state.rules.push(nextRule);
    }

    if (ruleAction !== "noop") {
      promotedRuleIds.push(nextCandidate.ruleId);
    }
    if (previousStatus === "promoted" && ruleAction === "noop") {
      alreadyPromotedCandidateIds.push(candidateId);
    }
    candidateActions.push({
      candidateId,
      action:
        previousStatus === "promoted" && ruleAction === "noop"
          ? "already_promoted"
          : "promoted",
      previousStatus,
      nextStatus: "promoted",
      ruleId: nextCandidate.ruleId,
      ruleAction,
    });
  }

  state.shadowCandidates = sortByTimestampAndId(
    state.shadowCandidates,
    "updatedAt",
    "candidateId"
  );
  state.rules = sortByTimestampAndId(state.rules, "updatedAt", "ruleId");

  const missingRuleIds = asSortedUniqueStrings([...unresolvedRuleIds]);
  const promotedCandidateIdsSorted =
    asSortedUniqueStrings(promotedCandidateIds);
  const promotedRuleIdsSorted = asSortedUniqueStrings(promotedRuleIds);
  const overridePathId = makeId(
    "mpath",
    hash(
      stableStringify({
        overrideControlId,
        targetCandidateIds: asSortedUniqueStrings(targetCandidateIds),
        targetRuleIds: explicitRuleIds,
        resolvedCandidateIds,
        promotedCandidateIds: promotedCandidateIdsSorted,
        promotedRuleIds: promotedRuleIdsSorted,
        recordedAt,
      })
    )
  );

  return {
    overridePathId,
    targetCandidateIds: asSortedUniqueStrings(targetCandidateIds),
    targetRuleIds: explicitRuleIds,
    resolvedCandidateIds,
    promotedCandidateIds: promotedCandidateIdsSorted,
    promotedRuleIds: promotedRuleIdsSorted,
    alreadyPromotedCandidateIds: asSortedUniqueStrings(
      alreadyPromotedCandidateIds
    ),
    missingCandidateIds: asSortedUniqueStrings(missingCandidateIds),
    missingRuleIds,
    candidateActions,
    changed:
      promotedCandidateIdsSorted.length > 0 || promotedRuleIdsSorted.length > 0,
    reasonCodes: normalizedReasonCodes,
  };
}

function applyIncidentEscalationQuarantine(
  state: any,
  {
    escalationSignalId,
    severity,
    reasonCodes = [],
    targetCandidateIds = [],
    targetRuleIds = [],
    triggerReasonCode = "incident_quarantine_triggered",
    recordedAt = DEFAULT_VERSION_TIMESTAMP,
  }: any = {}
) {
  const normalizedReasonCodes = mergeStringLists(reasonCodes, [
    triggerReasonCode,
  ]);
  const resolvedCandidateIds = resolveDemotionTargetCandidateIds(
    state,
    targetRuleIds,
    targetCandidateIds
  );
  const candidateActions = [];
  const demotedCandidateIds = [];
  const alreadyQuarantinedCandidateIds = [];
  const missingCandidateIds = [];
  const removedRuleIdsViaCandidates = [];

  for (const candidateId of resolvedCandidateIds) {
    const resolved = resolveMemoryCandidate(state, candidateId);
    if (!resolved.candidate) {
      missingCandidateIds.push(candidateId);
      candidateActions.push({
        candidateId,
        action: "missing",
      });
      continue;
    }
    const previousStatus = resolved.candidate.status ?? "shadow";
    const demotion = applyCandidateDemotion(state, resolved, {
      demotedAt: recordedAt,
      reasonCodes: normalizedReasonCodes,
    });
    if (demotion.action === "demoted") {
      demotedCandidateIds.push(candidateId);
    } else {
      alreadyQuarantinedCandidateIds.push(candidateId);
    }
    if (demotion.removedRuleId) {
      removedRuleIdsViaCandidates.push(demotion.removedRuleId);
    }
    candidateActions.push({
      candidateId,
      action:
        demotion.action === "demoted" ? "quarantined" : "already_quarantined",
      previousStatus,
      nextStatus: demotion.candidate?.status ?? previousStatus,
      removedRuleId: demotion.removedRuleId,
    });
  }

  const candidateRemovedRuleIds = asSortedUniqueStrings(
    removedRuleIdsViaCandidates
  );
  const candidateRemovedRuleSet = new Set(candidateRemovedRuleIds);
  const directRuleActions = [];
  const directlyQuarantinedRuleIds = [];
  const missingRuleIds = [];
  const explicitRuleIds = asSortedUniqueStrings(targetRuleIds);
  for (const ruleId of explicitRuleIds) {
    if (candidateRemovedRuleSet.has(ruleId)) {
      directRuleActions.push({
        ruleId,
        action: "quarantined_via_candidate",
      });
      continue;
    }
    const existingRuleIndex = state.rules.findIndex(
      (rule: any) => rule?.ruleId === ruleId
    );
    if (existingRuleIndex === -1) {
      missingRuleIds.push(ruleId);
      directRuleActions.push({
        ruleId,
        action: "missing",
      });
      continue;
    }
    state.rules.splice(existingRuleIndex, 1);
    directlyQuarantinedRuleIds.push(ruleId);
    directRuleActions.push({
      ruleId,
      action: "quarantined",
    });
  }

  const quarantinedRuleIds = asSortedUniqueStrings([
    ...candidateRemovedRuleIds,
    ...directlyQuarantinedRuleIds,
  ]);
  const quarantinePathId = makeId(
    "qpath",
    hash(
      stableStringify({
        escalationSignalId,
        severity,
        targetCandidateIds: asSortedUniqueStrings(targetCandidateIds),
        targetRuleIds: explicitRuleIds,
        resolvedCandidateIds,
        demotedCandidateIds,
        quarantinedRuleIds,
        recordedAt,
      })
    )
  );

  return {
    quarantinePathId,
    targetCandidateIds: asSortedUniqueStrings(targetCandidateIds),
    targetRuleIds: explicitRuleIds,
    resolvedCandidateIds,
    candidateActions,
    demotedCandidateIds: asSortedUniqueStrings(demotedCandidateIds),
    alreadyQuarantinedCandidateIds: asSortedUniqueStrings(
      alreadyQuarantinedCandidateIds
    ),
    missingCandidateIds: asSortedUniqueStrings(missingCandidateIds),
    quarantinedRuleIds,
    ruleActions: directRuleActions,
    missingRuleIds: asSortedUniqueStrings(missingRuleIds),
    changed:
      demotedCandidateIds.length > 0 || directlyQuarantinedRuleIds.length > 0,
    reasonCodes: normalizedReasonCodes,
  };
}

function runManualQuarantineOverride(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "manual_quarantine_override",
    request
  );
  const state = getProfileState(storeId, profile);
  const normalized = normalizeManualQuarantineOverrideRequest(
    request,
    storeId,
    profile
  );
  const meta = buildMeta("manual_quarantine_override", storeId, profile, input);
  const record = {
    overrideControlId: normalized.overrideControlId,
    idempotencyDigest: normalized.idempotencyDigest,
    overrideAction: normalized.overrideAction,
    actor: normalized.actor,
    reason: normalized.reason,
    reasonCodes: normalized.reasonCodes,
    targetCandidateIds: normalized.targetCandidateIds,
    targetRuleIds: normalized.targetRuleIds,
    evidenceEventIds: normalized.evidenceEventIds,
    sourceEventIds: normalized.sourceEventIds,
    metadata: normalized.metadata,
    recordedAt: normalized.recordedAt,
  };
  const overrideUpsert = upsertDeterministicRecord(
    state.manualOverrideControls,
    "overrideControlId",
    record,
    "recordedAt"
  );
  state.manualOverrideControls = overrideUpsert.nextRecords;

  const operationReasonCodes = mergeStringLists(normalized.reasonCodes, [
    normalized.overrideAction === "promote"
      ? "manual_override_promote"
      : "manual_override_suppress",
  ]);
  const overrideExecution: any =
    normalized.overrideAction === "promote"
      ? applyManualPromotionOverride(state, {
          overrideControlId: normalized.overrideControlId,
          reasonCodes: operationReasonCodes,
          targetCandidateIds: normalized.targetCandidateIds,
          targetRuleIds: normalized.targetRuleIds,
          recordedAt: normalized.recordedAt,
        })
      : applyIncidentEscalationQuarantine(state, {
          escalationSignalId: normalized.overrideControlId,
          severity: "critical",
          reasonCodes: operationReasonCodes,
          targetCandidateIds: normalized.targetCandidateIds,
          targetRuleIds: normalized.targetRuleIds,
          triggerReasonCode: "manual_quarantine_triggered",
          recordedAt: normalized.recordedAt,
        });
  const action =
    overrideUpsert.action === "noop" && !overrideExecution.changed
      ? "noop"
      : overrideUpsert.action === "created"
        ? "created"
        : "updated";
  const existingAudit = findPolicyAuditTrailByOperationEntity(
    state,
    "manual_quarantine_override",
    normalized.overrideControlId
  );
  const auditEvent =
    action === "noop"
      ? null
      : appendPolicyAuditTrail(state, {
          operation: "manual_quarantine_override",
          storeId,
          profile,
          entityId: normalized.overrideControlId,
          outcome:
            normalized.overrideAction === "promote"
              ? overrideExecution.changed
                ? "allow"
                : "review"
              : "deny",
          reasonCodes: overrideExecution.reasonCodes,
          details: {
            overrideAction: normalized.overrideAction,
            actor: normalized.actor,
            reason: normalized.reason,
            idempotencyDigest: normalized.idempotencyDigest,
            targetCandidateIds: overrideExecution.targetCandidateIds,
            targetRuleIds: overrideExecution.targetRuleIds,
            resolvedCandidateIds: overrideExecution.resolvedCandidateIds,
            changed: overrideExecution.changed,
            demotedCandidateIds: overrideExecution.demotedCandidateIds ?? [],
            quarantinedRuleIds: overrideExecution.quarantinedRuleIds ?? [],
            promotedCandidateIds: overrideExecution.promotedCandidateIds ?? [],
            promotedRuleIds: overrideExecution.promotedRuleIds ?? [],
            missingCandidateIds: overrideExecution.missingCandidateIds ?? [],
            missingRuleIds: overrideExecution.missingRuleIds ?? [],
            evidenceEventIds: normalized.evidenceEventIds,
            sourceEventIds: normalized.sourceEventIds,
          },
          timestamp: normalized.recordedAt,
        });
  const isPromoteAction = normalized.overrideAction === "promote";

  return {
    ...meta,
    action,
    overrideControlId: normalized.overrideControlId,
    controlDigest: hash(stableStringify(overrideUpsert.record)),
    controlRecord: overrideUpsert.record,
    override: {
      action: normalized.overrideAction,
      actor: normalized.actor,
      pathId:
        overrideExecution.overridePathId ?? overrideExecution.quarantinePathId,
      targetCandidateIds: overrideExecution.targetCandidateIds,
      targetRuleIds: overrideExecution.targetRuleIds,
      resolvedCandidateIds: overrideExecution.resolvedCandidateIds,
      changed: overrideExecution.changed,
      reasonCodes: overrideExecution.reasonCodes,
      candidateActions: overrideExecution.candidateActions,
      ruleActions: overrideExecution.ruleActions ?? [],
      demotedCandidateIds: overrideExecution.demotedCandidateIds ?? [],
      quarantinedRuleIds: overrideExecution.quarantinedRuleIds ?? [],
      alreadyQuarantinedCandidateIds:
        overrideExecution.alreadyQuarantinedCandidateIds ?? [],
      promotedCandidateIds: overrideExecution.promotedCandidateIds ?? [],
      promotedRuleIds: overrideExecution.promotedRuleIds ?? [],
      alreadyPromotedCandidateIds:
        overrideExecution.alreadyPromotedCandidateIds ?? [],
      missingCandidateIds: overrideExecution.missingCandidateIds ?? [],
      missingRuleIds: overrideExecution.missingRuleIds ?? [],
    },
    policyAuditEventId:
      auditEvent?.auditEventId ?? existingAudit?.auditEventId ?? null,
    observability: {
      overrideAction: normalized.overrideAction,
      promoteOverrideApplied: isPromoteAction && overrideExecution.changed,
      quarantineOverrideApplied: !isPromoteAction && overrideExecution.changed,
      mutationCount:
        (overrideExecution.demotedCandidateIds?.length ?? 0) +
        (overrideExecution.quarantinedRuleIds?.length ?? 0) +
        (overrideExecution.promotedCandidateIds?.length ?? 0) +
        (overrideExecution.promotedRuleIds?.length ?? 0),
      evidenceCount: normalized.evidenceEventIds.length,
      provenanceCount: normalized.sourceEventIds.length,
      totalManualOverrideControls: state.manualOverrideControls.length,
      replaySafe: true,
      slo: buildSloObservability(
        meta.requestDigest,
        "manual_quarantine_override",
        35
      ),
    },
  };
}

function runIncidentEscalationSignal(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "incident_escalation_signal",
    request
  );
  const state = getProfileState(storeId, profile);
  const normalized = normalizeIncidentEscalationSignalRequest(
    request,
    storeId,
    profile
  );
  const meta = buildMeta("incident_escalation_signal", storeId, profile, input);
  const record = {
    escalationSignalId: normalized.escalationSignalId,
    idempotencyDigest: normalized.idempotencyDigest,
    incidentRef: normalized.incidentRef,
    escalationType: normalized.escalationType,
    severity: normalized.severity,
    note: normalized.note,
    targetCandidateIds: normalized.targetCandidateIds,
    targetRuleIds: normalized.targetRuleIds,
    evidenceEventIds: normalized.evidenceEventIds,
    sourceEventIds: normalized.sourceEventIds,
    reasonCodes: normalized.reasonCodes,
    quarantineRequired: normalized.quarantineRequired,
    metadata: normalized.metadata,
    recordedAt: normalized.recordedAt,
  };
  const escalationUpsert = upsertDeterministicRecord(
    state.incidentEscalations,
    "escalationSignalId",
    record,
    "recordedAt"
  );
  state.incidentEscalations = escalationUpsert.nextRecords;

  const quarantine = normalized.quarantineRequired
    ? applyIncidentEscalationQuarantine(state, {
        escalationSignalId: normalized.escalationSignalId,
        severity: normalized.severity,
        reasonCodes: normalized.reasonCodes,
        targetCandidateIds: normalized.targetCandidateIds,
        targetRuleIds: normalized.targetRuleIds,
        recordedAt: normalized.recordedAt,
      })
    : {
        quarantinePathId: null,
        targetCandidateIds: normalized.targetCandidateIds,
        targetRuleIds: normalized.targetRuleIds,
        resolvedCandidateIds: [],
        candidateActions: [],
        demotedCandidateIds: [],
        alreadyQuarantinedCandidateIds: [],
        missingCandidateIds: [],
        quarantinedRuleIds: [],
        ruleActions: [],
        missingRuleIds: [],
        changed: false,
        reasonCodes: normalized.reasonCodes,
      };
  const action =
    escalationUpsert.action === "noop" && !quarantine.changed
      ? "noop"
      : escalationUpsert.action === "created"
        ? "created"
        : "updated";
  const existingAudit = findPolicyAuditTrailByOperationEntity(
    state,
    "incident_escalation_signal",
    normalized.escalationSignalId
  );
  const auditEvent =
    action === "noop"
      ? null
      : appendPolicyAuditTrail(state, {
          operation: "incident_escalation_signal",
          storeId,
          profile,
          entityId: normalized.escalationSignalId,
          outcome: normalized.quarantineRequired ? "deny" : "review",
          reasonCodes:
            normalized.quarantineRequired && quarantine.changed
              ? mergeStringLists(normalized.reasonCodes, [
                  "incident_quarantine_triggered",
                ])
              : normalized.reasonCodes,
          details: {
            escalationType: normalized.escalationType,
            severity: normalized.severity,
            incidentRef: normalized.incidentRef,
            idempotencyDigest: normalized.idempotencyDigest,
            quarantineRequired: normalized.quarantineRequired,
            quarantinePathId: quarantine.quarantinePathId,
            targetCandidateIds: quarantine.targetCandidateIds,
            targetRuleIds: quarantine.targetRuleIds,
            demotedCandidateIds: quarantine.demotedCandidateIds,
            quarantinedRuleIds: quarantine.quarantinedRuleIds,
            missingCandidateIds: quarantine.missingCandidateIds,
            missingRuleIds: quarantine.missingRuleIds,
          },
          timestamp: normalized.recordedAt,
        });

  return {
    ...meta,
    action,
    escalationSignalId: normalized.escalationSignalId,
    signalDigest: hash(stableStringify(escalationUpsert.record)),
    escalationSignal: escalationUpsert.record,
    quarantine: {
      required: normalized.quarantineRequired,
      triggered: normalized.quarantineRequired,
      pathId: quarantine.quarantinePathId,
      targetCandidateIds: quarantine.targetCandidateIds,
      targetRuleIds: quarantine.targetRuleIds,
      resolvedCandidateIds: quarantine.resolvedCandidateIds,
      demotedCandidateIds: quarantine.demotedCandidateIds,
      alreadyQuarantinedCandidateIds: quarantine.alreadyQuarantinedCandidateIds,
      missingCandidateIds: quarantine.missingCandidateIds,
      quarantinedRuleIds: quarantine.quarantinedRuleIds,
      missingRuleIds: quarantine.missingRuleIds,
      changed: quarantine.changed,
      reasonCodes: quarantine.reasonCodes,
      candidateActions: quarantine.candidateActions,
      ruleActions: quarantine.ruleActions,
    },
    policyAuditEventId:
      auditEvent?.auditEventId ?? existingAudit?.auditEventId ?? null,
    observability: {
      severity: normalized.severity,
      immediateQuarantineTriggered: normalized.quarantineRequired,
      quarantineMutationCount:
        quarantine.demotedCandidateIds.length +
        quarantine.quarantinedRuleIds.length,
      evidenceCount: normalized.evidenceEventIds.length,
      provenanceCount: normalized.sourceEventIds.length,
      totalIncidentEscalations: state.incidentEscalations.length,
      replaySafe: true,
      slo: buildSloObservability(
        meta.requestDigest,
        "incident_escalation_signal",
        35
      ),
    },
  };
}

function runCurriculumRecommendation(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "curriculum_recommendation",
    request
  );
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
  const learnerProfile =
    sortByTimestampAndId(state.learnerProfiles, "updatedAt", "profileId").at(
      -1
    ) ?? null;
  const misconceptionsById = new Map<
    string,
    { status: string; confidence: number; harmfulSignalCount: number }
  >(
    state.misconceptions.map((record: any) => [
      record.misconceptionId,
      {
        status: normalizeBoundedStringLenient(record.status, 32) ?? "active",
        confidence: clamp01(record.confidence, 0.5),
        harmfulSignalCount: toNonNegativeInteger(record.harmfulSignalCount, 0),
      },
    ])
  );
  const conflictHistory = Array.isArray(state.curriculumConflictHistory)
    ? sortByTimestampAndId(
        state.curriculumConflictHistory,
        "timestamp",
        "noteId"
      )
    : [];
  const learnerInterestCount = Math.max(
    (learnerProfile?.interestTags ?? []).length,
    1
  );

  const planCandidates = state.curriculumPlanItems.filter((item: any) => {
    if (
      !Array.isArray(item?.evidenceEventIds) ||
      item.evidenceEventIds.length === 0
    ) {
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

  const scoredRecommendations = planCandidates.map((item: any) => {
    const dueLinkedEntries = state.reviewScheduleEntries.filter(
      (entry: any) =>
        entry.targetId === item.objectiveId ||
        entry.targetId === item.planItemId
    );
    const dueScore = dueLinkedEntries.reduce(
      (score: any, entry: any) =>
        score +
        (entry.status === "due" ? 12 : entry.status === "scheduled" ? 4 : 0),
      0
    );
    const misconceptionLinks = (item.sourceMisconceptionIds ?? [])
      .map((misconceptionId: any) => {
        const linked = misconceptionsById.get(misconceptionId);
        if (!linked) {
          return null;
        }
        if (linked.status === "suppressed") {
          return null;
        }
        return linked;
      })
      .filter(Boolean);
    const interestOverlap = intersectionCount(
      item.interestTags,
      learnerProfile?.interestTags ?? []
    );
    const interestAffinity = Number(
      (interestOverlap / learnerInterestCount).toFixed(6)
    );
    const masteryGapRaw =
      misconceptionLinks.length === 0
        ? 0.4
        : misconceptionLinks.reduce((score: any, linked: any) => {
            const statusMultiplier = linked.status === "resolved" ? 0.45 : 1;
            const harmfulBoost =
              1 + Math.min(linked.harmfulSignalCount, 5) * 0.12;
            return (
              score +
              statusMultiplier * (0.35 + linked.confidence) * harmfulBoost
            );
          }, 0) / misconceptionLinks.length;
    const masteryGapScore = Number(
      Math.min(Math.max(masteryGapRaw, 0), 1).toFixed(6)
    );
    const duePressure = Number(
      Math.min(Math.max(dueScore / 24, 0), 1).toFixed(6)
    );
    const evidenceDepth = Number(
      Math.min((item.evidenceEventIds ?? []).length / 10, 1).toFixed(6)
    );
    const rankBias = Number(
      Math.max(
        0,
        1 -
          (toPositiveInteger(item.recommendationRank, 1) - 1) /
            MAX_RECOMMENDATIONS
      ).toFixed(6)
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
      normalized.decayWarningDays
    );
    const statusPenalty =
      item.status === "blocked" ? -40 : item.status === "completed" ? -80 : 0;
    const score = Number(
      (
        weightedScore * 100 +
        rankBias * 5 +
        statusPenalty -
        freshness.decayPenalty
      ).toFixed(6)
    );

    const provenancePointers = normalizeEvidencePointers([
      ...(item.evidenceEventIds ?? []).map((pointerId: any) => ({
        pointerId,
        kind: "event",
        source: "curriculum_plan_item",
      })),
      ...(item.provenanceSignalIds ?? []).map((pointerId: any) => ({
        pointerId,
        kind: "signal",
        source: "curriculum_plan_item",
      })),
      ...(item.sourceMisconceptionIds ?? []).map((pointerId: any) => ({
        pointerId,
        kind: "artifact",
        source: "misconception",
      })),
    ]);
    const conflictChronology = conflictHistory
      .filter(
        (entry: any) =>
          entry.planItemId === item.planItemId &&
          entry.profileId === item.profileId
      )
      .slice(-normalized.maxConflictNotes)
      .map((entry: any) => ({
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
    const tokenEstimate = estimateRecommendationTokenCost(
      item,
      provenancePointers
    );
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
        })
      )
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
        conflictNoteIds: conflictChronology.map((entry: any) => entry.noteId),
        rationale,
      })
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

  const orderedRecommendations = [...scoredRecommendations].sort(
    (left: any, right: any) => {
      const scoreDiff =
        stableScore(right.score, 0) - stableScore(left.score, 0);
      if (scoreDiff !== 0) {
        return scoreDiff > 0 ? 1 : -1;
      }
      return left.recommendationId.localeCompare(right.recommendationId);
    }
  );
  const recommendations = [];
  let tokensConsumed = 0;
  let skippedByTokenBudget = 0;
  for (const recommendation of orderedRecommendations) {
    if (recommendations.length >= normalized.maxRecommendations) {
      break;
    }
    if (
      tokensConsumed + recommendation.tokenEstimate >
      normalized.tokenBudget
    ) {
      skippedByTokenBudget += 1;
      continue;
    }
    recommendations.push(recommendation);
    tokensConsumed += recommendation.tokenEstimate;
  }
  const conflictChronology = sortByTimestampAndId(
    recommendations
      .flatMap((recommendation: any) => recommendation.conflictChronology)
      .filter(
        (entry: any, index: any, entries: any) =>
          entries.findIndex(
            (candidate: any) => candidate.noteId === entry.noteId
          ) === index
      ),
    "timestamp",
    "noteId"
  );
  const recommendationSetId = makeId(
    "recs",
    hash(
      stableStringify({
        storeId,
        profile,
        referenceAt: normalized.referenceAt,
        maxRecommendations: normalized.maxRecommendations,
        recommendationDigests: recommendations.map(
          (recommendation: any) => recommendation.digest
        ),
      })
    )
  );
  const recommendationSnapshot = {
    recommendationSetId,
    generatedAt: normalized.referenceAt,
    requestDigest: meta.requestDigest,
    recommendationIds: recommendations.map(
      (recommendation: any) => recommendation.recommendationId
    ),
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
    "generatedAt"
  );
  state.curriculumRecommendationSnapshots = snapshotUpsert.nextRecords;

  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "curriculum_recommendation",
    storeId,
    profile,
    entityId: recommendationSetId,
    outcome: recommendations.length > 0 ? "allow" : "review",
    reasonCodes:
      recommendations.length > 0
        ? ["evidence_backed_recommendations"]
        : ["no_evidence_backed_candidates"],
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
      evidenceBackedCount: recommendations.filter(
        (recommendation: any) => recommendation.provenancePointers.length > 0
      ).length,
      boundedBy: normalized.maxRecommendations,
      boundedByTokenBudget: skippedByTokenBudget > 0,
      skippedByTokenBudget,
      tokenBudget: normalized.tokenBudget,
      tokensConsumed,
      freshnessWarningDays: normalized.freshnessWarningDays,
      decayWarningDays: normalized.decayWarningDays,
      warningCount: recommendations.reduce(
        (count: any, recommendation: any) =>
          count + recommendation.freshness.warningCodes.length,
        0
      ),
      conflictNoteCount: conflictChronology.length,
      totalSnapshots: state.curriculumRecommendationSnapshots.length,
      slo: buildSloObservability(
        meta.requestDigest,
        "curriculum_recommendation",
        60
      ),
    },
  };
}

function rebalanceReviewSet(
  state: any,
  storeId: any,
  profile: any,
  { activeLimit, timestamp }: any
) {
  const previousEntriesDigest = hash(
    stableStringify(state.reviewScheduleEntries)
  );
  const previousTiersDigest = hash(
    stableStringify(getOrCreateReviewArchivalTiers(state))
  );
  const tiers = getOrCreateReviewArchivalTiers(state);
  const orderedEntries = [...state.reviewScheduleEntries].sort(
    (left: any, right: any) => {
      const dueDiff = String(left?.dueAt ?? "").localeCompare(
        String(right?.dueAt ?? "")
      );
      if (dueDiff !== 0) {
        return dueDiff;
      }
      const statusDiff = String(left?.status ?? "").localeCompare(
        String(right?.status ?? "")
      );
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return String(left?.scheduleEntryId ?? "").localeCompare(
        String(right?.scheduleEntryId ?? "")
      );
    }
  );

  const activeCandidates = orderedEntries.filter(
    (entry: any) => entry.status === "due" || entry.status === "scheduled"
  );
  const activeReviewIds = activeCandidates
    .slice(0, activeLimit)
    .map((entry: any) => entry.scheduleEntryId);
  const activeIdSet = new Set(activeReviewIds);
  const overflow = orderedEntries.filter(
    (entry: any) => !activeIdSet.has(entry.scheduleEntryId)
  );
  const tieredIds: Record<"warm" | "cold" | "frozen", string[]> = {
    warm: [],
    cold: [],
    frozen: [],
  };
  const archivedRecords = [];
  const now = Date.parse(timestamp);

  for (const entry of overflow) {
    const dueMs = Date.parse(entry?.dueAt ?? DEFAULT_VERSION_TIMESTAMP);
    const ageDays =
      Number.isFinite(now) && Number.isFinite(dueMs)
        ? Math.floor((now - dueMs) / (24 * 60 * 60 * 1000))
        : 0;
    let tier: keyof typeof tieredIds = "warm";
    if (entry.status === "completed" || ageDays >= 90) {
      tier = "cold";
    }
    if (ageDays >= 365) {
      tier = "frozen";
    }
    tieredIds[tier].push(entry.scheduleEntryId);
    const archiveRecordId = makeId(
      "arc",
      hash(stableStringify({ scheduleEntryId: entry.scheduleEntryId, tier }))
    );
    archivedRecords.push({
      archiveRecordId,
      scheduleEntryId: entry.scheduleEntryId,
      targetId: entry.targetId,
      tier,
      archivedAt: timestamp,
      dueAt: normalizeIsoTimestampOrFallback(
        entry.dueAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
      sourceEventIds: normalizeBoundedStringArray(
        entry.sourceEventIds,
        "reviewArchivalTiers.sourceEventIds"
      ),
      evidenceEventIds: normalizeBoundedStringArray(
        entry.evidenceEventIds,
        "reviewArchivalTiers.evidenceEventIds"
      ),
      metadata: normalizeMetadata({
        status: entry.status,
        repetition: entry.repetition,
      }),
    });
  }

  state.reviewScheduleEntries = state.reviewScheduleEntries.map(
    (entry: any) => {
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
          ...entry.metadata,
          archivalTier,
          activeReview: activeIdSet.has(entry.scheduleEntryId),
          rebalancedAt: timestamp,
        }),
      };
    }
  );

  tiers.activeLimit = activeLimit;
  tiers.activeReviewIds = activeReviewIds;
  tiers.tiers = {
    warm: [...tieredIds.warm].sort((left: any, right: any) =>
      left.localeCompare(right)
    ),
    cold: [...tieredIds.cold].sort((left: any, right: any) =>
      left.localeCompare(right)
    ),
    frozen: [...tieredIds.frozen].sort((left: any, right: any) =>
      left.localeCompare(right)
    ),
  };
  tiers.archivedRecords = sortByTimestampAndId(
    archivedRecords,
    "archivedAt",
    "archiveRecordId"
  );
  tiers.updatedAt = timestamp;
  state.reviewArchivalTiers = tiers;

  const changed =
    previousEntriesDigest !==
      hash(stableStringify(state.reviewScheduleEntries)) ||
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

function buildTemporalCandidateTickSummary() {
  return {
    processedCount: 0,
    eligibleForDecayCount: 0,
    expiredCount: 0,
    demotedCount: 0,
    decayAppliedCount: 0,
    decayCursorAdvancedCount: 0,
    unchangedCount: 0,
    floorReachedCount: 0,
    totalConfidenceDelta: 0,
    decayedCandidateIds: [] as string[],
    demotedCandidateIds: [] as string[],
    expiredCandidateIds: [] as string[],
    reasonCodes: [] as string[],
    decayRatePerDay: SHADOW_CANDIDATE_CONFIDENCE_DECAY_PER_DAY,
    confidenceFloor: SHADOW_CANDIDATE_CONFIDENCE_FLOOR,
    deterministic: true,
    replaySafe: true,
  };
}

function runTemporalCandidateMaintenanceTick(state: any, timestamp: any) {
  const summary = buildTemporalCandidateTickSummary();
  const candidates = Array.isArray(state.shadowCandidates)
    ? state.shadowCandidates
    : [];
  const orderedCandidateIds = sortByTimestampAndId(
    candidates,
    "updatedAt",
    "candidateId"
  )
    .map((candidate: any) =>
      normalizeBoundedStringLenient(candidate?.candidateId, 64)
    )
    .filter(
      (candidateId: string | null): candidateId is string =>
        typeof candidateId === "string" && candidateId.length > 0
    );
  const visited = new Set();

  for (const candidateId of orderedCandidateIds) {
    if (visited.has(candidateId)) {
      continue;
    }
    visited.add(candidateId);
    summary.processedCount += 1;

    const resolved = resolveMemoryCandidate(state, candidateId);
    const currentCandidate = resolved.candidate;
    if (!currentCandidate) {
      summary.unchangedCount += 1;
      continue;
    }

    let mutated = false;
    const candidateStatus =
      normalizeBoundedStringLenient(currentCandidate.status, 32) ?? "shadow";
    const shadowEligible = candidateStatus === "shadow";
    const expiresAt = normalizeIsoTimestampOrFallback(
      currentCandidate.expiresAt,
      DEFAULT_VERSION_TIMESTAMP
    );
    const expired = expiresAt.localeCompare(timestamp) < 0;
    if (expired) {
      summary.expiredCandidateIds.push(candidateId);
    }
    if (shadowEligible && expired && currentCandidate.status !== "demoted") {
      const demotion = applyCandidateDemotion(state, resolved, {
        demotedAt: timestamp,
        reasonCodes: [DEMOTION_REASON_CANDIDATE_EXPIRED],
      });
      if (demotion.action === "demoted") {
        summary.demotedCandidateIds.push(candidateId);
        mutated = true;
      }
    }

    const candidateAfterDemotion = resolveMemoryCandidate(
      state,
      candidateId
    ).candidate;
    if (!candidateAfterDemotion) {
      if (!mutated) {
        summary.unchangedCount += 1;
      }
      continue;
    }
    if (shadowEligible && candidateAfterDemotion.status !== "demoted") {
      summary.eligibleForDecayCount += 1;
      const lastTemporalDecayAt = normalizeIsoTimestampOrFallback(
        candidateAfterDemotion.lastTemporalDecayAt ??
          candidateAfterDemotion.updatedAt ??
          candidateAfterDemotion.createdAt,
        DEFAULT_VERSION_TIMESTAMP
      );
      const elapsedDays = isoAgeDays(timestamp, lastTemporalDecayAt);
      if (elapsedDays > 0) {
        const previousConfidence = clamp01(
          candidateAfterDemotion.confidence,
          0.5
        );
        const decayMultiplier =
          (1 - SHADOW_CANDIDATE_CONFIDENCE_DECAY_PER_DAY) ** elapsedDays;
        const nextConfidence = roundNumber(
          Math.max(
            SHADOW_CANDIDATE_CONFIDENCE_FLOOR,
            previousConfidence * decayMultiplier
          ),
          6
        );
        const nextCandidate = {
          ...candidateAfterDemotion,
          confidence: nextConfidence,
          lastTemporalDecayAt: timestamp,
          temporalDecayTickCount:
            toNonNegativeInteger(
              candidateAfterDemotion.temporalDecayTickCount,
              0
            ) + 1,
          temporalDecayDaysAccumulated:
            toNonNegativeInteger(
              candidateAfterDemotion.temporalDecayDaysAccumulated,
              0
            ) + elapsedDays,
        };
        if (
          stableStringify(candidateAfterDemotion) !==
          stableStringify(nextCandidate)
        ) {
          const resolvedForUpdate = resolveMemoryCandidate(state, candidateId);
          if (resolvedForUpdate.candidate) {
            state.shadowCandidates[resolvedForUpdate.candidateIndex] =
              nextCandidate;
            state.shadowCandidates = sortByTimestampAndId(
              state.shadowCandidates,
              "updatedAt",
              "candidateId"
            );
            summary.decayCursorAdvancedCount += 1;
            mutated = true;
            if (nextConfidence !== previousConfidence) {
              summary.decayedCandidateIds.push(candidateId);
              summary.totalConfidenceDelta = roundNumber(
                summary.totalConfidenceDelta +
                  roundNumber(nextConfidence - previousConfidence, 6),
                6
              );
              if (nextConfidence <= SHADOW_CANDIDATE_CONFIDENCE_FLOOR) {
                summary.floorReachedCount += 1;
              }
            }
          }
        }
      }
    }

    if (!mutated) {
      summary.unchangedCount += 1;
    }
  }

  summary.decayedCandidateIds = asSortedUniqueStrings(
    summary.decayedCandidateIds
  );
  summary.demotedCandidateIds = asSortedUniqueStrings(
    summary.demotedCandidateIds
  );
  summary.expiredCandidateIds = asSortedUniqueStrings(
    summary.expiredCandidateIds
  );
  summary.decayAppliedCount = summary.decayedCandidateIds.length;
  summary.demotedCount = summary.demotedCandidateIds.length;
  summary.expiredCount = summary.expiredCandidateIds.length;
  summary.reasonCodes =
    summary.demotedCount > 0 ? [DEMOTION_REASON_CANDIDATE_EXPIRED] : [];

  return {
    changed: summary.demotedCount > 0 || summary.decayCursorAdvancedCount > 0,
    summary: stableSortObject(summary),
  };
}

function runReviewScheduleClock(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "review_schedule_clock",
    request
  );
  const state = getProfileState(storeId, profile);
  const normalized = normalizeReviewScheduleClockRequest(request);
  const meta = buildMeta("review_schedule_clock", storeId, profile, input);
  const clocks = getOrCreateSchedulerClocks(state);
  const previousClocksDigest = hash(stableStringify(clocks));
  const transitions: Array<Record<string, unknown>> = [];

  clocks.sleepThreshold = normalized.sleepThreshold;
  clocks.fatigueThreshold = normalized.fatigueThreshold;
  clocks.noveltyWriteThreshold = normalized.noveltyWriteThreshold;
  if (normalized.mode === "interaction" || normalized.mode === "auto") {
    clocks.interactionTick += normalized.interactionIncrement;
    clocks.fatigueLoad +=
      normalized.interactionIncrement +
      normalized.noveltyLoad +
      normalized.fatigueDelta;
    clocks.noveltyWriteLoad +=
      normalized.noveltyWriteLoad + normalized.noveltyLoad;
    clocks.lastInteractionAt = normalized.timestamp;
  }
  if (normalized.mode === "sleep") {
    clocks.noveltyWriteLoad += normalized.noveltyWriteLoad;
  }

  let consolidationTriggered = false;
  let consolidationCause = "none";
  const fatigueExceeded = clocks.fatigueLoad >= clocks.fatigueThreshold;
  const noveltyExceeded =
    clocks.noveltyWriteLoad >= clocks.noveltyWriteThreshold;
  const shouldSleep =
    normalized.forceSleep ||
    normalized.mode === "sleep" ||
    fatigueExceeded ||
    noveltyExceeded;
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

  state.reviewScheduleEntries = state.reviewScheduleEntries.map(
    (entry: any) => {
      let next = entry;
      if (
        entry.status === "scheduled" &&
        String(entry.dueAt ?? "") <= normalized.timestamp
      ) {
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
          normalizeIsoTimestampOrFallback(
            normalized.timestamp,
            DEFAULT_VERSION_TIMESTAMP
          ),
          toPositiveInteger(next.intervalDays, 1)
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
    }
  );

  const temporalCandidateMaintenance = runTemporalCandidateMaintenanceTick(
    state,
    normalized.timestamp
  );

  const tiers = getOrCreateReviewArchivalTiers(state);
  const rebalanced = rebalanceReviewSet(state, storeId, profile, {
    activeLimit: tiers.activeLimit,
    timestamp: normalized.timestamp,
  });
  const clocksChanged = previousClocksDigest !== hash(stableStringify(clocks));
  const action =
    clocksChanged ||
    transitions.length > 0 ||
    rebalanced.changed ||
    temporalCandidateMaintenance.changed
      ? "updated"
      : "noop";
  const clockReasonCodes = consolidationTriggered
    ? [
        consolidationCause === "none"
          ? "sleep_clock_triggered"
          : consolidationCause,
      ]
    : ["interaction_clock_tick"];
  const candidateReasonCodes = [];
  if (temporalCandidateMaintenance.summary.decayAppliedCount > 0) {
    candidateReasonCodes.push("candidate_temporal_decay");
  }
  for (const reasonCode of temporalCandidateMaintenance.summary.reasonCodes) {
    candidateReasonCodes.push(reasonCode);
  }
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "review_schedule_clock",
    storeId,
    profile,
    entityId: makeId(
      "clk",
      hash(stableStringify({ requestDigest: meta.requestDigest }))
    ),
    outcome: action === "noop" ? "noop" : "recorded",
    reasonCodes: asSortedUniqueStrings([
      ...clockReasonCodes,
      ...candidateReasonCodes,
    ]),
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
      candidateMaintenance: {
        processedCount: temporalCandidateMaintenance.summary.processedCount,
        eligibleForDecayCount:
          temporalCandidateMaintenance.summary.eligibleForDecayCount,
        expiredCount: temporalCandidateMaintenance.summary.expiredCount,
        demotedCount: temporalCandidateMaintenance.summary.demotedCount,
        decayAppliedCount:
          temporalCandidateMaintenance.summary.decayAppliedCount,
        decayCursorAdvancedCount:
          temporalCandidateMaintenance.summary.decayCursorAdvancedCount,
        reasonCodes: temporalCandidateMaintenance.summary.reasonCodes,
      },
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
    candidateMaintenance: temporalCandidateMaintenance.summary,
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
      candidateMaintenance: temporalCandidateMaintenance.summary,
      slo: buildSloObservability(
        meta.requestDigest,
        "review_schedule_clock",
        45
      ),
    },
  };
}

function runReviewSetRebalance(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "review_set_rebalance",
    request
  );
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
    entityId: makeId(
      "rset",
      hash(stableStringify({ requestDigest: meta.requestDigest }))
    ),
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
      slo: buildSloObservability(
        meta.requestDigest,
        "review_set_rebalance",
        40
      ),
    },
  };
}

function runCurateGuarded(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "curate_guarded",
    request
  );
  const state = getProfileState(storeId, profile);
  const meta = buildMeta("curate_guarded", storeId, profile, input);
  const guardTimestamp = normalizeIsoTimestamp(
    request.timestamp ?? request.updatedAt ?? request.createdAt,
    "curate_guarded.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const rawCandidates = Array.isArray(request.candidates)
    ? request.candidates
    : [];
  const rawValidations = Array.isArray(request.validations)
    ? request.validations
    : [];
  const validationByCandidateId = new Map();
  for (const validation of rawValidations) {
    if (!isPlainObject(validation)) {
      continue;
    }
    const candidateId = normalizeBoundedString(
      validation.candidateId,
      "validations.candidateId",
      64
    );
    if (!candidateId) {
      continue;
    }
    validationByCandidateId.set(candidateId, {
      valid: Boolean(validation.valid),
      evidenceEventId: normalizeBoundedString(
        validation.evidenceEventId,
        "validations.evidenceEventId"
      ),
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
        hash(
          stableStringify({
            candidateId: candidate.candidateId,
            injectionReasons,
          })
        )
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
    const hasEventEvidence = state.events.some(
      (event: any) => event.eventId === candidate.sourceEventId
    );
    const hasValidationEvidence = Boolean(
      validation?.valid && validation?.evidenceEventId
    );
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
      appliedRuleIds: curateResult.applied.map((entry: any) => entry.ruleId),
      quarantinedIds: quarantined.map((entry: any) => entry.quarantineId),
      rejected,
    })
  );
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "curate_guarded",
    storeId,
    profile,
    entityId: makeId(
      "guard",
      hash(stableStringify({ requestDigest: meta.requestDigest }))
    ),
    outcome: quarantined.length > 0 ? "deny" : "allow",
    reasonCodes:
      quarantined.length > 0
        ? asSortedUniqueStrings(
            quarantined.flatMap((entry: any) => entry.reasonCodes)
          )
        : rejected.some(
              (entry: any) => entry.reason === "missing_validation_evidence"
            )
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

function runRecallAuthorization(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "recall_authorization",
    request
  );
  const state = getProfileState(storeId, profile);
  const normalized = normalizeRecallAuthorizationRequest(request, storeId);
  const meta = buildMeta("recall_authorization", storeId, profile, input);
  const policy = getOrCreateRecallAllowlistPolicy(state, storeId, profile);
  const previousDigest = hash(stableStringify(policy));

  let nextAllowedStoreIds = [...policy.allowedStoreIds];
  if (normalized.mode === "grant") {
    nextAllowedStoreIds = mergeStringLists(
      nextAllowedStoreIds,
      normalized.allowStoreIds
    );
  } else if (normalized.mode === "replace") {
    nextAllowedStoreIds = mergeStringLists([storeId], normalized.allowStoreIds);
  } else if (normalized.mode === "revoke") {
    const removed = new Set(normalized.allowStoreIds);
    nextAllowedStoreIds = nextAllowedStoreIds.filter((allowedStoreId: any) => {
      if (allowedStoreId === storeId) {
        return true;
      }
      return !removed.has(allowedStoreId);
    });
  }

  const changed =
    stableStringify(nextAllowedStoreIds) !==
    stableStringify(policy.allowedStoreIds);
  if (changed) {
    policy.allowedStoreIds = nextAllowedStoreIds;
    policy.updatedAt = normalized.timestamp;
  }
  const crossSpace = normalized.requesterStoreId !== storeId;
  const authorized =
    !crossSpace || policy.allowedStoreIds.includes(normalized.requesterStoreId);
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
      })
    )
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
      `${CROSS_SPACE_ALLOWLIST_DENY_ERROR} requesterStoreId=${normalized.requesterStoreId} targetStoreId=${storeId}`
    ) as Error & { code?: string };
    error.code = "PERSONALIZATION_POLICY_DENY";
    throw error;
  }

  return {
    ...meta,
    action:
      normalized.mode === "check" ? "checked" : changed ? "updated" : "noop",
    decisionId,
    decisionDigest: hash(
      stableStringify({
        decisionId,
        authorized,
        requesterStoreId: normalized.requesterStoreId,
        targetStoreId: storeId,
        allowStoreIds: policy.allowedStoreIds,
      })
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
      slo: buildSloObservability(
        meta.requestDigest,
        "recall_authorization",
        30
      ),
    },
  };
}

function runTutorDegraded(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "tutor_degraded",
    request
  );
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
  const degradedMode =
    normalized.forceDegraded ||
    !normalized.llmAvailable ||
    !normalized.indexAvailable;
  const warnings = [];
  if (!normalized.llmAvailable) {
    warnings.push("LLM_UNAVAILABLE");
  }
  if (!normalized.indexAvailable) {
    warnings.push("INDEX_UNAVAILABLE");
  }

  const orderedReviewEntries = [...state.reviewScheduleEntries].sort(
    (left: any, right: any) => {
      const dueDiff = String(left?.dueAt ?? "").localeCompare(
        String(right?.dueAt ?? "")
      );
      if (dueDiff !== 0) {
        return dueDiff;
      }
      return String(left?.scheduleEntryId ?? "").localeCompare(
        String(right?.scheduleEntryId ?? "")
      );
    }
  );
  const orderedMisconceptions = [...state.misconceptions].sort(
    (left: any, right: any) => {
      const leftScore = toNonNegativeInteger(left?.harmfulSignalCount, 0);
      const rightScore = toNonNegativeInteger(right?.harmfulSignalCount, 0);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return String(left?.misconceptionId ?? "").localeCompare(
        String(right?.misconceptionId ?? "")
      );
    }
  );
  const orderedPlans = [...state.curriculumPlanItems].sort(
    (left: any, right: any) => {
      const rankDiff =
        toPositiveInteger(left?.recommendationRank, 1) -
        toPositiveInteger(right?.recommendationRank, 1);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return String(left?.planItemId ?? "").localeCompare(
        String(right?.planItemId ?? "")
      );
    }
  );

  const suggestions = [];
  for (const entry of orderedReviewEntries) {
    if (suggestions.length >= normalized.maxSuggestions) {
      break;
    }
    if (entry.status !== "due" && entry.status !== "scheduled") {
      continue;
    }
    if (
      normalized.query &&
      !String(entry.targetId ?? "")
        .toLowerCase()
        .includes(normalized.query)
    ) {
      continue;
    }
    const suggestionId = makeId(
      "tut",
      hash(
        stableStringify({
          type: "review",
          scheduleEntryId: entry.scheduleEntryId,
          query: normalized.query,
        })
      )
    );
    suggestions.push({
      suggestionId,
      type: "review",
      targetId: entry.targetId,
      priority: entry.status === "due" ? "high" : "medium",
      dueAt: entry.dueAt,
      evidencePointers: normalizeEvidencePointers([
        ...(entry.sourceEventIds ?? []).map((pointerId: any) => ({
          pointerId,
          kind: "event",
          source: "review_schedule",
        })),
        ...(entry.evidenceEventIds ?? []).map((pointerId: any) => ({
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
    if (
      normalized.query &&
      !String(misconception.misconceptionKey ?? "")
        .toLowerCase()
        .includes(normalized.query)
    ) {
      continue;
    }
    const suggestionId = makeId(
      "tut",
      hash(
        stableStringify({
          type: "misconception",
          misconceptionId: misconception.misconceptionId,
          query: normalized.query,
        })
      )
    );
    suggestions.push({
      suggestionId,
      type: "remediation",
      targetId: misconception.misconceptionId,
      priority: misconception.status === "active" ? "high" : "medium",
      dueAt: normalized.timestamp,
      evidencePointers: normalizeEvidencePointers(
        (misconception.evidenceEventIds ?? []).map((pointerId: any) => ({
          pointerId,
          kind: "event",
          source: "misconception",
        }))
      ),
      rationale: "harmful_signal_remediation",
    });
  }
  for (const planItem of orderedPlans) {
    if (suggestions.length >= normalized.maxSuggestions) {
      break;
    }
    if (
      !Array.isArray(planItem.evidenceEventIds) ||
      planItem.evidenceEventIds.length === 0
    ) {
      continue;
    }
    if (
      normalized.query &&
      !String(planItem.objectiveId ?? "")
        .toLowerCase()
        .includes(normalized.query)
    ) {
      continue;
    }
    const suggestionId = makeId(
      "tut",
      hash(
        stableStringify({
          type: "curriculum",
          planItemId: planItem.planItemId,
          query: normalized.query,
        })
      )
    );
    suggestions.push({
      suggestionId,
      type: "curriculum",
      targetId: planItem.objectiveId,
      priority: "medium",
      dueAt: planItem.dueAt,
      evidencePointers: normalizeEvidencePointers([
        ...(planItem.evidenceEventIds ?? []).map((pointerId: any) => ({
          pointerId,
          kind: "event",
          source: "curriculum_plan",
        })),
        ...(planItem.provenanceSignalIds ?? []).map((pointerId: any) => ({
          pointerId,
          kind: "signal",
          source: "curriculum_plan",
        })),
      ]),
      rationale: "evidence_backed_curriculum_item",
    });
  }

  const deterministicWarnings = [...warnings].sort((left: any, right: any) =>
    left.localeCompare(right)
  );
  const responseText =
    suggestions.length === 0
      ? "No evidence-backed tutoring suggestions are currently available in degraded mode."
      : suggestions
          .map(
            (suggestion: any, index: any) =>
              `${index + 1}. ${suggestion.type}:${suggestion.targetId} (${suggestion.priority})`
          )
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
        suggestionIds: suggestions.map(
          (suggestion: any) => suggestion.suggestionId
        ),
      })
    )
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
    suggestionIds: suggestions.map(
      (suggestion: any) => suggestion.suggestionId
    ),
    responseDigest: hash(stableStringify({ responseText, suggestions })),
  };
  const sessionUpsert = upsertDeterministicRecord(
    state.degradedTutorSessions,
    "sessionId",
    sessionRecord,
    "timestamp"
  );
  state.degradedTutorSessions = sessionUpsert.nextRecords;
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "tutor_degraded",
    storeId,
    profile,
    entityId: sessionId,
    outcome: degradedMode ? "review" : "allow",
    reasonCodes: degradedMode
      ? deterministicWarnings
      : ["normal_mode_available"],
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

function runPolicyAuditExport(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "policy_audit_export",
    request
  );
  const state = getProfileState(storeId, profile);
  const generatedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.generatedAt ?? request.createdAt,
    "policy_audit_export.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const exportFormat = normalizeDeterministicEnum(
    request.format ?? request.exportFormat,
    "format",
    "policy_audit_export",
    POLICY_AUDIT_EXPORT_FORMATS,
    "json"
  );
  const limit = Math.min(
    Math.max(toPositiveInteger(request.limit, MAX_LIST_ITEMS), 1),
    MAX_LIST_ITEMS
  );
  const meta = buildMeta("policy_audit_export", storeId, profile, input);
  const signingConfig = resolvePolicyAuditExportSigningConfig();
  const policy = getOrCreateRecallAllowlistPolicy(state, storeId, profile);
  const policyDecisions = sortByTimestampAndId(
    state.policyDecisions,
    "updatedAt",
    "decisionId"
  )
    .slice(-limit)
    .map((decision: any) => ({
      decisionId: decision.decisionId,
      policyKey: decision.policyKey,
      outcome: decision.outcome,
      reasonCodes: decision.reasonCodes,
      provenanceEventIds: decision.provenanceEventIds,
      updatedAt: decision.updatedAt,
      digest: hash(stableStringify(decision)),
    }));
  const auditTrail = sortByTimestampAndId(
    (state.policyAuditTrail ?? []).filter(
      (entry: any) => entry?.operation !== "policy_audit_export"
    ),
    "timestamp",
    "auditEventId"
  ).slice(-limit);
  const incidentChecklist = [
    {
      checkId: "policy_decision_traceability",
      status: policyDecisions.length > 0 ? "pass" : "warn",
      details:
        "Policy decisions include deterministic IDs, reason codes, and provenance pointers.",
    },
    {
      checkId: "cross_space_allowlist_enforcement",
      status: policy.allowedStoreIds.includes(storeId) ? "pass" : "warn",
      details: "Target store remains present in allowlist policy baseline.",
    },
    {
      checkId: "prompt_injection_quarantine_visibility",
      status: auditTrail.some((entry: any) =>
        (entry.reasonCodes ?? []).some((reasonCode: any) =>
          reasonCode.startsWith("prompt_override_")
        )
      )
        ? "pass"
        : "warn",
      details:
        "Audit trail captures prompt-injection quarantine evidence when present.",
    },
    {
      checkId: "rollback_readiness",
      status: auditTrail.length > 0 ? "pass" : "warn",
      details:
        "Audit trail exists for incident rollback and postmortem analysis.",
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
        format: exportFormat,
        policyDecisionIds: policyDecisions.map(
          (decision: any) => decision.decisionId
        ),
        auditEventIds: auditTrail.map((entry: any) => entry.auditEventId),
      })
    )
  );
  const payloadDigest = hash(stableStringify(payload));
  const records = buildPolicyAuditExportRecords({
    exportId,
    payload,
    payloadDigest,
  });
  const serializedExport = serializePolicyAuditExport(
    payload,
    records,
    exportFormat
  );
  const recordChecksum = hash(
    stableStringify(records.map((record: any) => record.recordDigest))
  );
  const sectionChecksums = {
    policyDecisions: hash(stableStringify(payload.policyDecisions)),
    auditTrail: hash(stableStringify(payload.auditTrail)),
    incidentChecklist: hash(stableStringify(payload.incidentChecklist)),
  };
  const integrity = {
    algorithm: "sha256",
    payload: {
      checksum: payloadDigest,
    },
    content: {
      checksum: hash(serializedExport.content),
      lineCount: serializedExport.lineCount,
      byteLength: Buffer.byteLength(serializedExport.content, "utf8"),
      contentType: serializedExport.contentType,
    },
    records: {
      checksum: recordChecksum,
      count: records.length,
    },
    sections: sectionChecksums,
  };
  const signatureMaterial = {
    operation: "policy_audit_export",
    version: POLICY_AUDIT_EXPORT_SIGNATURE_VERSION,
    keyId: signingConfig.keyId,
    algorithm: POLICY_AUDIT_EXPORT_SIGNATURE_ALGORITHM,
    signedAt: generatedAt,
    exportId,
    format: exportFormat,
    normalizedInput: {
      generatedAt,
      format: exportFormat,
      profile,
      storeId,
    },
    payloadChecksum: integrity.payload.checksum,
    contentChecksum: integrity.content.checksum,
    recordChecksum: integrity.records.checksum,
    sectionChecksums,
  };
  const signatureMetadataDigest = hash(stableStringify(signatureMaterial));
  const signature = {
    version: POLICY_AUDIT_EXPORT_SIGNATURE_VERSION,
    algorithm: POLICY_AUDIT_EXPORT_SIGNATURE_ALGORITHM,
    keyId: signingConfig.keyId,
    signedAt: generatedAt,
    deterministic: true,
    metadataDigest: signatureMetadataDigest,
    value: hmacSha256(
      stableStringify({
        metadataDigest: signatureMetadataDigest,
        scope: "policy_audit_export",
      }),
      signingConfig.secret
    ),
  };
  const auditEvent = appendPolicyAuditTrail(state, {
    operation: "policy_audit_export",
    storeId,
    profile,
    entityId: exportId,
    outcome: "recorded",
    reasonCodes: ["policy_audit_export"],
    details: {
      contentChecksum: integrity.content.checksum,
      decisionCount: policyDecisions.length,
      auditEventCount: auditTrail.length,
      checklistStatus: incidentChecklist.map(
        (entry: any) => `${entry.checkId}:${entry.status}`
      ),
      exportFormat,
      payloadChecksum: integrity.payload.checksum,
    },
    timestamp: generatedAt,
  });

  return {
    ...meta,
    action: "exported",
    exportId,
    exportFormat,
    exportContentType: serializedExport.contentType,
    exportContent: serializedExport.content,
    payloadDigest,
    payload,
    integrity,
    signature,
    policyAuditEventId: auditEvent.auditEventId,
    observability: {
      decisionCount: policyDecisions.length,
      auditEventCount: auditTrail.length,
      checklistCount: incidentChecklist.length,
      exportFormat,
      exportLineCount: serializedExport.lineCount,
      integrityChecksums: true,
      deterministicSignature: true,
      deterministicExport: true,
      replaySafe: true,
      slo: buildSloObservability(meta.requestDigest, "policy_audit_export", 50),
    },
  };
}

function buildPolicyAuditExportRecords({
  exportId,
  payload,
  payloadDigest,
}: any) {
  const records = [
    {
      recordType: "manifest",
      recordId: exportId,
      storeId: payload.storeId,
      profile: payload.profile,
      timestamp: payload.generatedAt,
      outcome: "recorded",
      policyKey: null,
      checkId: null,
      status: null,
      reasonCodes: [],
      provenanceEventIds: [],
      details: {
        exportVersion: payload.exportVersion,
        policyId: payload.policy.policyId,
        policyUpdatedAt: payload.policy.updatedAt,
        allowStoreIds: payload.policy.allowStoreIds,
        payloadDigest,
        policyDecisionCount: payload.policyDecisions.length,
        auditEventCount: payload.auditTrail.length,
        checklistCount: payload.incidentChecklist.length,
      },
    },
    ...payload.policyDecisions.map((decision: any) => ({
      recordType: "policy_decision",
      recordId: decision.decisionId,
      storeId: payload.storeId,
      profile: payload.profile,
      timestamp: decision.updatedAt,
      outcome: decision.outcome,
      policyKey: decision.policyKey,
      checkId: null,
      status: null,
      reasonCodes: decision.reasonCodes,
      provenanceEventIds: decision.provenanceEventIds,
      details: {
        decisionDigest: decision.digest,
      },
    })),
    ...payload.auditTrail.map((entry: any) => ({
      recordType: "policy_audit_event",
      recordId: entry.auditEventId,
      storeId: payload.storeId,
      profile: payload.profile,
      timestamp: entry.timestamp,
      outcome: entry.outcome,
      policyKey: null,
      checkId: null,
      status: null,
      reasonCodes: entry.reasonCodes,
      provenanceEventIds: [],
      details: {
        operation: entry.operation,
        entityId: entry.entityId,
        details: entry.details,
      },
    })),
    ...payload.incidentChecklist.map((checklistEntry: any) => ({
      recordType: "incident_check",
      recordId: checklistEntry.checkId,
      storeId: payload.storeId,
      profile: payload.profile,
      timestamp: payload.generatedAt,
      outcome: null,
      policyKey: null,
      checkId: checklistEntry.checkId,
      status: checklistEntry.status,
      reasonCodes: [],
      provenanceEventIds: [],
      details: checklistEntry.details,
    })),
  ];
  return records.map((record: any) => {
    const canonicalRecord = stableSortObject(record);
    return {
      ...canonicalRecord,
      recordDigest: hash(stableStringify(canonicalRecord)),
    };
  });
}

function serializePolicyAuditExport(payload: any, records: any, format: any) {
  if (format === "ndjson") {
    return {
      contentType: "application/x-ndjson",
      content: records.map((record: any) => stableStringify(record)).join("\n"),
      lineCount: records.length,
    };
  }
  if (format === "csv") {
    const rows = [POLICY_AUDIT_EXPORT_CSV_COLUMNS.join(",")];
    for (const record of records) {
      rows.push(
        POLICY_AUDIT_EXPORT_CSV_COLUMNS.map((columnName: any) =>
          escapeCsvCellValue(record[columnName] ?? null)
        ).join(",")
      );
    }
    return {
      contentType: "text/csv",
      content: rows.join("\n"),
      lineCount: rows.length,
    };
  }
  return {
    contentType: "application/json",
    content: stableStringify(payload),
    lineCount: 1,
  };
}

function escapeCsvCellValue(value: any) {
  if (value === null || value === undefined) {
    return "";
  }
  const isInputString = typeof value === "string";
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : stableStringify(value);
  const normalizedRaw =
    isInputString && /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(normalizedRaw)) {
    return `"${normalizedRaw.replaceAll('"', '""')}"`;
  }
  return normalizedRaw;
}

function findPolicyAuditTrailByOperationEntity(
  state: any,
  operation: any,
  entityId: any
) {
  const existing = Array.isArray(state.policyAuditTrail)
    ? state.policyAuditTrail
    : [];
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const entry = existing[index];
    if (entry?.operation === operation && entry?.entityId === entityId) {
      return entry;
    }
  }
  return null;
}

function resolveUtilitySignalScore(entity: any) {
  const metadataScore = toFiniteNumber(
    entity?.metadata?.utilitySignal?.score,
    Number.NaN
  );
  if (Number.isFinite(metadataScore)) {
    return clamp01(metadataScore, DEFAULT_UTILITY_SIGNAL_SCORE);
  }
  return clamp01(entity?.utilityScore, DEFAULT_UTILITY_SIGNAL_SCORE);
}

function applyUtilitySignalToCandidatesAndRules(
  state: any,
  {
    targetRuleIds = [],
    targetCandidateIds = [],
    signalId,
    signalType,
    source,
    delta,
    note,
    actor,
    timestamp,
  }: any
) {
  const normalizedRuleIds = asSortedUniqueStrings(targetRuleIds);
  const normalizedCandidateIds = asSortedUniqueStrings(targetCandidateIds);
  const normalizedNote =
    normalizeBoundedString(note, "utilitySignal.note", 512) ?? "";
  const normalizedActor =
    normalizeBoundedString(actor, "utilitySignal.actor", 128) ??
    "human_unspecified";
  const signalDelta = roundNumber(stableScore(delta, 0), 6);
  const updatedCandidateIds = [];
  const updatedRuleIds = [];
  const candidates = Array.isArray(state.shadowCandidates)
    ? state.shadowCandidates
    : [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const matchesRule = normalizedRuleIds.includes(candidate?.ruleId);
    const matchesCandidate = normalizedCandidateIds.includes(
      candidate?.candidateId
    );
    if (!matchesRule && !matchesCandidate) {
      continue;
    }
    const existingMetadata = isPlainObject(candidate?.metadata)
      ? candidate.metadata
      : {};
    const existingSignal = isPlainObject(existingMetadata.utilitySignal)
      ? existingMetadata.utilitySignal
      : {};
    const existingSignalId = normalizeBoundedString(
      existingSignal.signalId,
      "utilitySignal.signalId",
      64
    );
    if (existingSignalId === signalId) {
      continue;
    }
    const previousScore = resolveUtilitySignalScore(candidate);
    const nextScore = roundNumber(
      clamp01(previousScore + signalDelta, previousScore),
      6
    );
    const nextCandidate = {
      ...candidate,
      updatedAt: timestamp,
      metadata: stableSortObject({
        ...existingMetadata,
        utilitySignal: {
          score: nextScore,
          previousScore: roundNumber(previousScore, 6),
          delta: signalDelta,
          signalId,
          signalType,
          source,
          note: normalizedNote,
          actor: normalizedActor,
          timestamp,
        },
      }),
    };
    candidates[index] = nextCandidate;
    updatedCandidateIds.push(nextCandidate.candidateId);
  }
  if (updatedCandidateIds.length > 0) {
    state.shadowCandidates = sortByTimestampAndId(
      candidates,
      "updatedAt",
      "candidateId"
    );
  } else if (!Array.isArray(state.shadowCandidates)) {
    state.shadowCandidates = candidates;
  }

  if (Array.isArray(state.rules)) {
    for (let index = 0; index < state.rules.length; index += 1) {
      const rule = state.rules[index];
      if (!normalizedRuleIds.includes(rule?.ruleId)) {
        continue;
      }
      const existingSignalId = normalizeBoundedString(
        rule?.utilitySignalId,
        "rules.utilitySignalId",
        64
      );
      if (existingSignalId === signalId) {
        continue;
      }
      const previousScore = resolveUtilitySignalScore(rule);
      const nextScore = roundNumber(
        clamp01(previousScore + signalDelta, previousScore),
        6
      );
      const nextRule = {
        ...rule,
        utilityScore: nextScore,
        utilitySignalId: signalId,
        utilitySignalType: signalType,
        utilitySignalSource: source,
        utilitySignalDelta: signalDelta,
        utilitySignalNote: normalizedNote,
        utilitySignalActor: normalizedActor,
        utilitySignalUpdatedAt: timestamp,
      };
      state.rules[index] = nextRule;
      updatedRuleIds.push(nextRule.ruleId);
    }
  }

  return {
    targetRuleIds: normalizedRuleIds,
    targetCandidateIds: normalizedCandidateIds,
    updatedRuleIds: asSortedUniqueStrings(updatedRuleIds),
    updatedCandidateIds: asSortedUniqueStrings(updatedCandidateIds),
  };
}

function runFeedback(request: any) {
  const { storeId, profile, input } = normalizeRequest("feedback", request);
  const state = getProfileState(storeId, profile);
  const targetRuleId =
    normalizeBoundedString(request.targetRuleId, "feedback.targetRuleId", 64) ??
    "";
  const targetCandidateId =
    normalizeBoundedString(
      request.targetCandidateId ?? request.candidateId,
      "feedback.targetCandidateId",
      64
    ) ?? "";
  const signal = request.signal === "harmful" ? "harmful" : "helpful";
  const note = normalizeBoundedString(request.note, "feedback.note", 512) ?? "";
  const actor =
    normalizeBoundedString(
      request.actor ?? request.userId,
      "feedback.actor",
      128
    ) ?? "human_unspecified";
  const recordedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.recordedAt ?? request.createdAt,
    "feedback.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const metadata = normalizeMetadata(request.metadata);
  const seed = hash(
    stableStringify({
      targetRuleId,
      targetCandidateId,
      signal,
      note,
      actor,
      recordedAt,
      metadata,
    })
  );
  const feedbackId =
    normalizeBoundedString(request.feedbackId, "feedback.feedbackId", 64) ??
    makeId("fdbk", seed);
  const nextFeedback = {
    feedbackId,
    targetRuleId,
    targetCandidateId: targetCandidateId || null,
    signal,
    note,
    actor,
    recordedAt,
    metadata,
  };
  const existingIndex = state.feedback.findIndex(
    (entry: any) => entry?.feedbackId === feedbackId
  );
  let action = "created";
  if (existingIndex !== -1) {
    if (
      stableStringify(state.feedback[existingIndex]) ===
      stableStringify(nextFeedback)
    ) {
      action = "noop";
    } else {
      action = "updated";
      state.feedback[existingIndex] = nextFeedback;
    }
  } else {
    state.feedback.push(nextFeedback);
  }
  state.feedback = sortByTimestampAndId(
    state.feedback,
    "recordedAt",
    "feedbackId"
  );
  const meta = buildMeta("feedback", storeId, profile, input);

  const mapping =
    action === "noop"
      ? {
          targetRuleIds: targetRuleId ? [targetRuleId] : [],
          targetCandidateIds: targetCandidateId ? [targetCandidateId] : [],
          updatedRuleIds: [],
          updatedCandidateIds: [],
        }
      : applyUtilitySignalToCandidatesAndRules(state, {
          targetRuleIds: targetRuleId ? [targetRuleId] : [],
          targetCandidateIds: targetCandidateId ? [targetCandidateId] : [],
          signalId: feedbackId,
          signalType: signal,
          source: "feedback",
          delta: FEEDBACK_UTILITY_SIGNAL_DELTA[signal],
          note,
          actor,
          timestamp: recordedAt,
        });
  const mappingUpdatedCount =
    mapping.updatedRuleIds.length + mapping.updatedCandidateIds.length;
  const existingAudit = findPolicyAuditTrailByOperationEntity(
    state,
    "feedback",
    feedbackId
  );
  const auditEvent =
    action === "noop"
      ? null
      : appendPolicyAuditTrail(state, {
          operation: "feedback",
          storeId,
          profile,
          entityId: feedbackId,
          outcome: "recorded",
          reasonCodes: [
            `feedback_${signal}`,
            mappingUpdatedCount > 0
              ? "memory_utility_signal_update"
              : "memory_utility_signal_record_only",
          ],
          details: {
            targetRuleId: targetRuleId || null,
            targetCandidateId: targetCandidateId || null,
            updatedRuleIds: mapping.updatedRuleIds,
            updatedCandidateIds: mapping.updatedCandidateIds,
            note,
            actor,
            signal,
          },
          timestamp: recordedAt,
        });
  let autoDemotion = null;
  if (action !== "noop" && signal === "harmful") {
    const demotionTargetCandidateIds = resolveDemotionTargetCandidateIds(
      state,
      targetRuleId ? [targetRuleId] : [],
      targetCandidateId ? [targetCandidateId] : []
    );
    const demotedCandidateIds = [];
    const removedRuleIds = [];
    for (const demotionCandidateId of demotionTargetCandidateIds) {
      const demotion = applyCandidateDemotion(
        state,
        resolveMemoryCandidate(state, demotionCandidateId),
        {
          demotedAt: recordedAt,
          reasonCodes: [DEMOTION_REASON_EXPLICIT_HARMFUL_FEEDBACK],
        }
      );
      if (demotion.action === "demoted") {
        demotedCandidateIds.push(demotionCandidateId);
      }
      if (demotion.removedRuleId) {
        removedRuleIds.push(demotion.removedRuleId);
      }
    }
    autoDemotion = {
      action: demotedCandidateIds.length > 0 ? "demoted" : "noop",
      trigger: DEMOTION_REASON_EXPLICIT_HARMFUL_FEEDBACK,
      reasonCodes: [DEMOTION_REASON_EXPLICIT_HARMFUL_FEEDBACK],
      candidateIds: demotionTargetCandidateIds,
      demotedCandidateIds: asSortedUniqueStrings(demotedCandidateIds),
      removedRuleIds: asSortedUniqueStrings(removedRuleIds),
    };
  }

  return {
    ...meta,
    action,
    feedbackId,
    targetRuleId,
    targetCandidateId: targetCandidateId || null,
    signal,
    note,
    actor,
    recordedAt,
    totalFeedback: state.feedback.length,
    mapping,
    autoDemotion,
    policyAuditEventId:
      auditEvent?.auditEventId ?? existingAudit?.auditEventId ?? null,
    observability: {
      replaySafe: true,
      mappedUtilitySignals: mappingUpdatedCount,
      autoDemotionApplied: autoDemotion?.action === "demoted",
      slo: buildSloObservability(meta.requestDigest, "feedback", 30),
    },
  };
}

function runOutcome(request: any) {
  const { storeId, profile, input } = normalizeRequest("outcome", request);
  const state = getProfileState(storeId, profile);
  const outcome = request.outcome === "failure" ? "failure" : "success";
  const task =
    normalizeBoundedString(request.task, "outcome.task", 128) ??
    "unspecified-task";
  const usedRuleIds = normalizeBoundedStringArray(
    request.usedRuleIds,
    "outcome.usedRuleIds"
  );
  const actor =
    normalizeBoundedString(
      request.actor ?? request.userId,
      "outcome.actor",
      128
    ) ?? "human_unspecified";
  const recordedAt = normalizeIsoTimestamp(
    request.timestamp ?? request.recordedAt ?? request.createdAt,
    "outcome.timestamp",
    DEFAULT_VERSION_TIMESTAMP
  );
  const metadata = normalizeMetadata(request.metadata);
  const outcomeId =
    normalizeBoundedString(request.outcomeId, "outcome.outcomeId", 64) ??
    makeId(
      "out",
      hash(
        stableStringify({
          task,
          outcome,
          usedRuleIds,
          actor,
          recordedAt,
          metadata,
        })
      )
    );
  const nextOutcome = {
    outcomeId,
    task,
    outcome,
    usedRuleIds,
    actor,
    recordedAt,
    metadata,
  };
  const existingIndex = state.outcomes.findIndex(
    (entry: any) => entry?.outcomeId === outcomeId
  );
  let action = "created";
  if (existingIndex !== -1) {
    if (
      stableStringify(state.outcomes[existingIndex]) ===
      stableStringify(nextOutcome)
    ) {
      action = "noop";
    } else {
      action = "updated";
      state.outcomes[existingIndex] = nextOutcome;
    }
  } else {
    state.outcomes.push(nextOutcome);
  }
  state.outcomes = sortByTimestampAndId(
    state.outcomes,
    "recordedAt",
    "outcomeId"
  );
  const meta = buildMeta("outcome", storeId, profile, input);
  const mapping =
    action === "noop"
      ? {
          targetRuleIds: usedRuleIds,
          targetCandidateIds: [],
          updatedRuleIds: [],
          updatedCandidateIds: [],
        }
      : applyUtilitySignalToCandidatesAndRules(state, {
          targetRuleIds: usedRuleIds,
          targetCandidateIds: [],
          signalId: outcomeId,
          signalType: outcome === "failure" ? "harmful" : "helpful",
          source: `outcome_${outcome}`,
          delta: OUTCOME_UTILITY_SIGNAL_DELTA[outcome],
          note: task,
          actor,
          timestamp: recordedAt,
        });
  const mappingUpdatedCount =
    mapping.updatedRuleIds.length + mapping.updatedCandidateIds.length;
  const existingAudit = findPolicyAuditTrailByOperationEntity(
    state,
    "outcome",
    outcomeId
  );
  const auditEvent =
    action === "noop"
      ? null
      : appendPolicyAuditTrail(state, {
          operation: "outcome",
          storeId,
          profile,
          entityId: outcomeId,
          outcome: "recorded",
          reasonCodes: [
            `outcome_${outcome}`,
            mappingUpdatedCount > 0
              ? "memory_utility_signal_update"
              : "memory_utility_signal_record_only",
          ],
          details: {
            task,
            outcome,
            usedRuleIds,
            updatedRuleIds: mapping.updatedRuleIds,
            updatedCandidateIds: mapping.updatedCandidateIds,
            actor,
          },
          timestamp: recordedAt,
        });

  return {
    ...meta,
    action,
    outcomeId,
    task,
    outcome,
    usedRuleIds,
    actor,
    recordedAt,
    totalOutcomes: state.outcomes.length,
    mapping,
    policyAuditEventId:
      auditEvent?.auditEventId ?? existingAudit?.auditEventId ?? null,
    observability: {
      replaySafe: true,
      mappedUtilitySignals: mappingUpdatedCount,
      slo: buildSloObservability(meta.requestDigest, "outcome", 30),
    },
  };
}

function getReadonlyProfileState(storeId: any, profile: any) {
  const profiles = stores.get(storeId);
  if (!(profiles instanceof Map)) {
    return null;
  }
  return profiles.get(profile) ?? null;
}

function normalizeMemoryConsoleLimit(
  value: any,
  fallback: any = DEFAULT_MEMORY_CONSOLE_LIMIT
) {
  return Math.min(
    Math.max(toPositiveInteger(value, fallback), 1),
    MAX_LIST_ITEMS
  );
}

function flattenMemoryConsoleFilterValues(value: any, target: any = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      flattenMemoryConsoleFilterValues(entry, target);
    }
    return target;
  }
  if (value !== undefined && value !== null) {
    target.push(value);
  }
  return target;
}

function normalizeMemoryConsoleStringFilters(
  values: any,
  fieldName: any,
  { allowedValues = null, maxLength = 64, lowerCase = true }: any = {}
) {
  const rawEntries = flattenMemoryConsoleFilterValues(values, []);
  if (rawEntries.length === 0) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const rawEntry of rawEntries) {
    if (typeof rawEntry !== "string") {
      throw new Error(`${fieldName} entries must be non-empty strings.`);
    }
    const chunks = rawEntry.split(",");
    for (const chunk of chunks) {
      const compact = normalizeBoundedString(chunk, fieldName, maxLength);
      if (!compact) {
        continue;
      }
      const candidate = lowerCase ? compact.toLowerCase() : compact;
      if (allowedValues && !allowedValues.has(candidate)) {
        throw new Error(
          `${fieldName} must be one of: ${[...allowedValues].sort().join(", ")}.`
        );
      }
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      normalized.push(candidate);
    }
  }
  return normalized.sort((left: any, right: any) => left.localeCompare(right));
}

function normalizeMemoryConsoleTypeFilters(request: any, operationName: any) {
  return normalizeMemoryConsoleStringFilters(
    [request.type, request.types, request.entityType, request.entityTypes],
    `${operationName}.types`,
    {
      allowedValues: MEMORY_CONSOLE_ENTITY_TYPE_SET,
      maxLength: 64,
      lowerCase: true,
    }
  );
}

function normalizeMemoryConsoleTimestampRange(
  request: any,
  operationName: any
) {
  const since = normalizeIsoTimestamp(
    request.since ?? request.startAt ?? request.from,
    `${operationName}.since`,
    null
  );
  const until = normalizeIsoTimestamp(
    request.until ?? request.endAt ?? request.to,
    `${operationName}.until`,
    null
  );
  if (since && until && since.localeCompare(until) > 0) {
    throw new Error(
      `${operationName}.since must be <= ${operationName}.until.`
    );
  }
  return { since, until };
}

function parseMemoryConsoleEntityRef(rawRef: any, fieldName: any) {
  if (typeof rawRef === "string") {
    const compact = normalizeBoundedString(rawRef, fieldName, 256);
    if (!compact) {
      throw new Error(
        `${fieldName} entries must include "entityType:entityId".`
      );
    }
    const separatorIndex = compact.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= compact.length - 1) {
      throw new Error(
        `${fieldName} entries must include "entityType:entityId".`
      );
    }
    const entityType = compact.slice(0, separatorIndex).trim().toLowerCase();
    const entityId = compact.slice(separatorIndex + 1).trim();
    if (!MEMORY_CONSOLE_ENTITY_TYPE_SET.has(entityType)) {
      throw new Error(
        `${fieldName} entityType must be one of: ${MEMORY_CONSOLE_ENTITY_TYPES.join(", ")}.`
      );
    }
    const normalizedEntityId = normalizeBoundedString(
      entityId,
      `${fieldName}.entityId`,
      128
    );
    if (!normalizedEntityId) {
      throw new Error(`${fieldName}.entityId must be a non-empty string.`);
    }
    return {
      entityType,
      entityId: normalizedEntityId,
    };
  }
  if (!isPlainObject(rawRef)) {
    throw new Error(`${fieldName} entries must be strings or objects.`);
  }
  const entityType = normalizeBoundedString(
    rawRef.entityType ?? rawRef.type ?? rawRef.kind,
    `${fieldName}.entityType`,
    64
  );
  const entityId = normalizeBoundedString(
    rawRef.entityId ?? rawRef.id ?? rawRef.refId ?? rawRef.recordId,
    `${fieldName}.entityId`,
    128
  );
  if (!entityType || !entityId) {
    throw new Error(
      `${fieldName} object entries require entityType and entityId.`
    );
  }
  const normalizedType = entityType.toLowerCase();
  if (!MEMORY_CONSOLE_ENTITY_TYPE_SET.has(normalizedType)) {
    throw new Error(
      `${fieldName} entityType must be one of: ${MEMORY_CONSOLE_ENTITY_TYPES.join(", ")}.`
    );
  }
  return {
    entityType: normalizedType,
    entityId,
  };
}

function normalizeMemoryConsoleEntityRefs(request: any) {
  const rawRefs = request.entityRefs ?? request.entities ?? request.references;
  const normalizedRefs: Array<{ entityType: string; entityId: string }> = [];
  const seen = new Set();

  const appendRef = (rawRef: any, fieldName: any) => {
    const nextRef = parseMemoryConsoleEntityRef(rawRef, fieldName);
    const key = `${nextRef.entityType}:${nextRef.entityId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    normalizedRefs.push(nextRef);
  };

  if (rawRefs !== undefined) {
    const entries = Array.isArray(rawRefs) ? rawRefs : [rawRefs];
    for (const entry of entries) {
      appendRef(entry, "memory_console_provenance.entityRefs");
    }
  } else {
    const singleType = request.entityType ?? request.type;
    const singleId = request.entityId ?? request.id;
    const manyIds = request.entityIds ?? request.ids;
    if (singleType && manyIds !== undefined) {
      if (!Array.isArray(manyIds)) {
        throw new Error(
          "memory_console_provenance.entityIds must be an array."
        );
      }
      for (const entityId of manyIds) {
        appendRef(
          { entityType: singleType, entityId },
          "memory_console_provenance.entityRefs"
        );
      }
    } else if (singleType || singleId) {
      appendRef(
        { entityType: singleType, entityId: singleId },
        "memory_console_provenance.entityRefs"
      );
    }
  }

  ensureBoundedCount(normalizedRefs, "memory_console_provenance.entityRefs");
  return normalizedRefs.sort((left: any, right: any) => {
    const typeDiff = left.entityType.localeCompare(right.entityType);
    if (typeDiff !== 0) {
      return typeDiff;
    }
    return left.entityId.localeCompare(right.entityId);
  });
}

function collectMemoryConsoleLinkedSourceIds(record: any) {
  const collected: string[] = [];
  const visited = new Set();
  const visit = (value: any, depth: any = 0) => {
    if (!value || depth > MEMORY_CONSOLE_PROVENANCE_MAX_DEPTH) {
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (MEMORY_CONSOLE_PROVENANCE_SCALAR_KEYS.has(normalizedKey)) {
        const sourceId = normalizeBoundedStringLenient(
          nested,
          MAX_SIGNAL_ITEM_LENGTH
        );
        if (sourceId) {
          collected.push(sourceId);
        }
      }
      if (
        MEMORY_CONSOLE_PROVENANCE_ARRAY_KEYS.has(normalizedKey) &&
        Array.isArray(nested)
      ) {
        for (const sourceIdValue of nested) {
          const sourceId = normalizeBoundedStringLenient(
            sourceIdValue,
            MAX_SIGNAL_ITEM_LENGTH
          );
          if (sourceId) {
            collected.push(sourceId);
          }
        }
      }
      if (normalizedKey === "evidencepointers" && Array.isArray(nested)) {
        for (const pointer of nested) {
          if (!isPlainObject(pointer)) {
            continue;
          }
          const sourceId = normalizeBoundedStringLenient(
            pointer.pointerId ??
              pointer.id ??
              pointer.eventId ??
              pointer.signalId,
            MAX_SIGNAL_ITEM_LENGTH
          );
          if (sourceId) {
            collected.push(sourceId);
          }
        }
      }
      if (normalizedKey === "sourcesignals" && Array.isArray(nested)) {
        for (const signal of nested) {
          if (!isPlainObject(signal)) {
            continue;
          }
          const signalId = normalizeBoundedStringLenient(
            signal.signalId ?? signal.id,
            MAX_SIGNAL_ITEM_LENGTH
          );
          if (signalId) {
            collected.push(signalId);
          }
        }
      }
      if (Array.isArray(nested) || isPlainObject(nested)) {
        visit(nested, depth + 1);
      }
    }
  };

  visit(record);
  return asSortedUniqueStrings(collected);
}

function collectMemoryConsoleProvenancePointers(record: any) {
  const pointers = new Map();
  const visited = new Set();
  const visit = (value: any, depth: any = 0) => {
    if (!value || depth > MEMORY_CONSOLE_PROVENANCE_MAX_DEPTH) {
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "evidencepointers" && Array.isArray(nested)) {
        for (const pointer of nested) {
          if (!isPlainObject(pointer)) {
            continue;
          }
          const pointerId = normalizeBoundedStringLenient(
            pointer.pointerId ??
              pointer.id ??
              pointer.eventId ??
              pointer.signalId,
            MAX_SIGNAL_ITEM_LENGTH
          );
          if (!pointerId) {
            continue;
          }
          const kind =
            normalizeBoundedStringLenient(
              typeof pointer.kind === "string"
                ? pointer.kind.toLowerCase()
                : pointer.kind,
              32
            ) ?? "event";
          const source =
            normalizeBoundedStringLenient(
              pointer.source ?? pointer.namespace,
              64
            ) ?? "unspecified";
          const observedAt = normalizeIsoTimestampOrFallback(
            pointer.observedAt ?? pointer.timestamp ?? pointer.createdAt,
            null
          );
          const pointerKey = `${kind}:${source}:${pointerId}`;
          const existing = pointers.get(pointerKey);
          if (!existing) {
            pointers.set(pointerKey, {
              pointerId,
              kind,
              source,
              observedAt,
            });
            continue;
          }
          const nextObservedAt =
            existing.observedAt && observedAt
              ? existing.observedAt >= observedAt
                ? existing.observedAt
                : observedAt
              : (existing.observedAt ?? observedAt ?? null);
          pointers.set(pointerKey, {
            ...existing,
            observedAt: nextObservedAt,
          });
        }
      }
      if (Array.isArray(nested) || isPlainObject(nested)) {
        visit(nested, depth + 1);
      }
    }
  };

  visit(record);
  return [...pointers.values()].sort((left: any, right: any) => {
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
}

function toMemoryConsoleTimestamp(value: any) {
  return normalizeIsoTimestampOrFallback(value, DEFAULT_VERSION_TIMESTAMP);
}

function summarizeMemoryConsoleParts(values: any, fallback: any) {
  const summaryParts = [];
  for (const value of values) {
    const compact = normalizeBoundedStringLenient(value, 160);
    if (compact) {
      summaryParts.push(compact);
    }
  }
  return summaryParts.length > 0 ? summaryParts.join(" | ") : fallback;
}

function makeMemoryConsoleEntityRow({
  entityType,
  entityId,
  timestamp,
  summaryParts = [],
  searchParts = [],
  record = null,
}: any) {
  const normalizedType =
    normalizeBoundedStringLenient(
      typeof entityType === "string" ? entityType.toLowerCase() : entityType,
      64
    ) ?? "";
  if (!MEMORY_CONSOLE_ENTITY_TYPE_SET.has(normalizedType)) {
    return null;
  }
  const normalizedEntityId = normalizeBoundedStringLenient(entityId, 128);
  if (!normalizedEntityId) {
    return null;
  }
  const normalizedTimestamp = toMemoryConsoleTimestamp(timestamp);
  const summary = summarizeMemoryConsoleParts(
    summaryParts,
    `${normalizedType}:${normalizedEntityId}`
  );
  const sourceIds = collectMemoryConsoleLinkedSourceIds(record);
  const provenancePointers = collectMemoryConsoleProvenancePointers(record);
  const searchableParts = [
    normalizedType,
    normalizedEntityId,
    summary,
    ...searchParts,
    ...sourceIds,
    ...provenancePointers.flatMap((pointer: any) => [
      pointer.pointerId,
      pointer.kind,
      pointer.source,
    ]),
  ];
  const searchableText = searchableParts
    .map((part: any) => normalizeBoundedStringLenient(part, 512))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return {
    entityType: normalizedType,
    entityId: normalizedEntityId,
    timestamp: normalizedTimestamp,
    summary,
    sourceIds,
    provenancePointers,
    searchableText,
  };
}

function compareMemoryConsoleRows(left: any, right: any) {
  const timestampDiff = String(right?.timestamp ?? "").localeCompare(
    String(left?.timestamp ?? "")
  );
  if (timestampDiff !== 0) {
    return timestampDiff;
  }
  const typeDiff = String(left?.entityType ?? "").localeCompare(
    String(right?.entityType ?? "")
  );
  if (typeDiff !== 0) {
    return typeDiff;
  }
  return String(left?.entityId ?? "").localeCompare(
    String(right?.entityId ?? "")
  );
}

function buildMemoryConsoleEntityRows(state: any) {
  if (!state || typeof state !== "object") {
    return [];
  }
  const rows: any[] = [];
  const appendRow = (row: any) => {
    if (row) {
      rows.push(row);
    }
  };

  for (const learnerProfile of Array.isArray(state.learnerProfiles)
    ? state.learnerProfiles
    : []) {
    const identityRefs = Array.isArray(learnerProfile?.identityRefs)
      ? learnerProfile.identityRefs
      : [];
    const identityRefSummary = identityRefs
      .slice(0, 3)
      .map(
        (identityRef: any) =>
          `${normalizeBoundedStringLenient(identityRef?.namespace, 64) ?? "unknown"}:${
            normalizeBoundedStringLenient(identityRef?.value, 128) ?? "unknown"
          }`
      );
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "learner_profile",
        entityId: learnerProfile?.profileId,
        timestamp: learnerProfile?.updatedAt ?? learnerProfile?.createdAt,
        summaryParts: [
          `learner=${learnerProfile?.learnerId ?? "unknown"}`,
          `goals=${(Array.isArray(learnerProfile?.goals) ? learnerProfile.goals.slice(0, 2) : []).join(",") || "none"}`,
        ],
        searchParts: [
          learnerProfile?.learnerId,
          learnerProfile?.displayName,
          learnerProfile?.email,
          ...(Array.isArray(learnerProfile?.goals) ? learnerProfile.goals : []),
          ...(Array.isArray(learnerProfile?.interestTags)
            ? learnerProfile.interestTags
            : []),
          ...(Array.isArray(learnerProfile?.misconceptionIds)
            ? learnerProfile.misconceptionIds
            : []),
          ...identityRefSummary,
        ],
        record: learnerProfile,
      })
    );
  }

  for (const edge of Array.isArray(state.identityGraphEdges)
    ? state.identityGraphEdges
    : []) {
    const fromRef = `${normalizeBoundedStringLenient(edge?.fromRef?.namespace, 64) ?? "unknown"}:${
      normalizeBoundedStringLenient(edge?.fromRef?.value, 128) ?? "unknown"
    }`;
    const toRef = `${normalizeBoundedStringLenient(edge?.toRef?.namespace, 64) ?? "unknown"}:${
      normalizeBoundedStringLenient(edge?.toRef?.value, 128) ?? "unknown"
    }`;
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "identity_graph_edge",
        entityId: edge?.edgeId,
        timestamp: edge?.updatedAt ?? edge?.createdAt,
        summaryParts: [
          `relation=${edge?.relation ?? "alias_of"}`,
          `${fromRef} -> ${toRef}`,
        ],
        searchParts: [
          edge?.relation,
          fromRef,
          toRef,
          ...(Array.isArray(edge?.evidenceEventIds)
            ? edge.evidenceEventIds
            : []),
        ],
        record: edge,
      })
    );
  }

  for (const misconception of Array.isArray(state.misconceptions)
    ? state.misconceptions
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "misconception",
        entityId: misconception?.misconceptionId,
        timestamp: misconception?.updatedAt ?? misconception?.createdAt,
        summaryParts: [
          `key=${misconception?.misconceptionKey ?? "unknown"}`,
          `status=${misconception?.status ?? "active"}`,
          `signal=${misconception?.signal ?? "harmful"}`,
        ],
        searchParts: [
          misconception?.misconceptionKey,
          misconception?.status,
          misconception?.signal,
          ...(Array.isArray(misconception?.sourceSignalIds)
            ? misconception.sourceSignalIds
            : []),
          ...(Array.isArray(misconception?.evidenceEventIds)
            ? misconception.evidenceEventIds
            : []),
        ],
        record: misconception,
      })
    );
  }

  for (const planItem of Array.isArray(state.curriculumPlanItems)
    ? state.curriculumPlanItems
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "curriculum_plan_item",
        entityId: planItem?.planItemId,
        timestamp: planItem?.updatedAt ?? planItem?.createdAt,
        summaryParts: [
          `objective=${planItem?.objectiveId ?? "unknown"}`,
          `status=${planItem?.status ?? "proposed"}`,
          `rank=${toPositiveInteger(planItem?.recommendationRank, 1)}`,
        ],
        searchParts: [
          planItem?.objectiveId,
          planItem?.status,
          ...(Array.isArray(planItem?.sourceMisconceptionIds)
            ? planItem.sourceMisconceptionIds
            : []),
          ...(Array.isArray(planItem?.interestTags)
            ? planItem.interestTags
            : []),
          ...(Array.isArray(planItem?.provenanceSignalIds)
            ? planItem.provenanceSignalIds
            : []),
        ],
        record: planItem,
      })
    );
  }

  for (const reviewEntry of Array.isArray(state.reviewScheduleEntries)
    ? state.reviewScheduleEntries
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "review_schedule_entry",
        entityId: reviewEntry?.scheduleEntryId,
        timestamp: reviewEntry?.updatedAt ?? reviewEntry?.createdAt,
        summaryParts: [
          `target=${reviewEntry?.targetId ?? "unknown"}`,
          `status=${reviewEntry?.status ?? "scheduled"}`,
          `dueAt=${toMemoryConsoleTimestamp(reviewEntry?.dueAt)}`,
        ],
        searchParts: [
          reviewEntry?.targetId,
          reviewEntry?.status,
          ...(Array.isArray(reviewEntry?.sourceEventIds)
            ? reviewEntry.sourceEventIds
            : []),
          ...(Array.isArray(reviewEntry?.evidenceEventIds)
            ? reviewEntry.evidenceEventIds
            : []),
        ],
        record: reviewEntry,
      })
    );
  }

  for (const painSignal of Array.isArray(state.painSignals)
    ? state.painSignals
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "pain_signal",
        entityId: painSignal?.painSignalId,
        timestamp: painSignal?.recordedAt,
        summaryParts: [
          `misconception=${painSignal?.misconceptionKey ?? "unknown"}`,
          `type=${painSignal?.signalType ?? "harmful"}`,
          `severity=${roundNumber(stableScore(painSignal?.severity, 0), 4)}`,
        ],
        searchParts: [
          painSignal?.misconceptionKey,
          painSignal?.signalType,
          painSignal?.note,
          ...(Array.isArray(painSignal?.sourceEventIds)
            ? painSignal.sourceEventIds
            : []),
          ...(Array.isArray(painSignal?.evidenceEventIds)
            ? painSignal.evidenceEventIds
            : []),
        ],
        record: painSignal,
      })
    );
  }

  for (const failureSignal of Array.isArray(state.failureSignals)
    ? state.failureSignals
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "failure_signal",
        entityId: failureSignal?.failureSignalId,
        timestamp: failureSignal?.recordedAt,
        summaryParts: [
          `misconception=${failureSignal?.misconceptionKey ?? "unknown"}`,
          `type=${failureSignal?.failureType ?? "test_failure"}`,
          `count=${toPositiveInteger(failureSignal?.failureCount, 1)}`,
        ],
        searchParts: [
          failureSignal?.misconceptionKey,
          failureSignal?.failureType,
          failureSignal?.outcomeRef,
          ...(Array.isArray(failureSignal?.sourceEventIds)
            ? failureSignal.sourceEventIds
            : []),
          ...(Array.isArray(failureSignal?.evidenceEventIds)
            ? failureSignal.evidenceEventIds
            : []),
        ],
        record: failureSignal,
      })
    );
  }

  for (const incident of Array.isArray(state.incidentEscalations)
    ? state.incidentEscalations
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "incident_escalation",
        entityId: incident?.escalationSignalId,
        timestamp: incident?.recordedAt,
        summaryParts: [
          `incident=${incident?.incidentRef ?? "unspecified_incident"}`,
          `severity=${incident?.severity ?? "high"}`,
          `type=${incident?.escalationType ?? "failure_event"}`,
        ],
        searchParts: [
          incident?.incidentRef,
          incident?.severity,
          incident?.escalationType,
          ...(Array.isArray(incident?.reasonCodes) ? incident.reasonCodes : []),
          ...(Array.isArray(incident?.sourceEventIds)
            ? incident.sourceEventIds
            : []),
          ...(Array.isArray(incident?.evidenceEventIds)
            ? incident.evidenceEventIds
            : []),
        ],
        record: incident,
      })
    );
  }

  for (const control of Array.isArray(state.manualOverrideControls)
    ? state.manualOverrideControls
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "manual_override_control",
        entityId: control?.overrideControlId,
        timestamp: control?.recordedAt,
        summaryParts: [
          `action=${control?.overrideAction ?? "suppress"}`,
          `actor=${control?.actor ?? "unknown"}`,
        ],
        searchParts: [
          control?.overrideAction,
          control?.actor,
          control?.reason,
          ...(Array.isArray(control?.reasonCodes) ? control.reasonCodes : []),
          ...(Array.isArray(control?.targetCandidateIds)
            ? control.targetCandidateIds
            : []),
          ...(Array.isArray(control?.targetRuleIds)
            ? control.targetRuleIds
            : []),
          ...(Array.isArray(control?.sourceEventIds)
            ? control.sourceEventIds
            : []),
        ],
        record: control,
      })
    );
  }

  for (const decision of Array.isArray(state.policyDecisions)
    ? state.policyDecisions
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "policy_decision",
        entityId: decision?.decisionId,
        timestamp: decision?.updatedAt ?? decision?.createdAt,
        summaryParts: [
          `policy=${decision?.policyKey ?? "unknown"}`,
          `outcome=${decision?.outcome ?? "review"}`,
        ],
        searchParts: [
          decision?.policyKey,
          decision?.outcome,
          ...(Array.isArray(decision?.reasonCodes) ? decision.reasonCodes : []),
          ...(Array.isArray(decision?.provenanceEventIds)
            ? decision.provenanceEventIds
            : []),
        ],
        record: decision,
      })
    );
  }

  for (const auditEntry of Array.isArray(state.policyAuditTrail)
    ? state.policyAuditTrail
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "policy_audit_event",
        entityId: auditEntry?.auditEventId,
        timestamp: auditEntry?.timestamp,
        summaryParts: [
          `operation=${auditEntry?.operation ?? "unknown"}`,
          `outcome=${auditEntry?.outcome ?? "recorded"}`,
        ],
        searchParts: [
          auditEntry?.operation,
          auditEntry?.outcome,
          auditEntry?.entityId,
          ...(Array.isArray(auditEntry?.reasonCodes)
            ? auditEntry.reasonCodes
            : []),
        ],
        record: auditEntry,
      })
    );
  }

  for (const candidate of Array.isArray(state.shadowCandidates)
    ? state.shadowCandidates
    : []) {
    const statementSnippet =
      normalizeBoundedStringLenient(candidate?.statement, 96) ?? "";
    const status =
      normalizeBoundedStringLenient(candidate?.status, 32) ??
      (candidate?.demotedAt ? "demoted" : "active");
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "shadow_candidate",
        entityId: candidate?.candidateId,
        timestamp: candidate?.updatedAt ?? candidate?.createdAt,
        summaryParts: [
          `status=${status}`,
          statementSnippet ? `statement=${statementSnippet}` : "",
        ],
        searchParts: [
          candidate?.ruleId,
          candidate?.statement,
          status,
          ...(Array.isArray(candidate?.latestDemotionReasonCodes)
            ? candidate.latestDemotionReasonCodes
            : []),
          ...(Array.isArray(candidate?.sourceEventIds)
            ? candidate.sourceEventIds
            : []),
          ...(Array.isArray(candidate?.evidenceEventIds)
            ? candidate.evidenceEventIds
            : []),
        ],
        record: candidate,
      })
    );
  }

  for (const evaluation of Array.isArray(state.replayEvaluations)
    ? state.replayEvaluations
    : []) {
    const replayStatus =
      evaluation?.pass === true
        ? "pass"
        : evaluation?.pass === false
          ? "fail"
          : "unknown";
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "replay_evaluation",
        entityId: evaluation?.replayEvalId,
        timestamp: evaluation?.evaluatedAt,
        summaryParts: [
          `candidate=${evaluation?.candidateId ?? "unknown"}`,
          `status=${replayStatus}`,
        ],
        searchParts: [
          evaluation?.candidateId,
          replayStatus,
          ...(Array.isArray(evaluation?.reasonCodes)
            ? evaluation.reasonCodes
            : []),
        ],
        record: evaluation,
      })
    );
  }

  for (const feedbackEntry of Array.isArray(state.feedback)
    ? state.feedback
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "feedback",
        entityId: feedbackEntry?.feedbackId,
        timestamp: feedbackEntry?.recordedAt,
        summaryParts: [
          `signal=${feedbackEntry?.signal ?? "helpful"}`,
          `target=${feedbackEntry?.targetRuleId ?? feedbackEntry?.targetCandidateId ?? "none"}`,
        ],
        searchParts: [
          feedbackEntry?.signal,
          feedbackEntry?.targetRuleId,
          feedbackEntry?.targetCandidateId,
          feedbackEntry?.note,
        ],
        record: feedbackEntry,
      })
    );
  }

  for (const outcomeEntry of Array.isArray(state.outcomes)
    ? state.outcomes
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "outcome",
        entityId: outcomeEntry?.outcomeId,
        timestamp: outcomeEntry?.recordedAt,
        summaryParts: [
          `task=${outcomeEntry?.task ?? "unknown"}`,
          `outcome=${outcomeEntry?.outcome ?? "success"}`,
        ],
        searchParts: [
          outcomeEntry?.task,
          outcomeEntry?.outcome,
          ...(Array.isArray(outcomeEntry?.usedRuleIds)
            ? outcomeEntry.usedRuleIds
            : []),
        ],
        record: outcomeEntry,
      })
    );
  }

  for (const session of Array.isArray(state.degradedTutorSessions)
    ? state.degradedTutorSessions
    : []) {
    appendRow(
      makeMemoryConsoleEntityRow({
        entityType: "degraded_tutor_session",
        entityId: session?.sessionId,
        timestamp: session?.timestamp,
        summaryParts: [
          `degradedMode=${Boolean(session?.degradedMode)}`,
          `query=${normalizeBoundedStringLenient(session?.query, 96) ?? "unknown"}`,
        ],
        searchParts: [
          session?.query,
          ...(Array.isArray(session?.warnings) ? session.warnings : []),
          ...(Array.isArray(session?.suggestionIds)
            ? session.suggestionIds
            : []),
        ],
        record: session,
      })
    );
  }

  return rows.sort(compareMemoryConsoleRows);
}

function scoreMemoryConsoleSearchRow(row: any, query: any) {
  if (!query) {
    return 0;
  }
  let score = 0;
  const queryLower = query.toLowerCase();
  const entityIdLower = row.entityId.toLowerCase();
  const summaryLower = row.summary.toLowerCase();
  if (entityIdLower === queryLower) {
    score += 200;
  } else if (entityIdLower.includes(queryLower)) {
    score += 120;
  }
  if (summaryLower.includes(queryLower)) {
    score += 80;
  }
  if (
    row.sourceIds.some((sourceId: any) => sourceId.toLowerCase() === queryLower)
  ) {
    score += 70;
  } else if (
    row.sourceIds.some((sourceId: any) =>
      sourceId.toLowerCase().includes(queryLower)
    )
  ) {
    score += 50;
  }
  if (row.searchableText.includes(queryLower)) {
    score += 20;
  }
  return score;
}

function hasMatchingReasonCode(reasonCodes: any, reasonCodeFilters: any) {
  if (reasonCodeFilters.length === 0) {
    return true;
  }
  const normalizedCodes = new Set(
    asSortedUniqueStrings(reasonCodes).map((reasonCode: any) =>
      reasonCode.toLowerCase()
    )
  );
  return reasonCodeFilters.some((reasonCode: any) =>
    normalizedCodes.has(reasonCode)
  );
}

function isTimestampWithinRange(
  timestamp: any,
  { since = null, until = null, includeUntil = true }: any = {}
) {
  if (since && timestamp.localeCompare(since) < 0) {
    return false;
  }
  if (!until) {
    return true;
  }
  const compareUntil = timestamp.localeCompare(until);
  if (compareUntil > 0) {
    return false;
  }
  if (!includeUntil && compareUntil === 0) {
    return false;
  }
  return true;
}

function filterEventsByWindow(
  events: any,
  { since = null, until = null, includeUntil = true }: any = {}
) {
  return (Array.isArray(events) ? events : []).filter((entry: any) =>
    isTimestampWithinRange(toMemoryConsoleTimestamp(entry?.timestamp), {
      since,
      until,
      includeUntil,
    })
  );
}

function resolveAnomalyWindow(request: any, latestTimestamp: any) {
  const operationName = "memory_console_anomaly_alerts";
  const { since: requestedSince, until: requestedUntil } =
    normalizeMemoryConsoleTimestampRange(request, operationName);
  const windowHours = Math.min(
    Math.max(
      toPositiveInteger(
        request.windowHours ?? request.lookbackHours,
        DEFAULT_ANOMALY_WINDOW_HOURS
      ),
      1
    ),
    MAX_ANOMALY_WINDOW_HOURS
  );
  const until = requestedUntil ?? latestTimestamp ?? DEFAULT_VERSION_TIMESTAMP;
  const since = requestedSince ?? addHoursToIso(until, -windowHours);
  if (since.localeCompare(until) > 0) {
    throw new Error(
      `${operationName}.since must be <= ${operationName}.until.`
    );
  }
  return {
    windowHours,
    observation: {
      since,
      until,
    },
    baseline: {
      since: addHoursToIso(since, -windowHours),
      until: since,
    },
  };
}

function countEventsByField(
  events: any,
  fieldName: any,
  fallback: any = "unknown"
) {
  const counts: Record<string, number> = {};
  for (const event of Array.isArray(events) ? events : []) {
    const key =
      normalizeBoundedStringLenient(event?.[fieldName], 128) ??
      (typeof fallback === "string" ? fallback : "unknown");
    counts[key] = toNonNegativeInteger(counts[key], 0) + 1;
  }
  return stableSortObject(counts);
}

function evaluateAnomalyRule(events: any, window: any, rule: any) {
  const baselineEvents = filterEventsByWindow(events, {
    since: window.baseline.since,
    until: window.baseline.until,
    includeUntil: false,
  });
  const observationEvents = filterEventsByWindow(events, {
    since: window.observation.since,
    until: window.observation.until,
    includeUntil: true,
  });
  const baselineCount = baselineEvents.length;
  const observationCount = observationEvents.length;
  const delta = observationCount - baselineCount;
  const ratio =
    baselineCount > 0 ? roundNumber(observationCount / baselineCount, 6) : null;
  const meetsObservationFloor = observationCount >= rule.minObservationCount;
  const meetsDelta = baselineCount === 0 ? true : delta >= rule.minDelta;
  const meetsMultiplier =
    baselineCount === 0
      ? true
      : observationCount >= Math.ceil(baselineCount * rule.multiplier);
  const triggered = meetsObservationFloor && meetsDelta && meetsMultiplier;
  let severity = "none";
  if (triggered) {
    const criticalThreshold = Math.max(
      rule.minObservationCount + rule.minDelta,
      rule.minObservationCount + 1
    );
    severity = observationCount >= criticalThreshold ? "critical" : "warn";
  }
  return {
    triggered,
    severity,
    baselineCount,
    observationCount,
    delta,
    ratio,
    baselineEvents,
    observationEvents,
  };
}

function takeAnomalyEvidenceIds(events: any) {
  return asSortedUniqueStrings(
    (Array.isArray(events) ? events : [])
      .slice(-MAX_ANOMALY_EVIDENCE_IDS)
      .map((event: any) => normalizeBoundedStringLenient(event?.eventId, 128))
      .filter(Boolean)
  );
}

function sortAnomalyAlerts(alerts: any) {
  const severityOrder = {
    critical: 2,
    warn: 1,
    none: 0,
  } as const;
  return [...(Array.isArray(alerts) ? alerts : [])].sort(
    (left: any, right: any) => {
      const rightSeverity =
        typeof right?.severity === "string" && right.severity in severityOrder
          ? (right.severity as keyof typeof severityOrder)
          : "none";
      const leftSeverity =
        typeof left?.severity === "string" && left.severity in severityOrder
          ? (left.severity as keyof typeof severityOrder)
          : "none";
      const severityDiff =
        toNonNegativeInteger(severityOrder[rightSeverity], 0) -
        toNonNegativeInteger(severityOrder[leftSeverity], 0);
      if (severityDiff !== 0) {
        return severityDiff;
      }
      const typeDiff = String(left?.type ?? "").localeCompare(
        String(right?.type ?? "")
      );
      if (typeDiff !== 0) {
        return typeDiff;
      }
      return String(left?.alertId ?? "").localeCompare(
        String(right?.alertId ?? "")
      );
    }
  );
}

function buildAnomalyAlertRecord({
  type,
  severity,
  storeId,
  profile,
  window,
  summary,
  evidenceEventIds,
  details = {},
  stats,
}: any) {
  const material = stableSortObject({
    type,
    severity,
    storeId,
    profile,
    window,
    summary,
    evidenceEventIds,
    details,
    stats: {
      baselineCount: stats.baselineCount,
      observationCount: stats.observationCount,
      delta: stats.delta,
      ratio: stats.ratio,
    },
  });
  return {
    alertId: makeId("alrt", hash(stableStringify(material))),
    type,
    severity,
    status: "triggered",
    summary,
    observationCount: stats.observationCount,
    baselineCount: stats.baselineCount,
    delta: stats.delta,
    ratio: stats.ratio,
    window: stableSortObject({
      observation: window.observation,
      baseline: window.baseline,
    }),
    evidenceEventIds,
    details: stableSortObject(details),
  };
}

function collectHarmfulSignalEvents(state: any) {
  const events = [];
  for (const signal of Array.isArray(state?.painSignals)
    ? state.painSignals
    : []) {
    events.push({
      eventId:
        normalizeBoundedString(
          signal?.painSignalId,
          "memory_console_anomaly_alerts.painSignalId",
          64
        ) ?? makeId("pain", hash(stableStringify(signal))),
      timestamp: toMemoryConsoleTimestamp(signal?.recordedAt),
      source: "pain_signal_ingest",
    });
  }
  for (const signal of Array.isArray(state?.failureSignals)
    ? state.failureSignals
    : []) {
    events.push({
      eventId:
        normalizeBoundedString(
          signal?.failureSignalId,
          "memory_console_anomaly_alerts.failureSignalId",
          64
        ) ?? makeId("fail", hash(stableStringify(signal))),
      timestamp: toMemoryConsoleTimestamp(signal?.recordedAt),
      source: "failure_signal_ingest",
    });
  }
  for (const feedback of Array.isArray(state?.feedback) ? state.feedback : []) {
    if (feedback?.signal !== "harmful") {
      continue;
    }
    events.push({
      eventId:
        normalizeBoundedString(
          feedback?.feedbackId,
          "memory_console_anomaly_alerts.feedbackId",
          64
        ) ?? makeId("fdbk", hash(stableStringify(feedback))),
      timestamp: toMemoryConsoleTimestamp(feedback?.recordedAt),
      source: "feedback",
    });
  }
  for (const outcome of Array.isArray(state?.outcomes) ? state.outcomes : []) {
    if (outcome?.outcome !== "failure") {
      continue;
    }
    events.push({
      eventId:
        normalizeBoundedString(
          outcome?.outcomeId,
          "memory_console_anomaly_alerts.outcomeId",
          64
        ) ?? makeId("out", hash(stableStringify(outcome))),
      timestamp: toMemoryConsoleTimestamp(outcome?.recordedAt),
      source: "outcome",
    });
  }
  return sortByTimestampAndId(events, "timestamp", "eventId");
}

function collectUnauthorizedAccessEvents(state: any) {
  const events = [];
  for (const entry of Array.isArray(state?.policyAuditTrail)
    ? state.policyAuditTrail
    : []) {
    const outcome =
      normalizeBoundedStringLenient(entry?.outcome, 16)?.toLowerCase() ??
      "recorded";
    if (outcome !== "deny") {
      continue;
    }
    const reasonCodes = asSortedUniqueStrings(entry?.reasonCodes).map(
      (reasonCode: any) => reasonCode.toLowerCase()
    );
    if (!reasonCodes.includes("allowlist_denied")) {
      continue;
    }
    events.push({
      eventId:
        normalizeBoundedString(
          entry?.auditEventId,
          "memory_console_anomaly_alerts.auditEventId",
          64
        ) ?? makeId("audit", hash(stableStringify(entry))),
      timestamp: toMemoryConsoleTimestamp(entry?.timestamp),
      source: normalizeBoundedStringLenient(entry?.operation, 64) ?? "unknown",
      requesterStoreId:
        normalizeBoundedStringLenient(entry?.details?.requesterStoreId, 128) ??
        "unknown",
    });
  }
  return sortByTimestampAndId(events, "timestamp", "eventId");
}

function collectPolicyDriftIndicatorEvents(state: any) {
  const policyAuditEvents = sortByTimestampAndId(
    (Array.isArray(state?.policyAuditTrail)
      ? state.policyAuditTrail
      : []
    ).filter(
      (entry: any) =>
        normalizeBoundedStringLenient(entry?.operation, 64)?.toLowerCase() ===
        "policy_decision_update"
    ),
    "timestamp",
    "auditEventId"
  );
  const latestOutcomeByPolicyKey = new Map();
  const indicators = [];

  for (const entry of policyAuditEvents) {
    const policyKey =
      normalizeBoundedStringLenient(entry?.details?.policyKey, 128) ??
      "unknown";
    const outcome =
      normalizeBoundedStringLenient(entry?.outcome, 16)?.toLowerCase() ??
      "review";
    const previousOutcome = latestOutcomeByPolicyKey.get(policyKey);
    latestOutcomeByPolicyKey.set(policyKey, outcome);
    if (!previousOutcome || previousOutcome === outcome) {
      continue;
    }
    indicators.push({
      eventId:
        normalizeBoundedString(
          entry?.auditEventId,
          "memory_console_anomaly_alerts.auditEventId",
          64
        ) ?? makeId("audit", hash(stableStringify(entry))),
      timestamp: toMemoryConsoleTimestamp(entry?.timestamp),
      source: "policy_decision_update",
      policyKey,
      previousOutcome,
      nextOutcome: outcome,
    });
  }

  return sortByTimestampAndId(indicators, "timestamp", "eventId");
}

function latestAnomalyTimestamp(eventGroups: any) {
  let latest = DEFAULT_VERSION_TIMESTAMP;
  for (const group of Array.isArray(eventGroups) ? eventGroups : []) {
    for (const event of Array.isArray(group) ? group : []) {
      const timestamp = toMemoryConsoleTimestamp(event?.timestamp);
      if (timestamp.localeCompare(latest) > 0) {
        latest = timestamp;
      }
    }
  }
  return latest;
}

function runMemoryConsoleAnomalyAlerts(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "memory_console_anomaly_alerts",
    request
  );
  const state = getReadonlyProfileState(storeId, profile);
  const harmfulEvents = collectHarmfulSignalEvents(state);
  const unauthorizedEvents = collectUnauthorizedAccessEvents(state);
  const policyDriftEvents = collectPolicyDriftIndicatorEvents(state);
  const window = resolveAnomalyWindow(
    request,
    latestAnomalyTimestamp([
      harmfulEvents,
      unauthorizedEvents,
      policyDriftEvents,
    ])
  );

  const harmfulStats = evaluateAnomalyRule(
    harmfulEvents,
    window,
    ANOMALY_ALERT_RULES.harmful_signal_spike
  );
  const unauthorizedStats = evaluateAnomalyRule(
    unauthorizedEvents,
    window,
    ANOMALY_ALERT_RULES.unauthorized_access_spike
  );
  const policyDriftStats = evaluateAnomalyRule(
    policyDriftEvents,
    window,
    ANOMALY_ALERT_RULES.policy_drift_indicator
  );

  const harmfulEvidenceIds = takeAnomalyEvidenceIds(
    harmfulStats.observationEvents
  );
  const unauthorizedEvidenceIds = takeAnomalyEvidenceIds(
    unauthorizedStats.observationEvents
  );
  const policyDriftEvidenceIds = takeAnomalyEvidenceIds(
    policyDriftStats.observationEvents
  );
  const harmfulSourceCounts = countEventsByField(
    harmfulStats.observationEvents,
    "source"
  );
  const unauthorizedOperationCounts = countEventsByField(
    unauthorizedStats.observationEvents,
    "source",
    "unknown_operation"
  );
  const unauthorizedRequesterCounts = countEventsByField(
    unauthorizedStats.observationEvents,
    "requesterStoreId",
    "unknown_requester"
  );
  const policyDriftByPolicyKey = countEventsByField(
    policyDriftStats.observationEvents,
    "policyKey",
    "unknown"
  );
  const policyTransitions = asSortedUniqueStrings(
    policyDriftStats.observationEvents.map((event: any) =>
      normalizeBoundedStringLenient(
        `${event.policyKey}:${event.previousOutcome}->${event.nextOutcome}`,
        256
      )
    )
  );

  const alerts = [];
  if (harmfulStats.triggered) {
    alerts.push(
      buildAnomalyAlertRecord({
        type: "harmful_signal_spike",
        severity: harmfulStats.severity,
        storeId,
        profile,
        window,
        summary:
          "Harmful-signal volume exceeded deterministic spike thresholds.",
        evidenceEventIds: harmfulEvidenceIds,
        details: {
          sourceCounts: harmfulSourceCounts,
        },
        stats: harmfulStats,
      })
    );
  }
  if (unauthorizedStats.triggered) {
    alerts.push(
      buildAnomalyAlertRecord({
        type: "unauthorized_access_spike",
        severity: unauthorizedStats.severity,
        storeId,
        profile,
        window,
        summary:
          "Unauthorized access attempts exceeded deterministic spike thresholds.",
        evidenceEventIds: unauthorizedEvidenceIds,
        details: {
          operationCounts: unauthorizedOperationCounts,
          requesterCounts: unauthorizedRequesterCounts,
        },
        stats: unauthorizedStats,
      })
    );
  }
  if (policyDriftStats.triggered) {
    alerts.push(
      buildAnomalyAlertRecord({
        type: "policy_drift_indicator",
        severity: policyDriftStats.severity,
        storeId,
        profile,
        window,
        summary:
          "Policy outcome transitions indicate deterministic drift pressure.",
        evidenceEventIds: policyDriftEvidenceIds,
        details: {
          policyKeyCounts: policyDriftByPolicyKey,
          transitions: policyTransitions,
        },
        stats: policyDriftStats,
      })
    );
  }

  const orderedAlerts = sortAnomalyAlerts(alerts);
  const criticalAlertCount = orderedAlerts.filter(
    (alert: any) => alert.severity === "critical"
  ).length;
  const warningAlertCount = orderedAlerts.filter(
    (alert: any) => alert.severity === "warn"
  ).length;

  return {
    ...buildMeta("memory_console_anomaly_alerts", storeId, profile, input),
    action: "analyzed",
    filters: {
      since: window.observation.since,
      until: window.observation.until,
      windowHours: window.windowHours,
    },
    windows: stableSortObject({
      observation: window.observation,
      baseline: window.baseline,
    }),
    thresholds: stableSortObject({
      harmfulSignalSpike: ANOMALY_ALERT_RULES.harmful_signal_spike,
      unauthorizedAccessSpike: ANOMALY_ALERT_RULES.unauthorized_access_spike,
      policyDriftIndicator: ANOMALY_ALERT_RULES.policy_drift_indicator,
    }),
    signals: {
      harmfulSignalSpike: {
        triggered: harmfulStats.triggered,
        severity: harmfulStats.severity,
        observationCount: harmfulStats.observationCount,
        baselineCount: harmfulStats.baselineCount,
        delta: harmfulStats.delta,
        ratio: harmfulStats.ratio,
        sourceCounts: harmfulSourceCounts,
        evidenceEventIds: harmfulEvidenceIds,
      },
      unauthorizedAccessSpike: {
        triggered: unauthorizedStats.triggered,
        severity: unauthorizedStats.severity,
        observationCount: unauthorizedStats.observationCount,
        baselineCount: unauthorizedStats.baselineCount,
        delta: unauthorizedStats.delta,
        ratio: unauthorizedStats.ratio,
        operationCounts: unauthorizedOperationCounts,
        requesterCounts: unauthorizedRequesterCounts,
        evidenceEventIds: unauthorizedEvidenceIds,
      },
      policyDriftIndicator: {
        triggered: policyDriftStats.triggered,
        severity: policyDriftStats.severity,
        observationCount: policyDriftStats.observationCount,
        baselineCount: policyDriftStats.baselineCount,
        delta: policyDriftStats.delta,
        ratio: policyDriftStats.ratio,
        policyKeyCounts: policyDriftByPolicyKey,
        transitions: policyTransitions,
        evidenceEventIds: policyDriftEvidenceIds,
      },
    },
    alerts: orderedAlerts,
    summary: {
      totalAlerts: orderedAlerts.length,
      criticalAlerts: criticalAlertCount,
      warningAlerts: warningAlertCount,
      categoriesTriggered: asSortedUniqueStrings(
        orderedAlerts.map((alert: any) => alert.type)
      ),
    },
  };
}

function runMemoryConsoleSearch(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "memory_console_search",
    request
  );
  const state = getReadonlyProfileState(storeId, profile);
  const limit = normalizeMemoryConsoleLimit(
    request.limit,
    DEFAULT_MEMORY_CONSOLE_LIMIT
  );
  const query = normalizeBoundedString(
    request.query ?? request.q ?? request.text,
    "memory_console_search.query",
    256
  );
  const queryLower = query ? query.toLowerCase() : null;
  const typeFilters = normalizeMemoryConsoleTypeFilters(
    request,
    "memory_console_search"
  );
  const rows = buildMemoryConsoleEntityRows(state);
  const matches = rows.filter((row: any) => {
    if (typeFilters.length > 0 && !typeFilters.includes(row.entityType)) {
      return false;
    }
    if (queryLower && !row.searchableText.includes(queryLower)) {
      return false;
    }
    return true;
  });
  const results = matches
    .map((row: any) => ({
      row,
      score: scoreMemoryConsoleSearchRow(row, queryLower),
    }))
    .sort((left: any, right: any) => {
      const scoreDiff = right.score - left.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return compareMemoryConsoleRows(left.row, right.row);
    })
    .slice(0, limit)
    .map(({ row }: any) => ({
      entityType: row.entityType,
      entityId: row.entityId,
      timestamp: row.timestamp,
      summary: row.summary,
      sourceIds: row.sourceIds,
    }));

  return {
    ...buildMeta("memory_console_search", storeId, profile, input),
    action: "listed",
    query: query ?? null,
    filters: {
      types: typeFilters,
      limit,
    },
    totalMatches: matches.length,
    results,
  };
}

function runMemoryConsoleTimeline(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "memory_console_timeline",
    request
  );
  const state = getReadonlyProfileState(storeId, profile);
  const limit = normalizeMemoryConsoleLimit(
    request.limit,
    DEFAULT_MEMORY_CONSOLE_LIMIT
  );
  const typeFilters = normalizeMemoryConsoleTypeFilters(
    request,
    "memory_console_timeline"
  );
  const { since, until } = normalizeMemoryConsoleTimestampRange(
    request,
    "memory_console_timeline"
  );
  const rows = buildMemoryConsoleEntityRows(state);
  const matches = rows.filter((row: any) => {
    if (typeFilters.length > 0 && !typeFilters.includes(row.entityType)) {
      return false;
    }
    if (since && row.timestamp.localeCompare(since) < 0) {
      return false;
    }
    if (until && row.timestamp.localeCompare(until) > 0) {
      return false;
    }
    return true;
  });
  const events = matches.slice(0, limit).map((row: any) => ({
    eventType: row.entityType,
    entityType: row.entityType,
    entityId: row.entityId,
    timestamp: row.timestamp,
    summary: row.summary,
    sourceIds: row.sourceIds,
  }));

  return {
    ...buildMeta("memory_console_timeline", storeId, profile, input),
    action: "listed",
    filters: {
      types: typeFilters,
      since,
      until,
      limit,
    },
    totalEvents: matches.length,
    events,
  };
}

function runMemoryConsoleProvenance(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "memory_console_provenance",
    request
  );
  const state = getReadonlyProfileState(storeId, profile);
  const limit = normalizeMemoryConsoleLimit(request.limit, MAX_LIST_ITEMS);
  const refs = normalizeMemoryConsoleEntityRefs(request).slice(0, limit);
  const rows = buildMemoryConsoleEntityRows(state);
  const index = new Map(
    rows.map((row: any) => [`${row.entityType}:${row.entityId}`, row])
  );
  const entities = refs.map((ref: any) => {
    const key = `${ref.entityType}:${ref.entityId}`;
    const row = index.get(key);
    if (!row) {
      return {
        entityType: ref.entityType,
        entityId: ref.entityId,
        found: false,
        timestamp: null,
        summary: null,
        linkedSourceIds: [],
        provenancePointers: [],
      };
    }
    return {
      entityType: row.entityType,
      entityId: row.entityId,
      found: true,
      timestamp: row.timestamp,
      summary: row.summary,
      linkedSourceIds: row.sourceIds,
      provenancePointers: row.provenancePointers,
    };
  });
  const resolvedCount = entities.reduce(
    (count: any, entity: any) => count + (entity.found ? 1 : 0),
    0
  );
  const linkedSourceIds = asSortedUniqueStrings(
    entities.flatMap((entity: any) => entity.linkedSourceIds)
  );

  return {
    ...buildMeta("memory_console_provenance", storeId, profile, input),
    action: "listed",
    filters: {
      limit,
    },
    resolution: {
      requested: refs.length,
      resolved: resolvedCount,
      unresolved: Math.max(refs.length - resolvedCount, 0),
      linkedSourceIdCount: linkedSourceIds.length,
    },
    linkedSourceIds,
    entities,
  };
}

function runMemoryConsolePolicyAudit(request: any) {
  const { storeId, profile, input } = normalizeRequest(
    "memory_console_policy_audit",
    request
  );
  const state = getReadonlyProfileState(storeId, profile);
  const limit = normalizeMemoryConsoleLimit(
    request.limit,
    DEFAULT_MEMORY_CONSOLE_LIMIT
  );
  const { since, until } = normalizeMemoryConsoleTimestampRange(
    request,
    "memory_console_policy_audit"
  );
  const outcomeFilters = normalizeMemoryConsoleStringFilters(
    [request.outcome, request.outcomes],
    "memory_console_policy_audit.outcomes",
    {
      allowedValues: POLICY_OUTCOMES,
      maxLength: 16,
      lowerCase: true,
    }
  );
  const operationFilters = normalizeMemoryConsoleStringFilters(
    [request.operation, request.operations],
    "memory_console_policy_audit.operations",
    {
      maxLength: 64,
      lowerCase: true,
    }
  );
  const reasonCodeFilters = normalizeMemoryConsoleStringFilters(
    [request.reasonCode, request.reasonCodes],
    "memory_console_policy_audit.reasonCodes",
    {
      maxLength: 64,
      lowerCase: true,
    }
  );
  const policyKey = normalizeBoundedString(
    request.policyKey,
    "memory_console_policy_audit.policyKey",
    128
  );
  const policyKeyLower = policyKey ? policyKey.toLowerCase() : null;

  const decisions = sortByTimestampAndId(
    Array.isArray(state?.policyDecisions) ? state.policyDecisions : [],
    "updatedAt",
    "decisionId"
  )
    .reverse()
    .filter((decision: any) => {
      const timestamp = toMemoryConsoleTimestamp(
        decision?.updatedAt ?? decision?.createdAt
      );
      if (since && timestamp.localeCompare(since) < 0) {
        return false;
      }
      if (until && timestamp.localeCompare(until) > 0) {
        return false;
      }
      const outcome =
        normalizeBoundedStringLenient(decision?.outcome, 16)?.toLowerCase() ??
        "review";
      if (outcomeFilters.length > 0 && !outcomeFilters.includes(outcome)) {
        return false;
      }
      const decisionPolicyKey =
        normalizeBoundedStringLenient(
          decision?.policyKey,
          128
        )?.toLowerCase() ?? null;
      if (policyKeyLower && decisionPolicyKey !== policyKeyLower) {
        return false;
      }
      if (!hasMatchingReasonCode(decision?.reasonCodes, reasonCodeFilters)) {
        return false;
      }
      return true;
    });

  const auditTrail = sortByTimestampAndId(
    Array.isArray(state?.policyAuditTrail) ? state.policyAuditTrail : [],
    "timestamp",
    "auditEventId"
  )
    .reverse()
    .filter((entry: any) => {
      const timestamp = toMemoryConsoleTimestamp(entry?.timestamp);
      if (since && timestamp.localeCompare(since) < 0) {
        return false;
      }
      if (until && timestamp.localeCompare(until) > 0) {
        return false;
      }
      const operation =
        normalizeBoundedStringLenient(entry?.operation, 64)?.toLowerCase() ??
        "unknown";
      if (
        operationFilters.length > 0 &&
        !operationFilters.includes(operation)
      ) {
        return false;
      }
      const entryPolicyKey =
        normalizeBoundedStringLenient(
          entry?.details?.policyKey,
          128
        )?.toLowerCase() ?? null;
      if (policyKeyLower && entryPolicyKey !== policyKeyLower) {
        return false;
      }
      if (outcomeFilters.length > 0) {
        const outcome =
          normalizeBoundedStringLenient(entry?.outcome, 16)?.toLowerCase() ??
          "recorded";
        if (!outcomeFilters.includes(outcome)) {
          return false;
        }
      }
      if (!hasMatchingReasonCode(entry?.reasonCodes, reasonCodeFilters)) {
        return false;
      }
      return true;
    });

  const decisionRows = decisions.slice(0, limit).map((decision: any) => ({
    decisionId: decision.decisionId,
    policyKey: decision.policyKey,
    outcome: decision.outcome,
    reasonCodes: asSortedUniqueStrings(decision.reasonCodes),
    provenanceEventIds: asSortedUniqueStrings(decision.provenanceEventIds),
    updatedAt: toMemoryConsoleTimestamp(
      decision.updatedAt ?? decision.createdAt
    ),
  }));
  const auditRows = auditTrail.slice(0, limit).map((entry: any) => ({
    auditEventId: entry.auditEventId,
    operation: entry.operation,
    entityId: entry.entityId ?? null,
    outcome: entry.outcome ?? null,
    reasonCodes: asSortedUniqueStrings(entry.reasonCodes),
    timestamp: toMemoryConsoleTimestamp(entry.timestamp),
    summary: summarizeMemoryConsoleParts(
      [
        `operation=${entry.operation ?? "unknown"}`,
        `outcome=${entry.outcome ?? "recorded"}`,
        `entity=${entry.entityId ?? "none"}`,
      ],
      `operation=${entry.operation ?? "unknown"}`
    ),
  }));

  const decisionOutcomeCounts = {
    allow: 0,
    review: 0,
    deny: 0,
  } as Record<"allow" | "review" | "deny", number>;
  for (const decision of decisions) {
    const outcome = normalizeBoundedStringLenient(
      decision?.outcome,
      16
    )?.toLowerCase();
    if (outcome && hasOwn(decisionOutcomeCounts, outcome)) {
      decisionOutcomeCounts[outcome as keyof typeof decisionOutcomeCounts] += 1;
    }
  }
  const auditOperationCounts: Record<string, number> = {};
  for (const entry of auditTrail) {
    const operation =
      normalizeBoundedStringLenient(entry?.operation, 64)?.toLowerCase() ??
      "unknown";
    auditOperationCounts[operation] =
      toNonNegativeInteger(auditOperationCounts[operation], 0) + 1;
  }
  const reasonCodeCounts: Record<string, number> = {};
  for (const decision of decisions) {
    for (const reasonCode of asSortedUniqueStrings(decision?.reasonCodes)) {
      reasonCodeCounts[reasonCode] =
        toNonNegativeInteger(reasonCodeCounts[reasonCode], 0) + 1;
    }
  }
  for (const entry of auditTrail) {
    for (const reasonCode of asSortedUniqueStrings(entry?.reasonCodes)) {
      reasonCodeCounts[reasonCode] =
        toNonNegativeInteger(reasonCodeCounts[reasonCode], 0) + 1;
    }
  }

  return {
    ...buildMeta("memory_console_policy_audit", storeId, profile, input),
    action: "listed",
    filters: {
      outcomes: outcomeFilters,
      operations: operationFilters,
      reasonCodes: reasonCodeFilters,
      policyKey: policyKey ?? null,
      since,
      until,
      limit,
    },
    totalPolicyDecisions: decisions.length,
    totalAuditTrailEvents: auditTrail.length,
    policyDecisions: decisionRows,
    auditTrail: auditRows,
    summary: {
      deniedDecisions: decisionOutcomeCounts.deny,
      outcomeCounts: stableSortObject(decisionOutcomeCounts),
      operationCounts: stableSortObject(auditOperationCounts),
      reasonCodeCounts: stableSortObject(reasonCodeCounts),
    },
  };
}

function runAudit(request: any) {
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
      {
        name: "events_present",
        status: state.events.length > 0 ? "pass" : "warn",
      },
      {
        name: "rules_present",
        status: state.rules.length > 0 ? "pass" : "warn",
      },
      {
        name: "duplicate_rules",
        status: duplicateStatements.size === 0 ? "pass" : "warn",
      },
    ],
    duplicateRules: [...duplicateStatements.values()],
  };
}

function runExport(request: any) {
  const { storeId, profile, input } = normalizeRequest("export", request);
  const state = getProfileState(storeId, profile);
  const topRules = state.rules.slice(0, 5);
  const topAntiPatterns = state.feedback
    .filter((entry: any) => entry.signal === "harmful")
    .slice(0, 5)
    .map((entry: any) => entry.note || entry.targetRuleId);
  const agentsMdLines = [
    "# UMS Memory Export",
    "",
    `Store: ${storeId}`,
    `Profile: ${profile}`,
    "",
    "## Top Rules",
    ...topRules.map(
      (rule: any) => `- ${rule.statement} (confidence=${rule.confidence})`
    ),
    "",
    "## Anti-pattern Signals",
    ...topAntiPatterns.map((line: any) => `- ${line}`),
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

function runDoctor(request: any) {
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
    incidentEscalations: Array.isArray(state.incidentEscalations)
      ? state.incidentEscalations.length
      : 0,
    manualOverrideControls: Array.isArray(state.manualOverrideControls)
      ? state.manualOverrideControls.length
      : 0,
    curriculumPlanItems: state.curriculumPlanItems.length,
    curriculumRecommendationSnapshots:
      state.curriculumRecommendationSnapshots.length,
    reviewScheduleEntries: state.reviewScheduleEntries.length,
    reviewArchivalRecords:
      state.reviewArchivalTiers?.archivedRecords?.length ?? 0,
    policyDecisions: state.policyDecisions.length,
    policyAuditTrail: state.policyAuditTrail.length,
    weightAdjustmentLedger: Array.isArray(state.weightAdjustmentLedger)
      ? state.weightAdjustmentLedger.length
      : 0,
    shadowCandidates: Array.isArray(state.shadowCandidates)
      ? state.shadowCandidates.length
      : 0,
    replayEvaluations: Array.isArray(state.replayEvaluations)
      ? state.replayEvaluations.length
      : 0,
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

const runners: Record<string, (request: any) => any> = {
  ingest: runIngest,
  context: runContext,
  reflect: runReflect,
  validate: runValidate,
  curate: runCurate,
  shadow_write: runShadowWrite,
  replay_eval: runReplayEval,
  promote: runPromote,
  demote: runDemote,
  addweight: runAddWeight,
  add_weight: runAddWeight,
  "/addweight": runAddWeight,
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
  incident_escalation_signal: runIncidentEscalationSignal,
  incident_escalation_ingest: runIncidentEscalationSignal,
  escalation_signal_ingest: runIncidentEscalationSignal,
  manual_quarantine_override: runManualQuarantineOverride,
  manual_override_control: runManualQuarantineOverride,
  quarantine_override_control: runManualQuarantineOverride,
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
  memory_console_search: runMemoryConsoleSearch,
  memory_search: runMemoryConsoleSearch,
  console_search: runMemoryConsoleSearch,
  memory_console_timeline: runMemoryConsoleTimeline,
  memory_timeline: runMemoryConsoleTimeline,
  console_timeline: runMemoryConsoleTimeline,
  memory_console_provenance: runMemoryConsoleProvenance,
  memory_provenance: runMemoryConsoleProvenance,
  console_provenance: runMemoryConsoleProvenance,
  memory_console_policy_audit: runMemoryConsolePolicyAudit,
  memory_policy_audit: runMemoryConsolePolicyAudit,
  console_policy_audit: runMemoryConsolePolicyAudit,
  memory_console_anomaly_alerts: runMemoryConsoleAnomalyAlerts,
  memory_console_anomalies: runMemoryConsoleAnomalyAlerts,
  memory_anomaly_alerts: runMemoryConsoleAnomalyAlerts,
  console_anomaly_alerts: runMemoryConsoleAnomalyAlerts,
  feedback: runFeedback,
  outcome: runOutcome,
  audit: runAudit,
  export: runExport,
  doctor: runDoctor,
};

export function executeOperation(operation: any, request: any): any {
  const op =
    typeof operation === "string" ? operation.trim().toLowerCase() : "";
  const runner = runners[op];
  if (!runner) {
    const error = new Error(`Unsupported operation: ${operation}`) as Error & {
      code?: string;
    };
    error.code = "UNSUPPORTED_OPERATION";
    throw error;
  }
  return runner(request ?? {});
}

export function listOperations() {
  return [...OPS];
}

function cloneStable(value: any, fallback: any) {
  if (value === undefined) {
    return fallback;
  }
  return JSON.parse(stableStringify(value));
}

function cloneIdentityRefRecord(identityRef: any) {
  return {
    ...identityRef,
    metadata: cloneStable(identityRef?.metadata ?? {}, {}),
  };
}

function cloneLearnerProfileRecord(learnerProfile: any) {
  return {
    ...learnerProfile,
    identityRefs: (learnerProfile?.identityRefs ?? []).map(
      cloneIdentityRefRecord
    ),
    metadata: cloneStable(learnerProfile?.metadata ?? {}, {}),
    evidencePointers: cloneStable(learnerProfile?.evidencePointers ?? [], []),
    policyException: cloneStable(learnerProfile?.policyException ?? null, null),
    sourceSignals: cloneStable(learnerProfile?.sourceSignals ?? [], []),
    providedAttributes: cloneStable(
      learnerProfile?.providedAttributes ?? [],
      []
    ),
    attributeLineage: cloneStable(learnerProfile?.attributeLineage ?? {}, {}),
    attributeTruth: cloneStable(learnerProfile?.attributeTruth ?? {}, {}),
  };
}

function cloneIdentityGraphEdgeRecord(edge: any) {
  return {
    ...edge,
    fromRef: cloneIdentityRefRecord(edge?.fromRef),
    toRef: cloneIdentityRefRecord(edge?.toRef),
    metadata: cloneStable(edge?.metadata ?? {}, {}),
    evidencePointers: cloneStable(edge?.evidencePointers ?? [], []),
    sourceSignals: cloneStable(edge?.sourceSignals ?? [], []),
  };
}

export function snapshotProfile(
  profile: any = INTERNAL_PROFILE_ID,
  storeId: any = DEFAULT_STORE_ID
) {
  const state = getProfileState(
    defaultStoreId(storeId),
    normalizeProfile(profile)
  );
  return {
    events: state.events.map((event: any) => ({ ...event })),
    rules: state.rules.map((rule: any) => ({ ...rule })),
    feedback: state.feedback.map((entry: any) => ({ ...entry })),
    outcomes: state.outcomes.map((entry: any) => ({ ...entry })),
    learnerProfiles: state.learnerProfiles.map(cloneLearnerProfileRecord),
    identityGraphEdges: state.identityGraphEdges.map(
      cloneIdentityGraphEdgeRecord
    ),
    misconceptions: state.misconceptions.map((record: any) => ({
      ...record,
      metadata: { ...record.metadata },
    })),
    curriculumPlanItems: state.curriculumPlanItems.map((item: any) => ({
      ...item,
      metadata: { ...item.metadata },
    })),
    curriculumRecommendationSnapshots:
      state.curriculumRecommendationSnapshots.map((snapshot: any) => ({
        ...snapshot,
        recommendations: cloneStable(snapshot.recommendations ?? [], []),
        metadata: cloneStable(snapshot.metadata ?? {}, {}),
      })),
    reviewScheduleEntries: state.reviewScheduleEntries.map((entry: any) => ({
      ...entry,
      metadata: { ...entry.metadata },
    })),
    painSignals: state.painSignals.map((signal: any) => ({
      ...signal,
      metadata: cloneStable(signal.metadata ?? {}, {}),
    })),
    failureSignals: state.failureSignals.map((signal: any) => ({
      ...signal,
      metadata: cloneStable(signal.metadata ?? {}, {}),
    })),
    incidentEscalations: state.incidentEscalations.map((escalation: any) => ({
      ...escalation,
      metadata: cloneStable(escalation.metadata ?? {}, {}),
    })),
    manualOverrideControls: state.manualOverrideControls.map(
      (control: any) => ({
        ...control,
        metadata: cloneStable(control.metadata ?? {}, {}),
      })
    ),
    schedulerClocks: cloneStable(state.schedulerClocks ?? {}, {}),
    reviewArchivalTiers: cloneStable(state.reviewArchivalTiers ?? {}, {}),
    recallAllowlistPolicy: cloneStable(state.recallAllowlistPolicy ?? {}, {}),
    degradedTutorSessions: cloneStable(state.degradedTutorSessions ?? [], []),
    policyDecisions: state.policyDecisions.map((decision: any) => ({
      ...decision,
      metadata: { ...decision.metadata },
    })),
    policyAuditTrail: cloneStable(state.policyAuditTrail ?? [], []),
    weightAdjustmentLedger: cloneStable(state.weightAdjustmentLedger ?? [], []),
    shadowCandidates: cloneStable(state.shadowCandidates ?? [], []),
    replayEvaluations: cloneStable(state.replayEvaluations ?? [], []),
  };
}

function serializeState(state: any) {
  return {
    events: state.events.map((event: any) => ({ ...event })),
    rules: state.rules.map((rule: any) => ({ ...rule })),
    feedback: state.feedback.map((entry: any) => ({ ...entry })),
    outcomes: state.outcomes.map((entry: any) => ({ ...entry })),
    learnerProfiles: state.learnerProfiles.map(cloneLearnerProfileRecord),
    identityGraphEdges: state.identityGraphEdges.map(
      cloneIdentityGraphEdgeRecord
    ),
    misconceptions: state.misconceptions.map((record: any) => ({
      ...record,
      metadata: { ...record.metadata },
    })),
    curriculumPlanItems: state.curriculumPlanItems.map((item: any) => ({
      ...item,
      metadata: { ...item.metadata },
    })),
    curriculumRecommendationSnapshots:
      state.curriculumRecommendationSnapshots.map((snapshot: any) => ({
        ...snapshot,
        recommendations: cloneStable(snapshot.recommendations ?? [], []),
        metadata: cloneStable(snapshot.metadata ?? {}, {}),
      })),
    reviewScheduleEntries: state.reviewScheduleEntries.map((entry: any) => ({
      ...entry,
      metadata: { ...entry.metadata },
    })),
    painSignals: state.painSignals.map((signal: any) => ({
      ...signal,
      metadata: cloneStable(signal.metadata ?? {}, {}),
    })),
    failureSignals: state.failureSignals.map((signal: any) => ({
      ...signal,
      metadata: cloneStable(signal.metadata ?? {}, {}),
    })),
    incidentEscalations: state.incidentEscalations.map((escalation: any) => ({
      ...escalation,
      metadata: cloneStable(escalation.metadata ?? {}, {}),
    })),
    manualOverrideControls: state.manualOverrideControls.map(
      (control: any) => ({
        ...control,
        metadata: cloneStable(control.metadata ?? {}, {}),
      })
    ),
    schedulerClocks: cloneStable(state.schedulerClocks ?? {}, {}),
    reviewArchivalTiers: cloneStable(state.reviewArchivalTiers ?? {}, {}),
    recallAllowlistPolicy: cloneStable(state.recallAllowlistPolicy ?? {}, {}),
    degradedTutorSessions: cloneStable(state.degradedTutorSessions ?? [], []),
    policyDecisions: state.policyDecisions.map((decision: any) => ({
      ...decision,
      metadata: { ...decision.metadata },
    })),
    policyAuditTrail: cloneStable(state.policyAuditTrail ?? [], []),
    weightAdjustmentLedger: cloneStable(state.weightAdjustmentLedger ?? [], []),
    shadowCandidates: cloneStable(state.shadowCandidates ?? [], []),
    replayEvaluations: cloneStable(state.replayEvaluations ?? [], []),
  };
}

export function exportStoreSnapshot() {
  const storesPayload: Record<string, { profiles: Record<string, unknown> }> =
    {};

  for (const storeId of [...stores.keys()].sort()) {
    const profiles = stores.get(storeId) ?? new Map();
    const profilesPayload: Record<string, unknown> = {};
    for (const profile of [...profiles.keys()].sort()) {
      profilesPayload[profile] = serializeState(profiles.get(profile));
    }
    storesPayload[storeId] = { profiles: profilesPayload };
  }

  return { stores: storesPayload };
}

interface RawSchedulerClocksInput {
  interactionTick?: unknown;
  sleepTick?: unknown;
  fatigueLoad?: unknown;
  sleepThreshold?: unknown;
  consolidationCount?: unknown;
  lastInteractionAt?: unknown;
  lastSleepAt?: unknown;
  lastConsolidatedAt?: unknown;
  updatedAt?: unknown;
}

interface RawReviewArchivalTiersInput {
  activeLimit?: unknown;
  activeReviewIds?: unknown;
  tiers?: {
    warm?: unknown;
    cold?: unknown;
    frozen?: unknown;
  };
  archivedRecords?: unknown;
  updatedAt?: unknown;
}

interface RawRecallAllowlistPolicyInput {
  policyId?: unknown;
  allowedStoreIds?: unknown;
  updatedAt?: unknown;
  metadata?: unknown;
}

interface RawStateInput {
  events?: unknown;
  rules?: unknown;
  feedback?: unknown;
  outcomes?: unknown;
  learnerProfiles?: unknown;
  identityGraphEdges?: unknown;
  misconceptions?: unknown;
  curriculumPlanItems?: unknown;
  curriculumRecommendationSnapshots?: unknown;
  reviewScheduleEntries?: unknown;
  painSignals?: unknown;
  failureSignals?: unknown;
  incidentEscalations?: unknown;
  manualOverrideControls?: unknown;
  degradedTutorSessions?: unknown;
  policyDecisions?: unknown;
  policyAuditTrail?: unknown;
  weightAdjustmentLedger?: unknown;
  shadowCandidates?: unknown;
  replayEvaluations?: unknown;
  schedulerClocks?: RawSchedulerClocksInput;
  reviewArchivalTiers?: RawReviewArchivalTiersInput;
  recallAllowlistPolicy?: RawRecallAllowlistPolicyInput;
}

function normalizeState(rawState: any) {
  const state: RawStateInput =
    rawState && typeof rawState === "object" ? (rawState as RawStateInput) : {};
  const events = Array.isArray(state.events) ? state.events : [];
  const rules = Array.isArray(state.rules) ? state.rules : [];
  const feedback = Array.isArray(state.feedback) ? state.feedback : [];
  const outcomes = Array.isArray(state.outcomes) ? state.outcomes : [];
  const learnerProfiles = Array.isArray(state.learnerProfiles)
    ? state.learnerProfiles
    : [];
  const identityGraphEdges = Array.isArray(state.identityGraphEdges)
    ? state.identityGraphEdges
    : [];
  const misconceptions = Array.isArray(state.misconceptions)
    ? state.misconceptions
    : [];
  const curriculumPlanItems = Array.isArray(state.curriculumPlanItems)
    ? state.curriculumPlanItems
    : [];
  const curriculumRecommendationSnapshots = Array.isArray(
    state.curriculumRecommendationSnapshots
  )
    ? state.curriculumRecommendationSnapshots
    : [];
  const reviewScheduleEntries = Array.isArray(state.reviewScheduleEntries)
    ? state.reviewScheduleEntries
    : [];
  const painSignals = Array.isArray(state.painSignals) ? state.painSignals : [];
  const failureSignals = Array.isArray(state.failureSignals)
    ? state.failureSignals
    : [];
  const incidentEscalations = Array.isArray(state.incidentEscalations)
    ? state.incidentEscalations
    : [];
  const manualOverrideControls = Array.isArray(state.manualOverrideControls)
    ? state.manualOverrideControls
    : [];
  const degradedTutorSessions = Array.isArray(state.degradedTutorSessions)
    ? state.degradedTutorSessions
    : [];
  const policyDecisions = Array.isArray(state.policyDecisions)
    ? state.policyDecisions
    : [];
  const policyAuditTrail = Array.isArray(state.policyAuditTrail)
    ? state.policyAuditTrail
    : [];
  const weightAdjustmentLedger = Array.isArray(state.weightAdjustmentLedger)
    ? state.weightAdjustmentLedger
    : [];
  const shadowCandidates = Array.isArray(state.shadowCandidates)
    ? state.shadowCandidates
    : [];
  const replayEvaluations = Array.isArray(state.replayEvaluations)
    ? state.replayEvaluations
    : [];
  const eventDigests = new Set(
    events
      .map((event: any) =>
        event && typeof event === "object" ? event.digest : null
      )
      .filter((digest: any) => typeof digest === "string" && digest)
  );

  return {
    events: events.map((event: any) => ({ ...event })),
    eventDigests,
    rules: rules.map((rule: any) => ({ ...rule })),
    feedback: sortByTimestampAndId(
      feedback.map((entry: any) => ({
        ...entry,
        feedbackId:
          normalizeBoundedStringLenient(entry?.feedbackId, 64) ??
          makeId("fdbk", hash(stableStringify(entry))),
        targetRuleId:
          normalizeBoundedStringLenient(entry?.targetRuleId, 64) ?? "",
        targetCandidateId: normalizeBoundedStringLenient(
          entry?.targetCandidateId,
          64
        ),
        signal: entry?.signal === "harmful" ? "harmful" : "helpful",
        note: normalizeBoundedStringLenient(entry?.note, 512) ?? "",
        actor:
          normalizeBoundedStringLenient(entry?.actor, 128) ??
          "human_unspecified",
        recordedAt: normalizeIsoTimestampOrFallback(
          entry?.recordedAt ?? entry?.timestamp,
          DEFAULT_VERSION_TIMESTAMP
        ),
        metadata: isPlainObject(entry?.metadata)
          ? stableSortObject(entry.metadata)
          : {},
      })),
      "recordedAt",
      "feedbackId"
    ),
    outcomes: sortByTimestampAndId(
      outcomes.map((entry: any) => ({
        ...entry,
        outcomeId:
          normalizeBoundedStringLenient(entry?.outcomeId, 64) ??
          makeId("out", hash(stableStringify(entry))),
        task:
          normalizeBoundedStringLenient(entry?.task, 128) ?? "unspecified-task",
        outcome: entry?.outcome === "failure" ? "failure" : "success",
        usedRuleIds: normalizeBoundedStringArrayLenient(entry?.usedRuleIds),
        actor:
          normalizeBoundedStringLenient(entry?.actor, 128) ??
          "human_unspecified",
        recordedAt: normalizeIsoTimestampOrFallback(
          entry?.recordedAt ?? entry?.timestamp,
          DEFAULT_VERSION_TIMESTAMP
        ),
        metadata: isPlainObject(entry?.metadata)
          ? stableSortObject(entry.metadata)
          : {},
      })),
      "recordedAt",
      "outcomeId"
    ),
    learnerProfiles: learnerProfiles.map((learnerProfile: any) => ({
      ...learnerProfile,
      identityRefs: Array.isArray(learnerProfile?.identityRefs)
        ? learnerProfile.identityRefs.map((identityRef: any) => ({
            ...identityRef,
            metadata: isPlainObject(identityRef?.metadata)
              ? { ...identityRef.metadata }
              : {},
          }))
        : [],
      metadata: isPlainObject(learnerProfile?.metadata)
        ? { ...learnerProfile.metadata }
        : {},
      evidencePointers: normalizeEvidencePointers(
        learnerProfile?.evidencePointers
      ),
      policyException: normalizePolicyException(
        learnerProfile?.policyException ?? null
      ),
      sourceSignals: mergeSourceSignals([], learnerProfile?.sourceSignals),
      providedAttributes: normalizeBoundedStringArray(
        learnerProfile?.providedAttributes,
        "providedAttributes"
      ),
      createdAt: normalizeIsoTimestampOrFallback(
        learnerProfile?.createdAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
      updatedAt: normalizeIsoTimestampOrFallback(
        learnerProfile?.updatedAt,
        normalizeIsoTimestampOrFallback(
          learnerProfile?.createdAt,
          DEFAULT_VERSION_TIMESTAMP
        )
      ),
      attributeLineage: isPlainObject(learnerProfile?.attributeLineage)
        ? stableSortObject(learnerProfile.attributeLineage)
        : {},
      attributeTruth: isPlainObject(learnerProfile?.attributeTruth)
        ? stableSortObject(learnerProfile.attributeTruth)
        : {},
    })),
    identityGraphEdges: identityGraphEdges.map((edge: any) => ({
      ...edge,
      fromRef: isPlainObject(edge?.fromRef)
        ? {
            ...edge.fromRef,
            metadata: isPlainObject(edge.fromRef.metadata)
              ? { ...edge.fromRef.metadata }
              : {},
          }
        : normalizeIdentityRef(null),
      toRef: isPlainObject(edge?.toRef)
        ? {
            ...edge.toRef,
            metadata: isPlainObject(edge.toRef.metadata)
              ? { ...edge.toRef.metadata }
              : {},
          }
        : normalizeIdentityRef(null),
      evidencePointers: normalizeEvidencePointers(edge?.evidencePointers),
      evidenceEventIds: normalizeBoundedStringArray(
        edge?.evidenceEventIds ?? edge?.evidenceEpisodeIds,
        "identityGraphEdges.evidenceEventIds"
      ),
      sourceSignals: mergeSourceSignals([], edge?.sourceSignals),
      metadata: isPlainObject(edge?.metadata) ? { ...edge.metadata } : {},
      createdAt: normalizeIsoTimestampOrFallback(
        edge?.createdAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
      updatedAt: normalizeIsoTimestampOrFallback(
        edge?.updatedAt,
        normalizeIsoTimestampOrFallback(
          edge?.createdAt,
          DEFAULT_VERSION_TIMESTAMP
        )
      ),
    })),
    misconceptions: misconceptions.map((record: any) => ({
      ...record,
      metadata: isPlainObject(record?.metadata) ? { ...record.metadata } : {},
    })),
    curriculumPlanItems: curriculumPlanItems.map((item: any) => ({
      ...item,
      metadata: isPlainObject(item?.metadata) ? { ...item.metadata } : {},
    })),
    curriculumRecommendationSnapshots: curriculumRecommendationSnapshots.map(
      (snapshot: any) => ({
        ...snapshot,
        recommendationSetId:
          normalizeBoundedString(
            snapshot?.recommendationSetId,
            "curriculumRecommendationSnapshots.recommendationSetId",
            64
          ) ?? makeId("recs", hash(stableStringify(snapshot))),
        generatedAt: normalizeIsoTimestampOrFallback(
          snapshot?.generatedAt,
          DEFAULT_VERSION_TIMESTAMP
        ),
        requestDigest: normalizeBoundedString(
          snapshot?.requestDigest,
          "curriculumRecommendationSnapshots.requestDigest",
          128
        ),
        recommendationIds: normalizeBoundedStringArray(
          snapshot?.recommendationIds,
          "curriculumRecommendationSnapshots.recommendationIds"
        ),
        recommendations: Array.isArray(snapshot?.recommendations)
          ? cloneStable(snapshot.recommendations, [])
          : [],
        metadata: isPlainObject(snapshot?.metadata)
          ? { ...snapshot.metadata }
          : {},
      })
    ),
    reviewScheduleEntries: reviewScheduleEntries.map((entry: any) => ({
      ...entry,
      metadata: isPlainObject(entry?.metadata) ? { ...entry.metadata } : {},
    })),
    painSignals: sortByTimestampAndId(
      painSignals.map((signal: any) => ({
        ...signal,
        painSignalId:
          normalizeBoundedString(
            signal?.painSignalId,
            "painSignals.painSignalId",
            64
          ) ?? makeId("pain", hash(stableStringify(signal))),
        recordedAt: normalizeIsoTimestampOrFallback(
          signal?.recordedAt,
          DEFAULT_VERSION_TIMESTAMP
        ),
        metadata: isPlainObject(signal?.metadata) ? { ...signal.metadata } : {},
      })),
      "recordedAt",
      "painSignalId"
    ),
    failureSignals: sortByTimestampAndId(
      failureSignals.map((signal: any) => ({
        ...signal,
        failureSignalId:
          normalizeBoundedString(
            signal?.failureSignalId,
            "failureSignals.failureSignalId",
            64
          ) ?? makeId("fail", hash(stableStringify(signal))),
        recordedAt: normalizeIsoTimestampOrFallback(
          signal?.recordedAt,
          DEFAULT_VERSION_TIMESTAMP
        ),
        metadata: isPlainObject(signal?.metadata) ? { ...signal.metadata } : {},
      })),
      "recordedAt",
      "failureSignalId"
    ),
    incidentEscalations: sortByTimestampAndId(
      incidentEscalations.map((escalation: any) => ({
        ...escalation,
        escalationSignalId:
          normalizeBoundedString(
            escalation?.escalationSignalId,
            "incidentEscalations.escalationSignalId",
            64
          ) ?? makeId("esc", hash(stableStringify(escalation))),
        recordedAt: normalizeIsoTimestampOrFallback(
          escalation?.recordedAt,
          DEFAULT_VERSION_TIMESTAMP
        ),
        reasonCodes: normalizeBoundedStringArrayLenient(
          escalation?.reasonCodes
        ),
        targetCandidateIds: normalizeBoundedStringArrayLenient(
          escalation?.targetCandidateIds
        ),
        targetRuleIds: normalizeBoundedStringArrayLenient(
          escalation?.targetRuleIds
        ),
        evidenceEventIds: normalizeBoundedStringArrayLenient(
          escalation?.evidenceEventIds
        ),
        sourceEventIds: normalizeBoundedStringArrayLenient(
          escalation?.sourceEventIds
        ),
        metadata: isPlainObject(escalation?.metadata)
          ? { ...escalation.metadata }
          : {},
      })),
      "recordedAt",
      "escalationSignalId"
    ),
    manualOverrideControls: sortByTimestampAndId(
      manualOverrideControls.map((control: any) => {
        const overrideControlId =
          normalizeBoundedString(
            control?.overrideControlId,
            "manualOverrideControls.overrideControlId",
            64
          ) ?? makeId("movr", hash(stableStringify(control)));
        const overrideActionRaw = normalizeBoundedStringLenient(
          control?.overrideAction,
          32
        );
        const overrideAction =
          overrideActionRaw !== null &&
          MANUAL_OVERRIDE_ACTIONS.has(overrideActionRaw)
            ? overrideActionRaw
            : "suppress";
        const actor =
          normalizeBoundedStringLenient(control?.actor, 128) ??
          "human_unspecified";
        const reason = normalizeBoundedStringLenient(control?.reason, 512);
        const reasonCodes = normalizeBoundedStringArrayLenient(
          control?.reasonCodes
        );
        const targetCandidateIds = normalizeBoundedStringArrayLenient(
          control?.targetCandidateIds
        );
        const targetRuleIds = normalizeBoundedStringArrayLenient(
          control?.targetRuleIds
        );
        const evidenceEventIds = normalizeBoundedStringArrayLenient(
          control?.evidenceEventIds
        );
        const sourceEventIds = normalizeBoundedStringArrayLenient(
          control?.sourceEventIds
        );
        const metadata = isPlainObject(control?.metadata)
          ? { ...control.metadata }
          : {};
        const recordedAt = normalizeIsoTimestampOrFallback(
          control?.recordedAt,
          DEFAULT_VERSION_TIMESTAMP
        );
        const idempotencyDigest =
          normalizeBoundedString(
            control?.idempotencyDigest,
            "manualOverrideControls.idempotencyDigest",
            128
          ) ??
          hash(
            stableStringify({
              overrideControlId,
              overrideAction,
              actor,
              reason,
              reasonCodes,
              targetCandidateIds,
              targetRuleIds,
              evidenceEventIds,
              sourceEventIds,
              recordedAt,
            })
          );
        return {
          ...control,
          overrideControlId,
          idempotencyDigest,
          overrideAction,
          actor,
          reason,
          reasonCodes,
          targetCandidateIds,
          targetRuleIds,
          evidenceEventIds,
          sourceEventIds,
          metadata,
          recordedAt,
        };
      }),
      "recordedAt",
      "overrideControlId"
    ),
    shadowCandidates: sortByTimestampAndId(
      shadowCandidates.map((candidate: any) => {
        const candidateId =
          normalizeBoundedString(
            candidate?.candidateId,
            "shadowCandidates.candidateId",
            64
          ) ?? makeId("cand", hash(stableStringify(candidate)));
        const createdAt = normalizeIsoTimestampOrFallback(
          candidate?.createdAt,
          normalizeIsoTimestampOrFallback(
            candidate?.updatedAt,
            DEFAULT_VERSION_TIMESTAMP
          )
        );
        const updatedAt = normalizeIsoTimestampOrFallback(
          candidate?.updatedAt,
          createdAt
        );
        return {
          ...candidate,
          candidateId,
          confidence: clamp01(candidate?.confidence, 0.5),
          createdAt,
          updatedAt,
          expiresAt: normalizeIsoTimestampOrFallback(
            candidate?.expiresAt,
            addDaysToIso(createdAt, 30)
          ),
          lastTemporalDecayAt: normalizeIsoTimestampOrFallback(
            candidate?.lastTemporalDecayAt,
            normalizeIsoTimestampOrFallback(candidate?.updatedAt, createdAt)
          ),
          temporalDecayTickCount: toNonNegativeInteger(
            candidate?.temporalDecayTickCount,
            0
          ),
          temporalDecayDaysAccumulated: toNonNegativeInteger(
            candidate?.temporalDecayDaysAccumulated,
            0
          ),
          latestDemotionReasonCodes: normalizeBoundedStringArrayLenient(
            candidate?.latestDemotionReasonCodes
          ),
          negativeNetValueStreak: toNonNegativeInteger(
            candidate?.negativeNetValueStreak,
            0
          ),
          metadata: isPlainObject(candidate?.metadata)
            ? { ...candidate.metadata }
            : {},
        };
      }),
      "updatedAt",
      "candidateId"
    ),
    replayEvaluations: sortByTimestampAndId(
      replayEvaluations.map((evaluation: any) => ({
        ...evaluation,
        replayEvalId:
          normalizeBoundedString(
            evaluation?.replayEvalId,
            "replayEvaluations.replayEvalId",
            64
          ) ?? makeId("reval", hash(stableStringify(evaluation))),
        evaluatedAt: normalizeIsoTimestampOrFallback(
          evaluation?.evaluatedAt,
          DEFAULT_VERSION_TIMESTAMP
        ),
        metrics: isPlainObject(evaluation?.metrics)
          ? stableSortObject(evaluation.metrics)
          : {},
        canaryMetrics: isPlainObject(evaluation?.canaryMetrics)
          ? stableSortObject(evaluation.canaryMetrics)
          : {},
        scoreBreakdown: isPlainObject(evaluation?.scoreBreakdown)
          ? stableSortObject(evaluation.scoreBreakdown)
          : {},
        safetyDeltas: isPlainObject(evaluation?.safetyDeltas)
          ? stableSortObject(evaluation.safetyDeltas)
          : {},
        metadata: isPlainObject(evaluation?.metadata)
          ? { ...evaluation.metadata }
          : {},
      })),
      "evaluatedAt",
      "replayEvalId"
    ),
    schedulerClocks: {
      interactionTick: toNonNegativeInteger(
        state.schedulerClocks?.interactionTick,
        0
      ),
      sleepTick: toNonNegativeInteger(state.schedulerClocks?.sleepTick, 0),
      fatigueLoad: toNonNegativeInteger(state.schedulerClocks?.fatigueLoad, 0),
      sleepThreshold: toPositiveInteger(
        state.schedulerClocks?.sleepThreshold,
        DEFAULT_SLEEP_THRESHOLD
      ),
      consolidationCount: toNonNegativeInteger(
        state.schedulerClocks?.consolidationCount,
        0
      ),
      lastInteractionAt: normalizeIsoTimestampOrFallback(
        state.schedulerClocks?.lastInteractionAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
      lastSleepAt: normalizeIsoTimestampOrFallback(
        state.schedulerClocks?.lastSleepAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
      lastConsolidatedAt: normalizeIsoTimestampOrFallback(
        state.schedulerClocks?.lastConsolidatedAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
      updatedAt: normalizeIsoTimestampOrFallback(
        state.schedulerClocks?.updatedAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
    },
    reviewArchivalTiers: {
      activeLimit: Math.min(
        Math.max(
          toPositiveInteger(
            state.reviewArchivalTiers?.activeLimit,
            DEFAULT_ACTIVE_REVIEW_SET_LIMIT
          ),
          1
        ),
        MAX_ACTIVE_REVIEW_SET_LIMIT
      ),
      activeReviewIds: normalizeBoundedStringArray(
        state.reviewArchivalTiers?.activeReviewIds,
        "reviewArchivalTiers.activeReviewIds"
      ),
      tiers: {
        warm: normalizeBoundedStringArray(
          state.reviewArchivalTiers?.tiers?.warm,
          "reviewArchivalTiers.tiers.warm"
        ),
        cold: normalizeBoundedStringArray(
          state.reviewArchivalTiers?.tiers?.cold,
          "reviewArchivalTiers.tiers.cold"
        ),
        frozen: normalizeBoundedStringArray(
          state.reviewArchivalTiers?.tiers?.frozen,
          "reviewArchivalTiers.tiers.frozen"
        ),
      },
      archivedRecords: Array.isArray(state.reviewArchivalTiers?.archivedRecords)
        ? sortByTimestampAndId(
            state.reviewArchivalTiers.archivedRecords.map((record: any) => ({
              ...record,
              archiveRecordId:
                normalizeBoundedString(
                  record?.archiveRecordId,
                  "reviewArchivalTiers.archiveRecordId",
                  64
                ) ?? makeId("arc", hash(stableStringify(record))),
              archivedAt: normalizeIsoTimestampOrFallback(
                record?.archivedAt,
                DEFAULT_VERSION_TIMESTAMP
              ),
              metadata: isPlainObject(record?.metadata)
                ? { ...record.metadata }
                : {},
            })),
            "archivedAt",
            "archiveRecordId"
          )
        : [],
      updatedAt: normalizeIsoTimestampOrFallback(
        state.reviewArchivalTiers?.updatedAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
    },
    recallAllowlistPolicy: {
      policyId:
        normalizeBoundedString(
          state.recallAllowlistPolicy?.policyId,
          "recallAllowlistPolicy.policyId",
          64
        ) ??
        makeId(
          "allow",
          hash(stableStringify(state.recallAllowlistPolicy ?? {}))
        ),
      allowedStoreIds: normalizeBoundedStringArray(
        state.recallAllowlistPolicy?.allowedStoreIds,
        "recallAllowlistPolicy.allowedStoreIds"
      ),
      updatedAt: normalizeIsoTimestampOrFallback(
        state.recallAllowlistPolicy?.updatedAt,
        DEFAULT_VERSION_TIMESTAMP
      ),
      metadata: isPlainObject(state.recallAllowlistPolicy?.metadata)
        ? {
            ...(state.recallAllowlistPolicy?.metadata as Record<
              string,
              unknown
            >),
          }
        : {},
    },
    degradedTutorSessions: sortByTimestampAndId(
      degradedTutorSessions.map((session: any) => ({
        ...session,
        sessionId:
          normalizeBoundedString(
            session?.sessionId,
            "degradedTutorSessions.sessionId",
            64
          ) ?? makeId("tutor", hash(stableStringify(session))),
        timestamp: normalizeIsoTimestampOrFallback(
          session?.timestamp,
          DEFAULT_VERSION_TIMESTAMP
        ),
      })),
      "timestamp",
      "sessionId"
    ),
    policyDecisions: policyDecisions.map((decision: any) => ({
      ...decision,
      metadata: isPlainObject(decision?.metadata)
        ? { ...decision.metadata }
        : {},
    })),
    policyAuditTrail: sortByTimestampAndId(
      policyAuditTrail.map((entry: any) => ({
        ...entry,
        auditEventId:
          normalizeBoundedString(
            entry?.auditEventId,
            "policyAuditTrail.auditEventId",
            64
          ) ?? makeId("audit", hash(stableStringify(entry))),
        timestamp: normalizeIsoTimestampOrFallback(
          entry?.timestamp,
          DEFAULT_VERSION_TIMESTAMP
        ),
        details: isPlainObject(entry?.details) ? { ...entry.details } : {},
      })),
      "timestamp",
      "auditEventId"
    ),
    weightAdjustmentLedger: sortByTimestampAndId(
      weightAdjustmentLedger.map((entry: any) => {
        const adjustmentId =
          normalizeBoundedString(
            entry?.adjustmentId,
            "weightAdjustmentLedger.adjustmentId",
            64
          ) ?? makeId("wadj", hash(stableStringify(entry)));
        const candidateId = normalizeBoundedString(
          entry?.candidateId,
          "weightAdjustmentLedger.candidateId",
          64
        );
        const auditEventId = normalizeBoundedString(
          entry?.auditEventId,
          "weightAdjustmentLedger.auditEventId",
          64
        );
        const timestamp = normalizeIsoTimestampOrFallback(
          entry?.timestamp,
          DEFAULT_VERSION_TIMESTAMP
        );
        const idempotencyDigest =
          normalizeBoundedString(
            entry?.idempotencyDigest,
            "weightAdjustmentLedger.idempotencyDigest",
            128
          ) ??
          hash(
            stableStringify({
              adjustmentId,
              candidateId,
              auditEventId,
              timestamp,
            })
          );
        return {
          ...entry,
          adjustmentId,
          idempotencyDigest,
          candidateId,
          auditEventId,
          timestamp,
        };
      }),
      "timestamp",
      "adjustmentId"
    ).slice(-MAX_WEIGHT_ADJUSTMENT_LEDGER_EVENTS),
  };
}

function importProfiles(storeId: any, profiles: any) {
  const normalizedStore = defaultStoreId(storeId);
  const profileMap = getStoreProfiles(normalizedStore);
  const source: Record<string, unknown> =
    profiles && typeof profiles === "object"
      ? (profiles as Record<string, unknown>)
      : {};
  let fallbackDefaultState: ReturnType<typeof normalizeState> | null = null;

  for (const profile of Object.keys(source).sort()) {
    const normalizedProfile =
      typeof profile === "string" && profile.trim().length > 0
        ? profile.trim()
        : defaultProfile();
    const normalizedState = normalizeState(source[profile]);
    profileMap.set(normalizedProfile, normalizedState);
    if (normalizedProfile !== defaultProfile()) {
      fallbackDefaultState = normalizedState;
    }
  }

  if (!profileMap.has(defaultProfile()) && fallbackDefaultState !== null) {
    profileMap.set(defaultProfile(), fallbackDefaultState);
  }
}

export function importStoreSnapshot(snapshot: any) {
  stores.clear();
  if (!snapshot || typeof snapshot !== "object") {
    return;
  }

  if (
    snapshot.stores &&
    typeof snapshot.stores === "object" &&
    !Array.isArray(snapshot.stores)
  ) {
    for (const storeId of Object.keys(snapshot.stores).sort()) {
      const storeEntry = snapshot.stores[storeId];
      const profiles =
        storeEntry &&
        typeof storeEntry === "object" &&
        storeEntry.profiles &&
        typeof storeEntry.profiles === "object"
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

function normalizeConfiguredPolicyPackPlugin(plugin: any) {
  if (typeof plugin === "function") {
    return {
      name: normalizePolicyPackPluginName(plugin.name),
      evaluatePolicyDecisionUpdate: plugin,
    };
  }
  if (isPlainObject(plugin)) {
    const evaluatePolicyDecisionUpdate =
      typeof plugin.evaluatePolicyDecisionUpdate === "function"
        ? plugin.evaluatePolicyDecisionUpdate
        : typeof plugin.evaluateDecisionUpdate === "function"
          ? plugin.evaluateDecisionUpdate
          : null;
    if (evaluatePolicyDecisionUpdate === null) {
      throw new Error(
        "policy pack plugin object must expose evaluatePolicyDecisionUpdate(request) or evaluateDecisionUpdate(request)."
      );
    }
    return {
      name: normalizePolicyPackPluginName(plugin.name),
      evaluatePolicyDecisionUpdate,
    };
  }
  throw new Error(
    "policy pack plugin must be a function or object with evaluatePolicyDecisionUpdate(request) or evaluateDecisionUpdate(request)."
  );
}

export function setPolicyPackPlugin(plugin: any) {
  policyPackPlugin = normalizeConfiguredPolicyPackPlugin(plugin);
}

export function resetPolicyPackPlugin() {
  policyPackPlugin = createNoopPolicyPackPlugin();
}

export function resetStore() {
  stores.clear();
  resetPolicyPackPlugin();
}

export function findRuleByDigestPrefix(
  profile: any,
  digestPrefix: any,
  storeId: any = DEFAULT_STORE_ID
) {
  const state = getProfileState(
    defaultStoreId(storeId),
    normalizeProfile(profile)
  );
  return findByDigestPrefix(state.rules, digestPrefix, "ruleId");
}
