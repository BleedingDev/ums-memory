import {
  EvidenceRequiredError,
  IdentityInvariantError,
  IsolationViolationError,
  ValidationError,
} from "./errors.js";
import {
  asSortedUniqueStrings,
  clamp,
  deepFreeze,
  deterministicId,
  isPlainObject,
  toIsoTimestamp,
} from "./utils.js";

export const MemoryLayer = Object.freeze({
  EPISODIC: "episodic",
  WORKING: "working",
  PROCEDURAL: "procedural",
});

export const WorkingMemoryKind = Object.freeze({
  DIARY: "diary",
  DIGEST: "digest",
});

export const ProceduralEntryKind = Object.freeze({
  RULE: "rule",
  ANTI_PATTERN: "anti_pattern",
});

export const ProceduralEntryStatus = Object.freeze({
  ACTIVE: "active",
  TOMBSTONED: "tombstoned",
});

export const LearnerProfileStatus = Object.freeze({
  ACTIVE: "active",
  ARCHIVED: "archived",
});

export const IdentityGraphRelationKind = Object.freeze({
  ALIAS_OF: "alias_of",
  EVIDENCE_OF: "evidence_of",
  MISCONCEPTION_OF: "misconception_of",
  GOAL_OF: "goal_of",
  INTEREST_OF: "interest_of",
});

export const MisconceptionStatus = Object.freeze({
  ACTIVE: "active",
  RESOLVED: "resolved",
  SUPPRESSED: "suppressed",
});

export const CurriculumPlanStatus = Object.freeze({
  PROPOSED: "proposed",
  COMMITTED: "committed",
  COMPLETED: "completed",
  BLOCKED: "blocked",
});

export const ReviewScheduleStatus = Object.freeze({
  SCHEDULED: "scheduled",
  DUE: "due",
  COMPLETED: "completed",
  SUSPENDED: "suspended",
});

export const PersonalizationPolicyOutcome = Object.freeze({
  ALLOW: "allow",
  DENY: "deny",
  REVIEW: "review",
});

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${fieldName} must be a non-empty string`, {
      field: fieldName,
      value,
    });
  }
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new ValidationError("metadata must be an object", { value });
  }
  return value;
}

function normalizeIdentityRef(value, fieldName) {
  if (!isPlainObject(value)) {
    throw new ValidationError(`${fieldName} must be an object`, {
      field: fieldName,
      value,
    });
  }

  assertNonEmptyString(value.namespace, `${fieldName}.namespace`);
  assertNonEmptyString(value.value, `${fieldName}.value`);

  return {
    namespace: value.namespace.trim(),
    value: value.value.trim(),
    verified: Boolean(value.verified),
    isPrimary: Boolean(value.isPrimary),
    lastSeenAt:
      value.lastSeenAt === undefined || value.lastSeenAt === null || value.lastSeenAt === ""
        ? null
        : toIsoTimestamp(value.lastSeenAt),
    metadata: normalizeMetadata(value.metadata),
  };
}

function normalizeIdentityRefs(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const deduped = new Map();
  for (const rawRef of values) {
    const normalized = normalizeIdentityRef(rawRef, "identityRefs[]");
    const key = `${normalized.namespace}:${normalized.value}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, normalized);
      continue;
    }

    deduped.set(key, {
      ...existing,
      verified: existing.verified || normalized.verified,
      isPrimary: existing.isPrimary || normalized.isPrimary,
      lastSeenAt:
        existing.lastSeenAt && normalized.lastSeenAt
          ? existing.lastSeenAt > normalized.lastSeenAt
            ? existing.lastSeenAt
            : normalized.lastSeenAt
          : existing.lastSeenAt ?? normalized.lastSeenAt ?? null,
      metadata: {
        ...existing.metadata,
        ...normalized.metadata,
      },
    });
  }

  const identityRefs = Array.from(deduped.values()).sort((left, right) => {
    const namespaceDiff = left.namespace.localeCompare(right.namespace);
    if (namespaceDiff !== 0) {
      return namespaceDiff;
    }
    return left.value.localeCompare(right.value);
  });

  if (identityRefs.length > 0 && !identityRefs.some((ref) => ref.isPrimary)) {
    identityRefs[0] = {
      ...identityRefs[0],
      isPrimary: true,
    };
  }

  return identityRefs;
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

export function createEpisode(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("episode input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  const type = typeof input.type === "string" && input.type.trim() ? input.type.trim() : "event";
  const source =
    typeof input.source === "string" && input.source.trim() ? input.source.trim() : "unknown";
  const content = typeof input.content === "string" ? input.content : "";
  const createdAt = toIsoTimestamp(input.createdAt);
  const payload = input.payload === undefined ? {} : input.payload;
  const metadata = normalizeMetadata(input.metadata);
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("ep", {
          spaceId: input.spaceId,
          type,
          source,
          content,
          createdAt,
          payload,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    layer: MemoryLayer.EPISODIC,
    type,
    source,
    content,
    payload,
    metadata,
    createdAt,
  });
}

export function createWorkingMemoryEntry(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("working memory input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.content, "content");
  const kind =
    input.kind === WorkingMemoryKind.DIGEST ? WorkingMemoryKind.DIGEST : WorkingMemoryKind.DIARY;
  const evidenceEpisodeIds = asSortedUniqueStrings(input.evidenceEpisodeIds);
  const createdAt = toIsoTimestamp(input.createdAt);
  const metadata = normalizeMetadata(input.metadata);
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("wm", {
          spaceId: input.spaceId,
          kind,
          evidenceEpisodeIds,
          createdAt,
          content: input.content,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    layer: MemoryLayer.WORKING,
    kind,
    content: input.content.trim(),
    evidenceEpisodeIds,
    metadata,
    createdAt,
  });
}

export function createProceduralRule(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("procedural rule input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.statement, "statement");

  const evidenceEpisodeIds = asSortedUniqueStrings(input.evidenceEpisodeIds);
  if (evidenceEpisodeIds.length === 0) {
    throw new EvidenceRequiredError("procedural rule requires at least one evidence episode", {
      statement: input.statement,
    });
  }

  const createdAt = toIsoTimestamp(input.createdAt);
  const updatedAt = toIsoTimestamp(input.updatedAt ?? createdAt);
  const lastValidatedAt = toIsoTimestamp(input.lastValidatedAt ?? updatedAt);
  const confidence = clamp(Number(input.confidence ?? 0.5), 0, 1);
  const status =
    input.status === ProceduralEntryStatus.TOMBSTONED
      ? ProceduralEntryStatus.TOMBSTONED
      : ProceduralEntryStatus.ACTIVE;
  const tags = asSortedUniqueStrings(input.tags);
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("rule", {
          spaceId: input.spaceId,
          statement: input.statement,
          evidenceEpisodeIds,
          createdAt,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    layer: MemoryLayer.PROCEDURAL,
    kind: ProceduralEntryKind.RULE,
    status,
    statement: input.statement.trim(),
    confidence,
    tags,
    evidenceEpisodeIds,
    supersedesRuleId:
      typeof input.supersedesRuleId === "string" && input.supersedesRuleId.trim()
        ? input.supersedesRuleId.trim()
        : null,
    supersededByRuleId:
      typeof input.supersededByRuleId === "string" && input.supersededByRuleId.trim()
        ? input.supersededByRuleId.trim()
        : null,
    metadata: normalizeMetadata(input.metadata),
    createdAt,
    updatedAt,
    lastValidatedAt,
  });
}

export function createAntiPattern(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("anti-pattern input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.statement, "statement");

  const evidenceEpisodeIds = asSortedUniqueStrings(input.evidenceEpisodeIds);
  if (evidenceEpisodeIds.length === 0) {
    throw new EvidenceRequiredError("anti-pattern requires at least one evidence episode", {
      statement: input.statement,
    });
  }

  const createdAt = toIsoTimestamp(input.createdAt);
  const confidence = clamp(Number(input.confidence ?? 0.5), 0, 1);
  const tags = asSortedUniqueStrings(input.tags);
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("anti", {
          spaceId: input.spaceId,
          statement: input.statement,
          evidenceEpisodeIds,
          createdAt,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    layer: MemoryLayer.PROCEDURAL,
    kind: ProceduralEntryKind.ANTI_PATTERN,
    statement: input.statement.trim(),
    confidence,
    tags,
    evidenceEpisodeIds,
    sourceRuleId:
      typeof input.sourceRuleId === "string" && input.sourceRuleId.trim()
        ? input.sourceRuleId.trim()
        : null,
    metadata: normalizeMetadata(input.metadata),
    createdAt,
  });
}

export function createLearnerProfile(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("learner profile input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.learnerId, "learnerId");

  const identityRefs = normalizeIdentityRefs(input.identityRefs);
  if (identityRefs.length === 0) {
    throw new IdentityInvariantError("learner profile requires at least one identity reference", {
      learnerId: input.learnerId,
    });
  }

  const goals = asSortedUniqueStrings(input.goals);
  const interestTags = asSortedUniqueStrings(input.interestTags);
  const misconceptionIds = asSortedUniqueStrings(input.misconceptionIds);
  const createdAt = toIsoTimestamp(input.createdAt);
  const updatedAt = toIsoTimestamp(input.updatedAt ?? createdAt);
  if (updatedAt < createdAt) {
    throw new IdentityInvariantError("learner profile updatedAt cannot precede createdAt", {
      createdAt,
      updatedAt,
    });
  }

  const status =
    input.status === LearnerProfileStatus.ARCHIVED
      ? LearnerProfileStatus.ARCHIVED
      : LearnerProfileStatus.ACTIVE;
  const version = toPositiveInteger(input.version, 1);
  const profileConfidence = clamp(Number(input.profileConfidence ?? 0.5), 0, 1);
  const canonicalIdentity = identityRefs.find((identityRef) => identityRef.isPrimary) ?? identityRefs[0];
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("lp", {
          spaceId: input.spaceId,
          learnerId: input.learnerId,
          canonicalIdentity,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    entityType: "learner_profile",
    learnerId: input.learnerId.trim(),
    status,
    version,
    profileConfidence,
    displayName:
      typeof input.displayName === "string" && input.displayName.trim()
        ? input.displayName.trim()
        : null,
    email: typeof input.email === "string" && input.email.trim() ? input.email.trim() : null,
    goals,
    interestTags,
    misconceptionIds,
    identityRefs,
    metadata: normalizeMetadata(input.metadata),
    createdAt,
    updatedAt,
  });
}

export function createIdentityGraphEdge(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("identity graph edge input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.profileId, "profileId");
  assertNonEmptyString(input.relation, "relation");

  const relationValues = Object.values(IdentityGraphRelationKind);
  const relation = input.relation.trim();
  if (!relationValues.includes(relation)) {
    throw new ValidationError("relation must be a supported identity graph relation", {
      relation,
      relationValues,
    });
  }

  const fromRef = normalizeIdentityRef(input.fromRef, "fromRef");
  const toRef = normalizeIdentityRef(input.toRef, "toRef");
  if (fromRef.namespace === toRef.namespace && fromRef.value === toRef.value) {
    throw new IdentityInvariantError("identity graph edge endpoints must be distinct", {
      fromRef,
      toRef,
    });
  }

  const evidenceEpisodeIds = asSortedUniqueStrings(input.evidenceEpisodeIds);
  if (
    (relation === IdentityGraphRelationKind.MISCONCEPTION_OF ||
      relation === IdentityGraphRelationKind.EVIDENCE_OF) &&
    evidenceEpisodeIds.length === 0
  ) {
    throw new EvidenceRequiredError("relation requires evidenceEpisodeIds", {
      relation,
    });
  }

  const createdAt = toIsoTimestamp(input.createdAt);
  const confidence = clamp(Number(input.confidence ?? 0.5), 0, 1);
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("edge", {
          spaceId: input.spaceId,
          profileId: input.profileId,
          relation,
          fromRef,
          toRef,
          evidenceEpisodeIds,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    entityType: "identity_graph_edge",
    profileId: input.profileId.trim(),
    relation,
    fromRef,
    toRef,
    confidence,
    evidenceEpisodeIds,
    metadata: normalizeMetadata(input.metadata),
    createdAt,
  });
}

export function createMisconceptionRecord(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("misconception record input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.profileId, "profileId");
  assertNonEmptyString(input.misconceptionKey, "misconceptionKey");
  if (input.createdAt === undefined || input.createdAt === null || input.createdAt === "") {
    throw new ValidationError("misconception record createdAt is required for deterministic upserts");
  }

  const evidenceEpisodeIds = asSortedUniqueStrings(input.evidenceEpisodeIds);
  if (evidenceEpisodeIds.length === 0) {
    throw new EvidenceRequiredError("misconception record requires at least one evidenceEpisodeId", {
      profileId: input.profileId,
      misconceptionKey: input.misconceptionKey,
    });
  }

  const sourceSignalIds = asSortedUniqueStrings(input.sourceSignalIds);
  const conflictEpisodeIds = asSortedUniqueStrings(input.conflictEpisodeIds);
  const harmfulSignalCount = toNonNegativeInteger(input.harmfulSignalCount, 0);
  const correctionSignalCount = toNonNegativeInteger(input.correctionSignalCount, 0);
  const conflictCount = Math.max(
    toNonNegativeInteger(input.conflictCount, conflictEpisodeIds.length),
    conflictEpisodeIds.length,
  );

  const createdAt = toIsoTimestamp(input.createdAt);
  const lastSignalAt = toIsoTimestamp(input.lastSignalAt ?? input.updatedAt ?? createdAt);
  const updatedAt = toIsoTimestamp(input.updatedAt ?? lastSignalAt);
  if (updatedAt < createdAt) {
    throw new ValidationError("misconception record updatedAt cannot precede createdAt", {
      createdAt,
      updatedAt,
    });
  }
  if (lastSignalAt < createdAt) {
    throw new ValidationError("misconception record lastSignalAt cannot precede createdAt", {
      createdAt,
      lastSignalAt,
    });
  }

  const statusValues = Object.values(MisconceptionStatus);
  const status = statusValues.includes(input.status) ? input.status : MisconceptionStatus.ACTIVE;
  const confidence = clamp(Number(input.confidence ?? 0.5), 0, 1);
  const tags = asSortedUniqueStrings(input.tags);
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("mis", {
          spaceId: input.spaceId,
          profileId: input.profileId,
          misconceptionKey: input.misconceptionKey,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    entityType: "misconception_record",
    profileId: input.profileId.trim(),
    misconceptionKey: input.misconceptionKey.trim(),
    status,
    confidence,
    harmfulSignalCount,
    correctionSignalCount,
    conflictCount,
    evidenceEpisodeIds,
    sourceSignalIds,
    conflictEpisodeIds,
    tags,
    metadata: normalizeMetadata(input.metadata),
    createdAt,
    updatedAt,
    lastSignalAt,
  });
}

export function createCurriculumPlanItem(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("curriculum plan input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.profileId, "profileId");
  assertNonEmptyString(input.objectiveId, "objectiveId");
  if (input.createdAt === undefined || input.createdAt === null || input.createdAt === "") {
    throw new ValidationError("curriculum plan item createdAt is required for deterministic upserts");
  }

  const evidenceEpisodeIds = asSortedUniqueStrings(input.evidenceEpisodeIds);
  if (evidenceEpisodeIds.length === 0) {
    throw new EvidenceRequiredError("curriculum plan item requires evidenceEpisodeIds", {
      profileId: input.profileId,
      objectiveId: input.objectiveId,
    });
  }

  const sourceMisconceptionIds = asSortedUniqueStrings(input.sourceMisconceptionIds);
  const interestTags = asSortedUniqueStrings(input.interestTags);
  const provenanceSignalIds = asSortedUniqueStrings(input.provenanceSignalIds);
  const recommendationRank = toPositiveInteger(input.recommendationRank ?? input.rank, 1);

  const createdAt = toIsoTimestamp(input.createdAt);
  const updatedAt = toIsoTimestamp(input.updatedAt ?? createdAt);
  if (updatedAt < createdAt) {
    throw new ValidationError("curriculum plan item updatedAt cannot precede createdAt", {
      createdAt,
      updatedAt,
    });
  }

  const dueAt =
    input.dueAt === undefined || input.dueAt === null || input.dueAt === ""
      ? null
      : toIsoTimestamp(input.dueAt);
  const recommendationWindowStartAt =
    input.recommendationWindowStartAt === undefined ||
    input.recommendationWindowStartAt === null ||
    input.recommendationWindowStartAt === ""
      ? null
      : toIsoTimestamp(input.recommendationWindowStartAt);
  const recommendationWindowEndAt =
    input.recommendationWindowEndAt === undefined ||
    input.recommendationWindowEndAt === null ||
    input.recommendationWindowEndAt === ""
      ? null
      : toIsoTimestamp(input.recommendationWindowEndAt);
  if (
    recommendationWindowStartAt &&
    recommendationWindowEndAt &&
    recommendationWindowEndAt < recommendationWindowStartAt
  ) {
    throw new ValidationError("curriculum plan recommendation window end cannot precede start", {
      recommendationWindowStartAt,
      recommendationWindowEndAt,
    });
  }

  const statusValues = Object.values(CurriculumPlanStatus);
  const status = statusValues.includes(input.status) ? input.status : CurriculumPlanStatus.PROPOSED;
  const itemType =
    typeof input.itemType === "string" && input.itemType.trim() ? input.itemType.trim() : "learning_step";
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("cp", {
          spaceId: input.spaceId,
          profileId: input.profileId,
          objectiveId: input.objectiveId,
          itemType,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    entityType: "curriculum_plan_item",
    profileId: input.profileId.trim(),
    objectiveId: input.objectiveId.trim(),
    itemType,
    status,
    recommendationRank,
    dueAt,
    recommendationWindowStartAt,
    recommendationWindowEndAt,
    evidenceEpisodeIds,
    sourceMisconceptionIds,
    interestTags,
    provenanceSignalIds,
    metadata: normalizeMetadata(input.metadata),
    createdAt,
    updatedAt,
  });
}

export function createReviewScheduleEntry(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("review schedule input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.profileId, "profileId");
  assertNonEmptyString(input.targetId, "targetId");
  if (
    (input.createdAt === undefined || input.createdAt === null || input.createdAt === "") &&
    (input.dueAt === undefined || input.dueAt === null || input.dueAt === "")
  ) {
    throw new ValidationError("review schedule entry requires createdAt or dueAt for deterministic upserts");
  }

  const sourceEventIds = asSortedUniqueStrings(input.sourceEventIds);
  if (sourceEventIds.length === 0) {
    throw new EvidenceRequiredError("review schedule entry requires at least one sourceEventId", {
      profileId: input.profileId,
      targetId: input.targetId,
    });
  }

  const evidenceEpisodeIds = asSortedUniqueStrings(input.evidenceEpisodeIds);
  const repetition = toNonNegativeInteger(input.repetition, 0);
  const intervalDays = toPositiveInteger(input.intervalDays, 1);
  const easeFactor = clamp(Number(input.easeFactor ?? 2.5), 1.3, 3);

  const createdAt = toIsoTimestamp(input.createdAt ?? input.dueAt);
  const dueAt = toIsoTimestamp(input.dueAt ?? createdAt);
  const updatedAt = toIsoTimestamp(input.updatedAt ?? dueAt);
  if (updatedAt < createdAt) {
    throw new ValidationError("review schedule updatedAt cannot precede createdAt", {
      createdAt,
      updatedAt,
    });
  }
  const lastReviewedAt =
    input.lastReviewedAt === undefined || input.lastReviewedAt === null || input.lastReviewedAt === ""
      ? null
      : toIsoTimestamp(input.lastReviewedAt);

  const statusValues = Object.values(ReviewScheduleStatus);
  const status = statusValues.includes(input.status) ? input.status : ReviewScheduleStatus.SCHEDULED;
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("srs", {
          spaceId: input.spaceId,
          profileId: input.profileId,
          targetId: input.targetId,
        });

  return deepFreeze({
    id,
    spaceId: input.spaceId.trim(),
    entityType: "review_schedule_entry",
    profileId: input.profileId.trim(),
    targetId: input.targetId.trim(),
    status,
    repetition,
    intervalDays,
    easeFactor,
    dueAt,
    lastReviewedAt,
    sourceEventIds,
    evidenceEpisodeIds,
    metadata: normalizeMetadata(input.metadata),
    createdAt,
    updatedAt,
  });
}

export function createPersonalizationPolicyDecision(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("policy decision input must be an object");
  }

  assertNonEmptyString(input.spaceId, "spaceId");
  assertNonEmptyString(input.profileId, "profileId");
  assertNonEmptyString(input.policyKey, "policyKey");
  if (input.createdAt === undefined || input.createdAt === null || input.createdAt === "") {
    throw new ValidationError("policy decision createdAt is required for deterministic upserts");
  }

  const outcomeValues = Object.values(PersonalizationPolicyOutcome);
  const outcome = outcomeValues.includes(input.outcome)
    ? input.outcome
    : PersonalizationPolicyOutcome.REVIEW;
  const reasonCodes = asSortedUniqueStrings(input.reasonCodes);
  if (outcome === PersonalizationPolicyOutcome.DENY && reasonCodes.length === 0) {
    throw new ValidationError("deny decisions require reasonCodes", {
      outcome,
      reasonCodes,
    });
  }

  const surface =
    typeof input.surface === "string" && input.surface.trim() ? input.surface.trim() : "general";
  const action =
    typeof input.action === "string" && input.action.trim() ? input.action.trim() : "evaluate";
  const appliedControls = asSortedUniqueStrings(input.appliedControls);
  const provenanceEventIds = asSortedUniqueStrings(input.provenanceEventIds);
  if (provenanceEventIds.length === 0) {
    throw new EvidenceRequiredError("policy decision requires at least one provenanceEventId", {
      policyKey: input.policyKey,
    });
  }

  const evidenceEpisodeIds = asSortedUniqueStrings(input.evidenceEpisodeIds);
  const createdAt = toIsoTimestamp(input.createdAt);
  const evaluatedAt = toIsoTimestamp(input.evaluatedAt ?? createdAt);
  const updatedAt = toIsoTimestamp(input.updatedAt ?? evaluatedAt);
  if (updatedAt < createdAt) {
    throw new ValidationError("policy decision updatedAt cannot precede createdAt", {
      createdAt,
      updatedAt,
    });
  }

  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : deterministicId("pol", {
          spaceId: input.spaceId,
          profileId: input.profileId,
          policyKey: input.policyKey,
          surface,
          action,
          provenanceEventIds,
        });
  const auditId =
    typeof input.auditId === "string" && input.auditId.trim()
      ? input.auditId.trim()
      : deterministicId("audit", {
          id,
          policyKey: input.policyKey,
          profileId: input.profileId,
        });

  return deepFreeze({
    id,
    auditId,
    spaceId: input.spaceId.trim(),
    entityType: "personalization_policy_decision",
    profileId: input.profileId.trim(),
    policyKey: input.policyKey.trim(),
    surface,
    action,
    outcome,
    reasonCodes,
    appliedControls,
    provenanceEventIds,
    evidenceEpisodeIds,
    metadata: normalizeMetadata(input.metadata),
    createdAt,
    evaluatedAt,
    updatedAt,
  });
}

export function assertLearnerProfileLinks(profile) {
  if (!profile || !Array.isArray(profile.identityRefs) || profile.identityRefs.length === 0) {
    throw new IdentityInvariantError("learner profile must contain identityRefs", { profile });
  }
}

export function assertIdentityEdgeInSpace(edge, expectedSpaceId) {
  if (!edge || edge.spaceId !== expectedSpaceId) {
    throw new IsolationViolationError("identity edge isolation check failed", {
      expectedSpaceId,
      edgeSpaceId: edge?.spaceId ?? null,
      edgeId: edge?.id ?? null,
    });
  }
}

export function assertMisconceptionEvidence(record) {
  if (!record || !Array.isArray(record.evidenceEpisodeIds) || record.evidenceEpisodeIds.length === 0) {
    throw new EvidenceRequiredError("misconception record requires evidenceEpisodeIds", { record });
  }
}

export function assertCurriculumPlanEvidence(item) {
  if (!item || !Array.isArray(item.evidenceEpisodeIds) || item.evidenceEpisodeIds.length === 0) {
    throw new EvidenceRequiredError("curriculum plan item requires evidenceEpisodeIds", { item });
  }
}

export function assertReviewScheduleProvenance(entry) {
  if (!entry || !Array.isArray(entry.sourceEventIds) || entry.sourceEventIds.length === 0) {
    throw new EvidenceRequiredError("review schedule entry requires sourceEventIds", { entry });
  }
}

export function assertPolicyDecisionAuditable(decision) {
  if (
    !decision ||
    typeof decision.auditId !== "string" ||
    !decision.auditId.trim() ||
    !Array.isArray(decision.provenanceEventIds) ||
    decision.provenanceEventIds.length === 0
  ) {
    throw new ValidationError("policy decision must be auditable and provenance-backed", { decision });
  }
  if (
    decision.outcome === PersonalizationPolicyOutcome.DENY &&
    (!Array.isArray(decision.reasonCodes) || decision.reasonCodes.length === 0)
  ) {
    throw new ValidationError("deny policy decision requires reasonCodes", { decision });
  }
}

export function isLearnerProfileActive(profile) {
  return profile?.status === LearnerProfileStatus.ACTIVE;
}

export function assertEvidenceLinks(entry) {
  if (!entry || !Array.isArray(entry.evidenceEpisodeIds) || entry.evidenceEpisodeIds.length === 0) {
    throw new EvidenceRequiredError("entry must contain at least one evidenceEpisodeId", { entry });
  }
}

export function assertEntityInSpace(entity, expectedSpaceId) {
  if (!entity || entity.spaceId !== expectedSpaceId) {
    throw new IsolationViolationError("entity isolation check failed", {
      expectedSpaceId,
      entitySpaceId: entity?.spaceId ?? null,
      entityId: entity?.id ?? null,
    });
  }
}

export function isProceduralActive(entry) {
  return entry?.kind === ProceduralEntryKind.RULE && entry.status === ProceduralEntryStatus.ACTIVE;
}

export function isMisconceptionActive(record) {
  return record?.status === MisconceptionStatus.ACTIVE;
}

export function isCurriculumPlanOpen(item) {
  return item?.status === CurriculumPlanStatus.PROPOSED || item?.status === CurriculumPlanStatus.COMMITTED;
}

export function isReviewScheduleDue(entry, asOf = new Date().toISOString()) {
  if (!entry) {
    return false;
  }
  const now = toIsoTimestamp(asOf);
  return (
    entry.status === ReviewScheduleStatus.DUE ||
    (entry.status === ReviewScheduleStatus.SCHEDULED && entry.dueAt <= now)
  );
}

export function isPolicyDecisionDenied(decision) {
  return decision?.outcome === PersonalizationPolicyOutcome.DENY;
}
