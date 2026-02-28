import {
  EvidenceRequiredError,
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
