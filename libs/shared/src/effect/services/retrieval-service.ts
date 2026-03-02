import { createHash } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import type {
  ActionableRetrievalPack,
  PolicyRequest,
  RetrievalExplainabilityHit,
  RetrievalExplainabilityReasonCode,
  RetrievalExplainabilityResponse,
  RetrievalHit,
  RetrievalPolicyInput,
  RetrievalRankingWeights,
  RetrievalRequest,
  RetrievalResponse,
  ScopeAuthorizationInput,
  RetrievalScopeLevel,
  RetrievalScopeSelectors,
} from "../contracts/index.js";
import { decodeRetrievalRequestEffect } from "../contracts/validators.js";
import { RetrievalQueryError, type RetrievalServiceError } from "../errors.js";
import {
  parseSqliteStorageSnapshotPayload,
  type SqliteStorageSnapshotData,
} from "../storage/sqlite/index.js";
import type { PolicyService } from "./policy-service.js";
import type { StorageService } from "./storage-service.js";

export type {
  RetrievalExplainabilityHit,
  RetrievalExplainabilityReasonCode,
  RetrievalExplainabilityResponse,
  RetrievalHit,
  RetrievalPolicyInput,
  RetrievalRankingWeights,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalScopeLevel,
  RetrievalScopeSelectors,
} from "../contracts/index.js";

export interface RetrievalService {
  readonly retrieve: (
    request: RetrievalRequest
  ) => Effect.Effect<RetrievalResponse, RetrievalServiceError>;
  readonly retrieveExplainability: (
    request: RetrievalRequest
  ) => Effect.Effect<RetrievalExplainabilityResponse, RetrievalServiceError>;
}

export const RetrievalServiceTag = Context.GenericTag<RetrievalService>(
  "@ums/effect/RetrievalService"
);

const defaultSnapshotSignatureSecret = "@ums/retrieval-service/snapshot";
const defaultPolicyActorId = "retrieval-system" as PolicyRequest["actorId"];
const defaultPolicyAction = "memory.retrieve";
const emptyPolicyEvidenceIds = [] as unknown as PolicyRequest["evidenceIds"];
const emptyPolicyContext = {} as unknown as PolicyRequest["context"];
const neutralSignalScore = 0.5;
const actionablePackTokenBudget = 260;
const actionablePackWarningTokenBudget = 40;
const actionablePackContentTokenBudget =
  actionablePackTokenBudget - actionablePackWarningTokenBudget;
const actionablePackPerCategoryLimit = 2;
const actionablePackSourceLimit = 6;
const actionablePackWarningLimit = 4;
const actionablePackLineTokenLimit = 18;
const actionablePackSourceExcerptTokenLimit = 14;
const actionablePackWarningTokenLimit = 18;
const actionablePackTextCharacterLimit = 200;
const actionablePackLowConfidenceScoreThreshold = 0.5;
const actionablePackStaleAgeGapMillis = 7 * 24 * 60 * 60 * 1_000;

type ActionablePackCategory = "do" | "dont" | "examples" | "risks";
type ActionablePackSource = ActionableRetrievalPack["sources"][number];

interface MutableActionablePack {
  readonly do: string[];
  readonly dont: string[];
  readonly examples: string[];
  readonly risks: string[];
  readonly sources: ActionablePackSource[];
  readonly warnings: string[];
}

interface BoundedActionableText {
  readonly value: string | null;
  readonly tokenCount: number;
  readonly truncated: boolean;
}

interface ActionablePackWarningSignal {
  readonly updatedAtMillis: number;
  readonly score: number;
}

interface ActionablePackCompilerStats {
  readonly categoryLimitDrops: Record<ActionablePackCategory, number>;
  tokenBudgetDrops: number;
  sourceLimitDrops: number;
  lineTruncations: number;
  sourceExcerptTruncations: number;
}

interface NormalizedRankingWeights {
  readonly relevance: number;
  readonly evidenceStrength: number;
  readonly decay: number;
  readonly humanWeight: number;
  readonly utility: number;
}

const defaultRankingWeights: NormalizedRankingWeights = Object.freeze({
  relevance: 0.6,
  evidenceStrength: 0.1,
  decay: 0.15,
  humanWeight: 0.075,
  utility: 0.075,
});

type ScopeLevel = RetrievalScopeLevel;

interface ParsedScopeRow {
  readonly scopeId: string;
  readonly scopeLevel: ScopeLevel;
  readonly projectId: string | null;
  readonly roleId: string | null;
  readonly userId: string | null;
  readonly parentScopeId: string | null;
}

interface ParsedMemoryRow {
  readonly memoryId: RetrievalHit["memoryId"];
  readonly scopeId: string;
  readonly layer: RetrievalHit["layer"];
  readonly status: string;
  readonly title: string;
  readonly payloadJson: string;
  readonly updatedAtMillis: number;
  readonly expiresAtMillis: number | null;
  readonly tombstonedAtMillis: number | null;
}

interface HitChronology {
  readonly contradictsMemoryIds: readonly RetrievalHit["memoryId"][];
  readonly supersedesMemoryIds: readonly RetrievalHit["memoryId"][];
}

interface PlannedHit {
  readonly memoryId: RetrievalHit["memoryId"];
  readonly layer: RetrievalHit["layer"];
  readonly score: number;
  readonly excerpt: string;
  readonly scopeId: string;
  readonly scopeLevel: ScopeLevel;
  readonly scopeRank: number;
  readonly updatedAtMillis: number;
  readonly rankingSignals: RankingSignals;
  readonly chronology: HitChronology;
  readonly reconciledMemoryIds: readonly RetrievalHit["memoryId"][];
}

interface NormalizedScopeSelectors {
  readonly projectId: string | null;
  readonly roleId: string | null;
  readonly userId: string | null;
}

interface NormalizedPolicyInput {
  readonly actorId: PolicyRequest["actorId"];
  readonly action: PolicyRequest["action"];
  readonly evidenceIds: PolicyRequest["evidenceIds"];
  readonly context: PolicyRequest["context"];
}

interface NormalizedScopeAuthorization {
  readonly tenantId: string | null;
  readonly allowedProjectIds: ReadonlySet<string>;
  readonly allowedRoleIds: ReadonlySet<string>;
  readonly allowedUserIds: ReadonlySet<string>;
}

interface NormalizedRetrievalRequest {
  readonly request: RetrievalRequest;
  readonly selectors: NormalizedScopeSelectors;
  readonly policy: NormalizedPolicyInput;
  readonly scopeAuthorization: NormalizedScopeAuthorization | null;
  readonly scopeAuthorizationSelectorDenyMessage: string | null;
  readonly rankingWeights: NormalizedRankingWeights;
  readonly queryNormalized: string;
  readonly queryTokens: readonly string[];
}

interface RankingSignals {
  readonly relevance: number;
  readonly evidenceStrength: number;
  readonly decay: number;
  readonly humanWeight: number;
  readonly utility: number;
}

interface PlannedHitCandidate {
  readonly memoryId: RetrievalHit["memoryId"];
  readonly layer: RetrievalHit["layer"];
  readonly excerpt: string;
  readonly scopeId: string;
  readonly scopeLevel: ScopeLevel;
  readonly scopeRank: number;
  readonly updatedAtMillis: number;
  readonly expiresAtMillis: number | null;
  readonly rankingSignals: Omit<RankingSignals, "decay">;
  readonly chronology: HitChronology;
}

interface CursorPayload {
  readonly v: 1;
  readonly o: number;
  readonly d: string;
}

interface PaginatedPlannedHits {
  readonly pageHits: readonly PlannedHit[];
  readonly totalHits: number;
  readonly nextCursor: string | null;
  readonly offset: number;
}

export interface RetrievalPlannerOptions {
  readonly snapshotSignatureSecret?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describeFailure = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (isRecord(cause)) {
    const taggedMessage = cause["message"];
    if (typeof taggedMessage === "string" && taggedMessage.trim().length > 0) {
      return taggedMessage;
    }
  }
  return String(cause);
};

const toRetrievalQueryError = (
  request: RetrievalRequest,
  message: string
): RetrievalQueryError =>
  new RetrievalQueryError({
    spaceId: request.spaceId,
    query: request.query,
    message,
  });

const readSnapshotTable = (
  snapshot: SqliteStorageSnapshotData,
  tableName: "scopes" | "memory_items"
) => {
  const table = snapshot.tables.find((entry) => entry.name === tableName);
  if (table === undefined) {
    throw new Error(`Snapshot table ${tableName} is missing.`);
  }
  return table;
};

const readColumnIndex = (
  tableName: string,
  columns: readonly string[],
  columnName: string
): number => {
  const index = columns.indexOf(columnName);
  if (index === -1) {
    throw new Error(
      `Snapshot table ${tableName} is missing required column ${columnName}.`
    );
  }
  return index;
};

const readRowCell = (
  row: readonly (string | number | null)[],
  index: number,
  label: string
): string | number | null => {
  const value = row[index];
  if (value === undefined) {
    throw new Error(`${label} is undefined.`);
  }
  return value;
};

const readNonEmptyString = (
  row: readonly (string | number | null)[],
  index: number,
  label: string
): string => {
  const value = readRowCell(row, index, label);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const readNullableString = (
  row: readonly (string | number | null)[],
  index: number,
  label: string
): string | null => {
  const value = readRowCell(row, index, label);
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string or null.`);
  }
  return value;
};

const readNonNegativeInteger = (
  row: readonly (string | number | null)[],
  index: number,
  label: string
): number => {
  const value = readRowCell(row, index, label);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
};

const readNullableNonNegativeInteger = (
  row: readonly (string | number | null)[],
  index: number,
  label: string
): number | null => {
  const value = readRowCell(row, index, label);
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer or null.`);
  }
  return value;
};

const toScopeLevel = (value: string, label: string): ScopeLevel => {
  if (
    value === "common" ||
    value === "project" ||
    value === "job_role" ||
    value === "user"
  ) {
    return value;
  }
  throw new Error(`${label} must be one of common, project, job_role, user.`);
};

const toMemoryLayer = (value: string, label: string): RetrievalHit["layer"] => {
  if (value === "episodic" || value === "working" || value === "procedural") {
    return value;
  }
  throw new Error(`${label} must be one of episodic, working, procedural.`);
};

const toMemoryId = (value: string): RetrievalHit["memoryId"] =>
  value as RetrievalHit["memoryId"];

const parseScopeRows = (
  snapshot: SqliteStorageSnapshotData,
  spaceId: string
): readonly ParsedScopeRow[] => {
  const table = readSnapshotTable(snapshot, "scopes");
  const scopeIdIndex = readColumnIndex("scopes", table.columns, "scope_id");
  const tenantIdIndex = readColumnIndex("scopes", table.columns, "tenant_id");
  const scopeLevelIndex = readColumnIndex(
    "scopes",
    table.columns,
    "scope_level"
  );
  const projectIdIndex = readColumnIndex("scopes", table.columns, "project_id");
  const roleIdIndex = readColumnIndex("scopes", table.columns, "role_id");
  const userIdIndex = readColumnIndex("scopes", table.columns, "user_id");
  const parentScopeIdIndex = readColumnIndex(
    "scopes",
    table.columns,
    "parent_scope_id"
  );

  const rows: ParsedScopeRow[] = [];
  for (const [rowIndex, row] of table.rows.entries()) {
    const tenantId = readNonEmptyString(
      row,
      tenantIdIndex,
      `scopes.rows[${rowIndex}].tenant_id`
    );
    if (tenantId !== spaceId) {
      continue;
    }
    rows.push({
      scopeId: readNonEmptyString(
        row,
        scopeIdIndex,
        `scopes.rows[${rowIndex}].scope_id`
      ),
      scopeLevel: toScopeLevel(
        readNonEmptyString(
          row,
          scopeLevelIndex,
          `scopes.rows[${rowIndex}].scope_level`
        ),
        `scopes.rows[${rowIndex}].scope_level`
      ),
      projectId: readNullableString(
        row,
        projectIdIndex,
        `scopes.rows[${rowIndex}].project_id`
      ),
      roleId: readNullableString(
        row,
        roleIdIndex,
        `scopes.rows[${rowIndex}].role_id`
      ),
      userId: readNullableString(
        row,
        userIdIndex,
        `scopes.rows[${rowIndex}].user_id`
      ),
      parentScopeId: readNullableString(
        row,
        parentScopeIdIndex,
        `scopes.rows[${rowIndex}].parent_scope_id`
      ),
    });
  }

  return Object.freeze(rows);
};

const parseMemoryRows = (
  snapshot: SqliteStorageSnapshotData,
  spaceId: string
): readonly ParsedMemoryRow[] => {
  const table = readSnapshotTable(snapshot, "memory_items");
  const memoryIdIndex = readColumnIndex(
    "memory_items",
    table.columns,
    "memory_id"
  );
  const tenantIdIndex = readColumnIndex(
    "memory_items",
    table.columns,
    "tenant_id"
  );
  const scopeIdIndex = readColumnIndex(
    "memory_items",
    table.columns,
    "scope_id"
  );
  const layerIndex = readColumnIndex(
    "memory_items",
    table.columns,
    "memory_layer"
  );
  const statusIndex = readColumnIndex("memory_items", table.columns, "status");
  const titleIndex = readColumnIndex("memory_items", table.columns, "title");
  const payloadJsonIndex = readColumnIndex(
    "memory_items",
    table.columns,
    "payload_json"
  );
  const updatedAtIndex = readColumnIndex(
    "memory_items",
    table.columns,
    "updated_at_ms"
  );
  const expiresAtIndex = readColumnIndex(
    "memory_items",
    table.columns,
    "expires_at_ms"
  );
  const tombstonedAtIndex = readColumnIndex(
    "memory_items",
    table.columns,
    "tombstoned_at_ms"
  );

  const rows: ParsedMemoryRow[] = [];
  for (const [rowIndex, row] of table.rows.entries()) {
    const tenantId = readNonEmptyString(
      row,
      tenantIdIndex,
      `memory_items.rows[${rowIndex}].tenant_id`
    );
    if (tenantId !== spaceId) {
      continue;
    }

    rows.push({
      memoryId: toMemoryId(
        readNonEmptyString(
          row,
          memoryIdIndex,
          `memory_items.rows[${rowIndex}].memory_id`
        )
      ),
      scopeId: readNonEmptyString(
        row,
        scopeIdIndex,
        `memory_items.rows[${rowIndex}].scope_id`
      ),
      layer: toMemoryLayer(
        readNonEmptyString(
          row,
          layerIndex,
          `memory_items.rows[${rowIndex}].memory_layer`
        ),
        `memory_items.rows[${rowIndex}].memory_layer`
      ),
      status: readNonEmptyString(
        row,
        statusIndex,
        `memory_items.rows[${rowIndex}].status`
      ),
      title: readNonEmptyString(
        row,
        titleIndex,
        `memory_items.rows[${rowIndex}].title`
      ),
      payloadJson: readNonEmptyString(
        row,
        payloadJsonIndex,
        `memory_items.rows[${rowIndex}].payload_json`
      ),
      updatedAtMillis: readNonNegativeInteger(
        row,
        updatedAtIndex,
        `memory_items.rows[${rowIndex}].updated_at_ms`
      ),
      expiresAtMillis: readNullableNonNegativeInteger(
        row,
        expiresAtIndex,
        `memory_items.rows[${rowIndex}].expires_at_ms`
      ),
      tombstonedAtMillis: readNullableNonNegativeInteger(
        row,
        tombstonedAtIndex,
        `memory_items.rows[${rowIndex}].tombstoned_at_ms`
      ),
    });
  }

  return Object.freeze(rows);
};

const tokenize = (text: string): readonly string[] => {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return Object.freeze([...new Set(matches)]);
};

const clampScore = (value: number): number =>
  Math.min(1, Math.max(0, Math.round(value * 1_000_000) / 1_000_000));

const toOptionalRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const readRecordValue = (
  record: Record<string, unknown> | null,
  keys: readonly string[]
): unknown => {
  if (record === null) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }
  return undefined;
};

const parsePayloadRecord = (
  payloadJson: string
): Record<string, unknown> | null => {
  try {
    return toOptionalRecord(JSON.parse(payloadJson));
  } catch {
    return null;
  }
};

const contradictionLinkKeys = Object.freeze([
  "contradicts",
  "contradictsMemoryId",
  "contradicts_memory_id",
  "contradictsMemoryIds",
  "contradicts_memory_ids",
  "contradictionMemoryId",
  "contradiction_memory_id",
  "contradictionMemoryIds",
  "contradiction_memory_ids",
]);

const supersedesLinkKeys = Object.freeze([
  "supersedes",
  "supersedesMemoryId",
  "supersedes_memory_id",
  "supersedesMemoryIds",
  "supersedes_memory_ids",
]);

const relationCollectionKeys = Object.freeze([
  "relations",
  "relationLinks",
  "relation_links",
  "memoryRelations",
  "memory_relations",
  "memoryLinks",
  "memory_links",
  "links",
]);

const relationKindKeys = Object.freeze([
  "relationKind",
  "relation_kind",
  "kind",
  "type",
  "linkType",
  "link_type",
]);

const relationTargetKeys = Object.freeze([
  "memoryId",
  "memory_id",
  "targetMemoryId",
  "target_memory_id",
  "targetId",
  "target_id",
  "memoryIds",
  "memory_ids",
  "targetMemoryIds",
  "target_memory_ids",
  "memory",
  "target",
  "targets",
]);

const emptyHitChronology: HitChronology = Object.freeze({
  contradictsMemoryIds: Object.freeze([]),
  supersedesMemoryIds: Object.freeze([]),
});

const toOptionalTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toOptionalMemoryId = (
  value: unknown
): RetrievalHit["memoryId"] | null => {
  const trimmed = toOptionalTrimmedString(value);
  return trimmed === null ? null : toMemoryId(trimmed);
};

const toSortedMemoryIds = (
  memoryIds: Iterable<RetrievalHit["memoryId"]>
): readonly RetrievalHit["memoryId"][] =>
  Object.freeze(
    [...new Set(memoryIds)].sort((left, right) => left.localeCompare(right))
  );

const collectMemoryIdsFromLinkedValue = (
  value: unknown,
  accumulator: Set<RetrievalHit["memoryId"]>
): void => {
  const memoryId = toOptionalMemoryId(value);
  if (memoryId !== null) {
    accumulator.add(memoryId);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectMemoryIdsFromLinkedValue(entry, accumulator);
    }
    return;
  }

  const record = toOptionalRecord(value);
  if (record === null) {
    return;
  }

  for (const key of relationTargetKeys) {
    if (!Object.hasOwn(record, key)) {
      continue;
    }
    collectMemoryIdsFromLinkedValue(record[key], accumulator);
  }
};

type RelationKind = "contradicts" | "supersedes";

const toRelationKind = (value: unknown): RelationKind | null => {
  const normalizedValue = toOptionalTrimmedString(value);
  if (normalizedValue === null) {
    return null;
  }
  const normalized = normalizedValue.toLowerCase();
  if (normalized.includes("contradict")) {
    return "contradicts";
  }
  if (normalized.includes("supersede")) {
    return "supersedes";
  }
  return null;
};

const collectExplicitLinkedMemoryIds = (
  container: Record<string, unknown> | null,
  keys: readonly string[],
  accumulator: Set<RetrievalHit["memoryId"]>
): void => {
  if (container === null) {
    return;
  }

  for (const key of keys) {
    if (!Object.hasOwn(container, key)) {
      continue;
    }
    collectMemoryIdsFromLinkedValue(container[key], accumulator);
  }
};

const toRelationRecords = (
  value: unknown
): readonly Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return Object.freeze(
      value
        .map((entry) => toOptionalRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
    );
  }
  const record = toOptionalRecord(value);
  return record === null ? Object.freeze([]) : Object.freeze([record]);
};

const appendRelationTargets = (
  relationRecord: Record<string, unknown>,
  contradictsMemoryIds: Set<RetrievalHit["memoryId"]>,
  supersedesMemoryIds: Set<RetrievalHit["memoryId"]>
): void => {
  collectExplicitLinkedMemoryIds(
    relationRecord,
    contradictionLinkKeys,
    contradictsMemoryIds
  );
  collectExplicitLinkedMemoryIds(
    relationRecord,
    supersedesLinkKeys,
    supersedesMemoryIds
  );

  const relationKind = toRelationKind(
    readRecordValue(relationRecord, relationKindKeys)
  );
  if (relationKind === null) {
    return;
  }

  const relationTargetIds = new Set<RetrievalHit["memoryId"]>();
  collectExplicitLinkedMemoryIds(
    relationRecord,
    relationTargetKeys,
    relationTargetIds
  );
  if (relationTargetIds.size === 0) {
    return;
  }

  const relationAccumulator =
    relationKind === "contradicts" ? contradictsMemoryIds : supersedesMemoryIds;
  for (const relationTargetId of relationTargetIds) {
    relationAccumulator.add(relationTargetId);
  }
};

const toHitChronology = (
  payloadRecord: Record<string, unknown> | null,
  memoryId: RetrievalHit["memoryId"]
): HitChronology => {
  if (payloadRecord === null) {
    return emptyHitChronology;
  }

  const metadataRecord = toOptionalRecord(
    readRecordValue(payloadRecord, ["metadata"])
  );
  const chronologyRecord = toOptionalRecord(
    readRecordValue(payloadRecord, ["chronology"])
  );
  const lineageRecord = toOptionalRecord(
    readRecordValue(payloadRecord, ["lineage"])
  );
  const metadataChronologyRecord = toOptionalRecord(
    readRecordValue(metadataRecord, ["chronology"])
  );
  const metadataLineageRecord = toOptionalRecord(
    readRecordValue(metadataRecord, ["lineage"])
  );
  const containers = Object.freeze([
    payloadRecord,
    metadataRecord,
    chronologyRecord,
    lineageRecord,
    metadataChronologyRecord,
    metadataLineageRecord,
  ]);

  const contradictsMemoryIds = new Set<RetrievalHit["memoryId"]>();
  const supersedesMemoryIds = new Set<RetrievalHit["memoryId"]>();

  for (const container of containers) {
    collectExplicitLinkedMemoryIds(
      container,
      contradictionLinkKeys,
      contradictsMemoryIds
    );
    collectExplicitLinkedMemoryIds(
      container,
      supersedesLinkKeys,
      supersedesMemoryIds
    );

    if (container === null) {
      continue;
    }
    for (const relationKey of relationCollectionKeys) {
      if (!Object.hasOwn(container, relationKey)) {
        continue;
      }
      const relationRecords = toRelationRecords(container[relationKey]);
      for (const relationRecord of relationRecords) {
        appendRelationTargets(
          relationRecord,
          contradictsMemoryIds,
          supersedesMemoryIds
        );
      }
    }
  }

  contradictsMemoryIds.delete(memoryId);
  supersedesMemoryIds.delete(memoryId);

  if (contradictsMemoryIds.size === 0 && supersedesMemoryIds.size === 0) {
    return emptyHitChronology;
  }

  return Object.freeze({
    contradictsMemoryIds: toSortedMemoryIds(contradictsMemoryIds),
    supersedesMemoryIds: toSortedMemoryIds(supersedesMemoryIds),
  });
};

const toExcerpt = (
  title: string,
  payloadRecord: Record<string, unknown> | null
): string => {
  let excerpt = title;

  if (payloadRecord !== null) {
    const preferredKeys = [
      "summary",
      "content",
      "text",
      "description",
      "note",
      "details",
    ] as const;
    for (const key of preferredKeys) {
      const value = payloadRecord[key];
      if (typeof value === "string" && value.trim().length > 0) {
        excerpt = value.trim();
        break;
      }
    }
  }

  return excerpt.length > 220 ? `${excerpt.slice(0, 217)}...` : excerpt;
};

const toScopeRank = (scopeLevel: ScopeLevel): number => {
  switch (scopeLevel) {
    case "common":
      return 0;
    case "project":
      return 1;
    case "job_role":
      return 2;
    case "user":
      return 3;
    default:
      return 0;
  }
};

const toNormalizedRankingWeights = (
  weights: NormalizedRankingWeights
): NormalizedRankingWeights => {
  const totalWeight =
    weights.relevance +
    weights.evidenceStrength +
    weights.decay +
    weights.humanWeight +
    weights.utility;
  if (totalWeight <= 0) {
    return defaultRankingWeights;
  }
  return Object.freeze({
    relevance: clampScore(weights.relevance / totalWeight),
    evidenceStrength: clampScore(weights.evidenceStrength / totalWeight),
    decay: clampScore(weights.decay / totalWeight),
    humanWeight: clampScore(weights.humanWeight / totalWeight),
    utility: clampScore(weights.utility / totalWeight),
  });
};

const resolveRankingWeights = (
  request: RetrievalRequest
): NormalizedRankingWeights => {
  const requestWithAliases = request as RetrievalRequest & {
    readonly ranking_weights?: RetrievalRankingWeights;
  };
  const candidateWeights =
    request.rankingWeights ?? requestWithAliases.ranking_weights;
  if (candidateWeights === undefined) {
    return defaultRankingWeights;
  }
  const evidenceStrength =
    candidateWeights.evidenceStrength ?? candidateWeights.evidence_strength;
  const humanWeight =
    candidateWeights.humanWeight ?? candidateWeights.human_weight;
  const utility =
    candidateWeights.utility ??
    candidateWeights.utilityScore ??
    candidateWeights.utility_score;

  return toNormalizedRankingWeights({
    relevance: candidateWeights.relevance ?? 0,
    evidenceStrength: evidenceStrength ?? 0,
    decay: candidateWeights.decay ?? 0,
    humanWeight: humanWeight ?? 0,
    utility: utility ?? 0,
  });
};

const toOptionalFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readNumericSignalFromContainers = (
  containers: readonly (Record<string, unknown> | null)[],
  keyGroups: readonly (readonly string[])[]
): number | null => {
  for (const keys of keyGroups) {
    for (const container of containers) {
      const candidateNumber = toOptionalFiniteNumber(
        readRecordValue(container, keys)
      );
      if (candidateNumber !== null) {
        return candidateNumber;
      }
    }
  }
  return null;
};

const resolveSignalContainers = (
  payloadRecord: Record<string, unknown> | null
): readonly (Record<string, unknown> | null)[] => {
  const metadataRecord = toOptionalRecord(
    readRecordValue(payloadRecord, ["metadata"])
  );
  const rankingRecord = toOptionalRecord(
    readRecordValue(payloadRecord, ["ranking", "scores"])
  );
  const metadataRankingRecord = toOptionalRecord(
    readRecordValue(metadataRecord, ["ranking", "scores"])
  );
  const evidenceRecord = toOptionalRecord(
    readRecordValue(payloadRecord, ["evidence"])
  );
  const metadataEvidenceRecord = toOptionalRecord(
    readRecordValue(metadataRecord, ["evidence"])
  );

  return Object.freeze([
    payloadRecord,
    metadataRecord,
    rankingRecord,
    metadataRankingRecord,
    evidenceRecord,
    metadataEvidenceRecord,
  ]);
};

const toEvidenceStrengthSignal = (
  payloadRecord: Record<string, unknown> | null
): number => {
  const signalContainers = resolveSignalContainers(payloadRecord);
  const explicitEvidenceStrength = readNumericSignalFromContainers(
    signalContainers,
    [
      ["evidenceStrength", "evidence_strength"],
      ["evidenceScore", "evidence_score"],
    ]
  );
  if (explicitEvidenceStrength !== null) {
    return clampScore(explicitEvidenceStrength);
  }

  const countKeyGroups = [
    ["evidencePointers", "evidence_pointers", "pointers"],
    ["evidenceLinks", "evidence_links", "links"],
    ["evidenceIds", "evidence_ids", "ids"],
    ["evidenceEventIds", "evidence_event_ids", "eventIds", "event_ids"],
    ["evidenceEpisodeIds", "evidence_episode_ids", "episodeIds", "episode_ids"],
  ] as const;

  let evidenceCount = 0;
  for (const keys of countKeyGroups) {
    let maxCountForGroup = 0;
    for (const container of signalContainers) {
      const candidateValue = readRecordValue(container, keys);
      if (Array.isArray(candidateValue)) {
        maxCountForGroup = Math.max(maxCountForGroup, candidateValue.length);
      }
    }
    evidenceCount += maxCountForGroup;
  }

  if (evidenceCount <= 0) {
    return 0;
  }
  return clampScore(evidenceCount / (evidenceCount + 1));
};

const toHumanWeightSignal = (
  payloadRecord: Record<string, unknown> | null
): number => {
  const signalContainers = resolveSignalContainers(payloadRecord);
  const explicitHumanWeight = readNumericSignalFromContainers(
    signalContainers,
    [
      ["humanWeight", "human_weight"],
      ["humanScore", "human_score"],
    ]
  );
  return clampScore(explicitHumanWeight ?? neutralSignalScore);
};

const toUtilitySignal = (
  payloadRecord: Record<string, unknown> | null
): number => {
  const signalContainers = resolveSignalContainers(payloadRecord);
  const explicitUtility = readNumericSignalFromContainers(signalContainers, [
    ["utility", "utilityScore", "utility_score"],
    ["learnedUtility", "learned_utility"],
  ]);
  return clampScore(explicitUtility ?? neutralSignalScore);
};

const computeQueryRelevanceSignal = (
  queryTokens: readonly string[],
  queryNormalized: string,
  searchableText: string
): number | null => {
  let relevanceSignal = neutralSignalScore;
  if (queryTokens.length > 0) {
    let matchedTokenCount = 0;
    for (const token of queryTokens) {
      if (searchableText.includes(token)) {
        matchedTokenCount += 1;
      }
    }
    if (matchedTokenCount === 0) {
      return null;
    }
    relevanceSignal = matchedTokenCount / queryTokens.length;
  }

  const exactQueryBoost =
    queryNormalized.length > 0 && searchableText.includes(queryNormalized)
      ? 0.15
      : 0;
  return clampScore(relevanceSignal + exactQueryBoost);
};

interface DecaySignalContext {
  readonly minUpdatedAtMillis: number;
  readonly maxUpdatedAtMillis: number;
  readonly maxRemainingLifespanMillis: number;
}

const buildDecaySignalContext = (
  candidates: readonly PlannedHitCandidate[]
): DecaySignalContext => {
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    return {
      minUpdatedAtMillis: 0,
      maxUpdatedAtMillis: 0,
      maxRemainingLifespanMillis: 0,
    };
  }

  let minUpdatedAtMillis = firstCandidate.updatedAtMillis;
  let maxUpdatedAtMillis = firstCandidate.updatedAtMillis;
  let maxRemainingLifespanMillis = 0;

  for (const candidate of candidates) {
    minUpdatedAtMillis = Math.min(
      minUpdatedAtMillis,
      candidate.updatedAtMillis
    );
    maxUpdatedAtMillis = Math.max(
      maxUpdatedAtMillis,
      candidate.updatedAtMillis
    );
    if (candidate.expiresAtMillis !== null) {
      maxRemainingLifespanMillis = Math.max(
        maxRemainingLifespanMillis,
        Math.max(0, candidate.expiresAtMillis - candidate.updatedAtMillis)
      );
    }
  }

  return {
    minUpdatedAtMillis,
    maxUpdatedAtMillis,
    maxRemainingLifespanMillis,
  };
};

const computeDecaySignal = (
  context: DecaySignalContext,
  updatedAtMillis: number,
  expiresAtMillis: number | null
): number => {
  const recencySignal =
    context.maxUpdatedAtMillis === context.minUpdatedAtMillis
      ? 1
      : (updatedAtMillis - context.minUpdatedAtMillis) /
        (context.maxUpdatedAtMillis - context.minUpdatedAtMillis);

  let expirySignal = 1;
  if (expiresAtMillis !== null) {
    const remainingLifespanMillis = Math.max(
      0,
      expiresAtMillis - updatedAtMillis
    );
    expirySignal =
      context.maxRemainingLifespanMillis > 0
        ? remainingLifespanMillis / context.maxRemainingLifespanMillis
        : 1;
  }

  return clampScore(recencySignal * 0.7 + expirySignal * 0.3);
};

const computeRankingScore = (
  rankingWeights: NormalizedRankingWeights,
  rankingSignals: RankingSignals
): number =>
  clampScore(
    rankingWeights.relevance * rankingSignals.relevance +
      rankingWeights.evidenceStrength * rankingSignals.evidenceStrength +
      rankingWeights.decay * rankingSignals.decay +
      rankingWeights.humanWeight * rankingSignals.humanWeight +
      rankingWeights.utility * rankingSignals.utility
  );

const toRankingSignals = (
  payloadRecord: Record<string, unknown> | null,
  relevanceSignal: number
): Omit<RankingSignals, "decay"> => ({
  relevance: relevanceSignal,
  evidenceStrength: toEvidenceStrengthSignal(payloadRecord),
  humanWeight: toHumanWeightSignal(payloadRecord),
  utility: toUtilitySignal(payloadRecord),
});

const createPlannedHit = (
  candidate: PlannedHitCandidate,
  rankingWeights: NormalizedRankingWeights,
  decayContext: DecaySignalContext
): PlannedHit => {
  const decaySignal = computeDecaySignal(
    decayContext,
    candidate.updatedAtMillis,
    candidate.expiresAtMillis
  );
  const rankingSignals: RankingSignals = {
    ...candidate.rankingSignals,
    decay: decaySignal,
  };

  return {
    memoryId: candidate.memoryId,
    layer: candidate.layer,
    score: computeRankingScore(rankingWeights, rankingSignals),
    excerpt: candidate.excerpt,
    scopeId: candidate.scopeId,
    scopeLevel: candidate.scopeLevel,
    scopeRank: candidate.scopeRank,
    updatedAtMillis: candidate.updatedAtMillis,
    rankingSignals,
    chronology: candidate.chronology,
    reconciledMemoryIds: Object.freeze([]),
  };
};

const comparePlannedHits = (left: PlannedHit, right: PlannedHit): number => {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.scopeRank !== right.scopeRank) {
    return right.scopeRank - left.scopeRank;
  }
  if (left.updatedAtMillis !== right.updatedAtMillis) {
    return right.updatedAtMillis - left.updatedAtMillis;
  }
  return left.memoryId.localeCompare(right.memoryId);
};

const encodeCursor = (cursor: CursorPayload): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const decodeCursorOffset = (
  cursor: string | null | undefined,
  digest: string
): number => {
  if (cursor === undefined || cursor === null) {
    return 0;
  }
  if (cursor.length === 0) {
    throw new Error("cursor must be a non-empty base64url string.");
  }

  let decodedJson = "";
  try {
    decodedJson = Buffer.from(cursor, "base64url").toString("utf8");
  } catch (cause) {
    throw new Error(
      `cursor must be valid base64url: ${describeFailure(cause)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedJson);
  } catch (cause) {
    throw new Error(
      `cursor payload must be valid JSON: ${describeFailure(cause)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("cursor payload must decode to an object.");
  }

  if (parsed["v"] !== 1) {
    throw new Error("cursor payload version must equal 1.");
  }
  const cursorOffset = parsed["o"];
  if (
    typeof cursorOffset !== "number" ||
    !Number.isSafeInteger(cursorOffset) ||
    cursorOffset < 0
  ) {
    throw new Error(
      "cursor payload offset must be a non-negative safe integer."
    );
  }
  const cursorDigest = parsed["d"];
  if (typeof cursorDigest !== "string" || cursorDigest !== digest) {
    throw new Error(
      "cursor payload digest does not match the current retrieval query."
    );
  }

  return cursorOffset;
};

type StableDomainValue =
  | string
  | number
  | boolean
  | null
  | readonly StableDomainValue[]
  | { readonly [key: string]: StableDomainValue };

const toStableDomainValue = (value: unknown): StableDomainValue => {
  if (value === null) {
    return null;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toStableDomainValue(entry));
  }
  if (!isRecord(value)) {
    return String(value);
  }

  const sortedKeys = Object.keys(value).sort((left, right) =>
    left.localeCompare(right)
  );
  return Object.fromEntries(
    sortedKeys.map((key) => [key, toStableDomainValue(value[key])] as const)
  );
};

const toCursorDigest = (
  request: RetrievalRequest,
  selectors: NormalizedScopeSelectors,
  policy: NormalizedPolicyInput,
  scopeAuthorization: NormalizedScopeAuthorization | null,
  rankingWeights: NormalizedRankingWeights,
  queryNormalized: string
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        spaceId: request.spaceId,
        query: queryNormalized,
        projectId: selectors.projectId,
        roleId: selectors.roleId,
        userId: selectors.userId,
        actorId: policy.actorId,
        action: policy.action,
        evidenceIds: [...policy.evidenceIds].sort((left, right) =>
          left.localeCompare(right)
        ),
        policyContext: toStableDomainValue(policy.context),
        scopeAuthorization:
          scopeAuthorization === null
            ? null
            : {
                tenantId: scopeAuthorization.tenantId,
                projectIds: [...scopeAuthorization.allowedProjectIds].sort(
                  (left, right) => left.localeCompare(right)
                ),
                roleIds: [...scopeAuthorization.allowedRoleIds].sort(
                  (left, right) => left.localeCompare(right)
                ),
                userIds: [...scopeAuthorization.allowedUserIds].sort(
                  (left, right) => left.localeCompare(right)
                ),
              },
        rankingWeights,
      })
    )
    .digest("hex");

const resolveScopeSelectors = (
  request: RetrievalRequest
): NormalizedScopeSelectors => {
  const scope = request.scope;
  const roleId =
    scope?.roleId ??
    scope?.jobRoleId ??
    request.roleId ??
    request.jobRoleId ??
    null;

  return Object.freeze({
    projectId: scope?.projectId ?? request.projectId ?? null,
    roleId,
    userId: scope?.userId ?? request.userId ?? null,
  });
};

const resolveScopeAuthorization = (
  request: RetrievalRequest
): NormalizedScopeAuthorization | null => {
  const requestWithAliases = request as RetrievalRequest & {
    readonly scopeAuthorization?: ScopeAuthorizationInput;
    readonly scope_authorization?: ScopeAuthorizationInput;
  };
  const scopeAuthorizationInput =
    requestWithAliases.scopeAuthorization ??
    requestWithAliases.scope_authorization;
  if (scopeAuthorizationInput === undefined) {
    return null;
  }

  const allowedProjectIds = new Set([
    ...(scopeAuthorizationInput.projectIds ?? []),
    ...(scopeAuthorizationInput.project_ids ?? []),
  ]);
  const allowedRoleIds = new Set([
    ...(scopeAuthorizationInput.roleIds ?? []),
    ...(scopeAuthorizationInput.role_ids ?? []),
    ...(scopeAuthorizationInput.jobRoleIds ?? []),
    ...(scopeAuthorizationInput.job_role_ids ?? []),
  ]);
  const allowedUserIds = new Set([
    ...(scopeAuthorizationInput.userIds ?? []),
    ...(scopeAuthorizationInput.user_ids ?? []),
  ]);

  return Object.freeze({
    tenantId:
      scopeAuthorizationInput.tenantId ??
      scopeAuthorizationInput.tenant_id ??
      null,
    allowedProjectIds,
    allowedRoleIds,
    allowedUserIds,
  });
};

const resolveScopeAuthorizationSelectorDenyMessage = (
  request: RetrievalRequest,
  selectors: NormalizedScopeSelectors,
  scopeAuthorization: NormalizedScopeAuthorization | null
): string | null => {
  if (scopeAuthorization === null) {
    return null;
  }
  if (
    scopeAuthorization.tenantId !== null &&
    scopeAuthorization.tenantId !== request.spaceId
  ) {
    return `Scope authorization denied retrieval tenant "${request.spaceId}".`;
  }
  if (
    selectors.projectId !== null &&
    !scopeAuthorization.allowedProjectIds.has(selectors.projectId)
  ) {
    return `Scope authorization denied retrieval selector projectId "${selectors.projectId}".`;
  }
  if (
    selectors.roleId !== null &&
    !scopeAuthorization.allowedRoleIds.has(selectors.roleId)
  ) {
    return `Scope authorization denied retrieval selector roleId "${selectors.roleId}".`;
  }
  if (
    selectors.userId !== null &&
    !scopeAuthorization.allowedUserIds.has(selectors.userId)
  ) {
    return `Scope authorization denied retrieval selector userId "${selectors.userId}".`;
  }

  return null;
};

const isScopeRowAuthorizedByMatrix = (
  scopeRow: ParsedScopeRow,
  scopeAuthorization: NormalizedScopeAuthorization
): boolean => {
  switch (scopeRow.scopeLevel) {
    case "common":
      return true;
    case "project":
      return (
        scopeRow.projectId !== null &&
        scopeAuthorization.allowedProjectIds.has(scopeRow.projectId)
      );
    case "job_role":
      return (
        scopeRow.roleId !== null &&
        scopeAuthorization.allowedRoleIds.has(scopeRow.roleId)
      );
    case "user":
      return (
        scopeRow.userId !== null &&
        scopeAuthorization.allowedUserIds.has(scopeRow.userId)
      );
    default:
      return false;
  }
};

const resolvePolicyInput = (
  request: RetrievalRequest,
  selectors: NormalizedScopeSelectors
): NormalizedPolicyInput => {
  const requestPolicy: RetrievalPolicyInput | undefined = request.policy;
  const baseContext =
    requestPolicy?.context ?? request.policyContext ?? emptyPolicyContext;

  return {
    actorId: requestPolicy?.actorId ?? request.actorId ?? defaultPolicyActorId,
    action: requestPolicy?.action ?? request.action ?? defaultPolicyAction,
    evidenceIds:
      requestPolicy?.evidenceIds ??
      request.evidenceIds ??
      emptyPolicyEvidenceIds,
    context: {
      ...baseContext,
      retrievalQuery: request.query,
      retrievalScopeProjectId: selectors.projectId,
      retrievalScopeRoleId: selectors.roleId,
      retrievalScopeUserId: selectors.userId,
    },
  };
};

const normalizeRetrievalRequest = (
  request: RetrievalRequest
): NormalizedRetrievalRequest => {
  const queryNormalized = request.query.trim().toLowerCase();
  const selectors = resolveScopeSelectors(request);
  const scopeAuthorization = resolveScopeAuthorization(request);
  const policy = resolvePolicyInput(request, selectors);
  const rankingWeights = resolveRankingWeights(request);

  return {
    request,
    selectors,
    policy,
    scopeAuthorization,
    scopeAuthorizationSelectorDenyMessage:
      resolveScopeAuthorizationSelectorDenyMessage(
        request,
        selectors,
        scopeAuthorization
      ),
    rankingWeights,
    queryNormalized,
    queryTokens: tokenize(queryNormalized),
  };
};

const resolveAllowedScopeIds = (
  scopeRows: readonly ParsedScopeRow[],
  selectors: NormalizedScopeSelectors,
  scopeAuthorization: NormalizedScopeAuthorization | null
): ReadonlySet<string> => {
  const scopeById = new Map(
    scopeRows.map((row) => [row.scopeId, row] as const)
  );
  const childScopeIdsByParent = new Map<string, string[]>();
  for (const scopeRow of scopeRows) {
    if (scopeRow.parentScopeId === null) {
      continue;
    }
    const existingChildren = childScopeIdsByParent.get(scopeRow.parentScopeId);
    if (existingChildren === undefined) {
      childScopeIdsByParent.set(scopeRow.parentScopeId, [scopeRow.scopeId]);
      continue;
    }
    existingChildren.push(scopeRow.scopeId);
  }
  const allowedScopeIds = new Set<string>();
  const hasExplicitScopeSelector =
    selectors.projectId !== null ||
    selectors.roleId !== null ||
    selectors.userId !== null;

  if (!hasExplicitScopeSelector) {
    for (const scopeRow of scopeRows) {
      allowedScopeIds.add(scopeRow.scopeId);
    }
  } else {
    const selectorSeedScopeIds = new Set<string>();
    for (const scopeRow of scopeRows) {
      if (scopeRow.scopeLevel === "common") {
        allowedScopeIds.add(scopeRow.scopeId);
        continue;
      }
      if (
        selectors.projectId !== null &&
        scopeRow.scopeLevel === "project" &&
        scopeRow.projectId === selectors.projectId
      ) {
        allowedScopeIds.add(scopeRow.scopeId);
        selectorSeedScopeIds.add(scopeRow.scopeId);
        continue;
      }
      if (
        selectors.roleId !== null &&
        scopeRow.scopeLevel === "job_role" &&
        scopeRow.roleId === selectors.roleId
      ) {
        allowedScopeIds.add(scopeRow.scopeId);
        selectorSeedScopeIds.add(scopeRow.scopeId);
        continue;
      }
      if (
        selectors.userId !== null &&
        scopeRow.scopeLevel === "user" &&
        scopeRow.userId === selectors.userId
      ) {
        allowedScopeIds.add(scopeRow.scopeId);
        selectorSeedScopeIds.add(scopeRow.scopeId);
      }
    }

    const ancestorQueue = [...allowedScopeIds];
    while (ancestorQueue.length > 0) {
      const scopeId = ancestorQueue.pop();
      if (scopeId === undefined) {
        continue;
      }

      const row = scopeById.get(scopeId);
      if (
        row === undefined ||
        row.parentScopeId === null ||
        allowedScopeIds.has(row.parentScopeId)
      ) {
        continue;
      }
      allowedScopeIds.add(row.parentScopeId);
      ancestorQueue.push(row.parentScopeId);
    }

    const descendantQueue = [...selectorSeedScopeIds];
    while (descendantQueue.length > 0) {
      const scopeId = descendantQueue.pop();
      if (scopeId === undefined) {
        continue;
      }
      const childScopeIds = childScopeIdsByParent.get(scopeId) ?? [];
      for (const childScopeId of childScopeIds) {
        if (allowedScopeIds.has(childScopeId)) {
          continue;
        }
        allowedScopeIds.add(childScopeId);
        descendantQueue.push(childScopeId);
      }
    }
  }

  if (scopeAuthorization === null) {
    return allowedScopeIds;
  }

  const matrixAllowedScopeIds = new Set<string>();
  for (const scopeRow of scopeRows) {
    if (isScopeRowAuthorizedByMatrix(scopeRow, scopeAuthorization)) {
      matrixAllowedScopeIds.add(scopeRow.scopeId);
    }
  }

  const restrictedScopeIds = new Set<string>();
  for (const scopeId of allowedScopeIds) {
    if (matrixAllowedScopeIds.has(scopeId)) {
      restrictedScopeIds.add(scopeId);
    }
  }

  return restrictedScopeIds;
};

const buildPlannedHits = (
  normalized: NormalizedRetrievalRequest,
  scopeRows: readonly ParsedScopeRow[],
  memoryRows: readonly ParsedMemoryRow[]
): readonly PlannedHit[] => {
  const scopeById = new Map(
    scopeRows.map((row) => [row.scopeId, row] as const)
  );
  const allowedScopeIds = resolveAllowedScopeIds(
    scopeRows,
    normalized.selectors,
    normalized.scopeAuthorization
  );
  const candidateHits: PlannedHitCandidate[] = [];

  for (const memoryRow of memoryRows) {
    if (memoryRow.status !== "active") {
      continue;
    }
    if (memoryRow.tombstonedAtMillis !== null) {
      continue;
    }
    if (
      memoryRow.expiresAtMillis !== null &&
      memoryRow.expiresAtMillis <= memoryRow.updatedAtMillis
    ) {
      continue;
    }
    if (!allowedScopeIds.has(memoryRow.scopeId)) {
      continue;
    }

    const scopeRow = scopeById.get(memoryRow.scopeId);
    if (scopeRow === undefined) {
      throw new Error(
        `Memory ${memoryRow.memoryId} references scope ${memoryRow.scopeId} which is missing from the snapshot.`
      );
    }

    const payloadRecord = parsePayloadRecord(memoryRow.payloadJson);
    const excerpt = toExcerpt(memoryRow.title, payloadRecord);
    const searchableText =
      `${memoryRow.title}\n${excerpt}\n${memoryRow.payloadJson}`.toLowerCase();
    const scopeRank = toScopeRank(scopeRow.scopeLevel);
    const relevanceSignal = computeQueryRelevanceSignal(
      normalized.queryTokens,
      normalized.queryNormalized,
      searchableText
    );
    if (relevanceSignal === null) {
      continue;
    }
    const rankingSignals = toRankingSignals(payloadRecord, relevanceSignal);
    const chronology = toHitChronology(payloadRecord, memoryRow.memoryId);

    candidateHits.push({
      memoryId: memoryRow.memoryId,
      layer: memoryRow.layer,
      excerpt,
      scopeId: memoryRow.scopeId,
      scopeLevel: scopeRow.scopeLevel,
      scopeRank,
      updatedAtMillis: memoryRow.updatedAtMillis,
      expiresAtMillis: memoryRow.expiresAtMillis,
      rankingSignals,
      chronology,
    });
  }

  const decayContext = buildDecaySignalContext(candidateHits);
  const plannedHits = candidateHits.map((candidate) =>
    createPlannedHit(candidate, normalized.rankingWeights, decayContext)
  );
  plannedHits.sort(comparePlannedHits);
  return Object.freeze(plannedHits);
};

const isPolicyDeniedError = (error: unknown): boolean =>
  isRecord(error) && error["_tag"] === "PolicyDeniedError";

const buildPolicyContextForHit = (
  policyContext: PolicyRequest["context"],
  hit: PlannedHit
): PolicyRequest["context"] => ({
  ...policyContext,
  retrievalHitScopeId: hit.scopeId,
  retrievalHitScopeLevel: hit.scopeLevel,
  retrievalHitLayer: hit.layer,
});

const filterDeniedHits = (
  normalized: NormalizedRetrievalRequest,
  policyService: PolicyService,
  plannedHits: readonly PlannedHit[]
): Effect.Effect<readonly PlannedHit[], RetrievalQueryError> =>
  Effect.forEach(
    plannedHits,
    (hit) =>
      policyService
        .evaluate({
          spaceId: normalized.request.spaceId,
          actorId: normalized.policy.actorId,
          action: normalized.policy.action,
          resourceId: hit.memoryId,
          evidenceIds: normalized.policy.evidenceIds,
          context: buildPolicyContextForHit(normalized.policy.context, hit),
        })
        .pipe(
          Effect.map((policyResult) =>
            policyResult.decision === "deny" ? null : hit
          ),
          Effect.catchAll((error) =>
            isPolicyDeniedError(error)
              ? Effect.succeed(null)
              : Effect.fail(
                  toRetrievalQueryError(
                    normalized.request,
                    `Policy evaluation failed for memory ${hit.memoryId}: ${describeFailure(error)}`
                  )
                )
          )
        ),
    { concurrency: 1 }
  ).pipe(
    Effect.map((maybeHits) =>
      maybeHits.filter((hit): hit is PlannedHit => hit !== null)
    )
  );

const compareTimelineTruthPriority = (
  left: PlannedHit,
  right: PlannedHit
): number => {
  if (left.updatedAtMillis !== right.updatedAtMillis) {
    return right.updatedAtMillis - left.updatedAtMillis;
  }
  return comparePlannedHits(left, right);
};

const reconcileContradictoryHits = (
  hits: readonly PlannedHit[]
): readonly PlannedHit[] => {
  if (hits.length < 2) {
    return hits;
  }

  const hitById = new Map(hits.map((hit) => [hit.memoryId, hit] as const));
  const conflictNeighborsByMemoryId = new Map<
    RetrievalHit["memoryId"],
    Set<RetrievalHit["memoryId"]>
  >();
  for (const hit of hits) {
    conflictNeighborsByMemoryId.set(hit.memoryId, new Set());
  }

  for (const hit of hits) {
    const sourceNeighbors = conflictNeighborsByMemoryId.get(hit.memoryId);
    if (sourceNeighbors === undefined) {
      continue;
    }

    const conflictMemoryIds = [
      ...hit.chronology.contradictsMemoryIds,
      ...hit.chronology.supersedesMemoryIds,
    ];
    for (const conflictMemoryId of conflictMemoryIds) {
      if (conflictMemoryId === hit.memoryId || !hitById.has(conflictMemoryId)) {
        continue;
      }
      sourceNeighbors.add(conflictMemoryId);
      conflictNeighborsByMemoryId.get(conflictMemoryId)?.add(hit.memoryId);
    }
  }

  const visited = new Set<RetrievalHit["memoryId"]>();
  const reconciledHits: PlannedHit[] = [];

  for (const hit of hits) {
    if (visited.has(hit.memoryId)) {
      continue;
    }

    const componentMemoryIds: RetrievalHit["memoryId"][] = [];
    const queue: RetrievalHit["memoryId"][] = [hit.memoryId];
    visited.add(hit.memoryId);

    while (queue.length > 0) {
      const currentMemoryId = queue.pop();
      if (currentMemoryId === undefined) {
        continue;
      }
      componentMemoryIds.push(currentMemoryId);
      const neighbors = conflictNeighborsByMemoryId.get(currentMemoryId);
      if (neighbors === undefined) {
        continue;
      }
      for (const neighborMemoryId of neighbors) {
        if (visited.has(neighborMemoryId)) {
          continue;
        }
        visited.add(neighborMemoryId);
        queue.push(neighborMemoryId);
      }
    }

    const componentHits = componentMemoryIds
      .map((memoryId) => hitById.get(memoryId))
      .filter((candidate): candidate is PlannedHit => candidate !== undefined);
    const firstComponentHit = componentHits[0];
    if (firstComponentHit === undefined) {
      continue;
    }
    if (componentHits.length === 1) {
      reconciledHits.push(firstComponentHit);
      continue;
    }

    componentHits.sort(compareTimelineTruthPriority);
    const winner = componentHits[0];
    if (winner === undefined) {
      continue;
    }
    const reconciledMemoryIds = toSortedMemoryIds([
      ...winner.reconciledMemoryIds,
      ...componentHits.slice(1).map((candidate) => candidate.memoryId),
    ]);
    reconciledHits.push({
      ...winner,
      reconciledMemoryIds,
    });
  }

  reconciledHits.sort(comparePlannedHits);
  return Object.freeze(reconciledHits);
};

const toRetrievalHit = (hit: PlannedHit): RetrievalHit => {
  const chronologyMetadata = {
    contradictsMemoryIds: hit.chronology.contradictsMemoryIds,
    supersedesMemoryIds: hit.chronology.supersedesMemoryIds,
    reconciledMemoryIds: hit.reconciledMemoryIds,
  };

  if (
    chronologyMetadata.contradictsMemoryIds.length === 0 &&
    chronologyMetadata.supersedesMemoryIds.length === 0 &&
    chronologyMetadata.reconciledMemoryIds.length === 0
  ) {
    return {
      memoryId: hit.memoryId,
      layer: hit.layer,
      score: hit.score,
      excerpt: hit.excerpt,
    };
  }

  return {
    memoryId: hit.memoryId,
    layer: hit.layer,
    score: hit.score,
    excerpt: hit.excerpt,
    metadata: {
      chronology: chronologyMetadata,
    },
  };
};

type RankingSignalKey = keyof RankingSignals;
const rankingSignalOrder: readonly RankingSignalKey[] = Object.freeze([
  "relevance",
  "evidenceStrength",
  "decay",
  "humanWeight",
  "utility",
]);

const hasExplicitScopeSelectors = (
  selectors: NormalizedScopeSelectors
): boolean =>
  selectors.projectId !== null ||
  selectors.roleId !== null ||
  selectors.userId !== null;

const toScopeLevelReasonCode = (
  scopeLevel: ScopeLevel
): RetrievalExplainabilityReasonCode => {
  switch (scopeLevel) {
    case "common":
      return "SCOPE_LEVEL_COMMON";
    case "project":
      return "SCOPE_LEVEL_PROJECT";
    case "job_role":
      return "SCOPE_LEVEL_JOB_ROLE";
    case "user":
      return "SCOPE_LEVEL_USER";
    default:
      return "SCOPE_LEVEL_COMMON";
  }
};

const toExplainabilityReasonCodes = (
  normalized: NormalizedRetrievalRequest,
  hit: PlannedHit
): readonly RetrievalExplainabilityReasonCode[] => {
  const reasonCodes: RetrievalExplainabilityReasonCode[] = [];
  reasonCodes.push(
    normalized.queryTokens.length > 0
      ? "QUERY_TOKEN_MATCH"
      : "QUERY_EMPTY_FALLBACK"
  );
  reasonCodes.push("SCOPE_FILTER_MATCH");
  if (hasExplicitScopeSelectors(normalized.selectors)) {
    reasonCodes.push("SCOPE_SELECTOR_APPLIED");
  }
  reasonCodes.push(toScopeLevelReasonCode(hit.scopeLevel));
  reasonCodes.push("POLICY_ALLOW");
  reasonCodes.push("RANKING_WEIGHTED_SIGNALS");
  if (hit.reconciledMemoryIds.length > 0) {
    reasonCodes.push("CHRONOLOGY_RECONCILED");
  }
  return Object.freeze(reasonCodes);
};

const toExplainabilityWeightedContributions = (
  rankingWeights: NormalizedRankingWeights,
  rankingSignals: RankingSignals
): RetrievalExplainabilityHit["weightedContributions"] =>
  Object.freeze(
    rankingSignalOrder.map((signal) => ({
      signal,
      signalScore: rankingSignals[signal],
      weight: rankingWeights[signal],
      weightedContribution: clampScore(
        rankingWeights[signal] * rankingSignals[signal]
      ),
    }))
  );

const toRetrievalExplainabilityHit = (
  normalized: NormalizedRetrievalRequest,
  hit: PlannedHit,
  rank: number
): RetrievalExplainabilityHit => ({
  memoryId: hit.memoryId,
  layer: hit.layer,
  score: hit.score,
  excerpt: hit.excerpt,
  rank,
  scopeId: hit.scopeId,
  scopeLevel: hit.scopeLevel,
  reasonCodes: toExplainabilityReasonCodes(normalized, hit),
  rankingSignals: {
    relevance: hit.rankingSignals.relevance,
    evidenceStrength: hit.rankingSignals.evidenceStrength,
    decay: hit.rankingSignals.decay,
    humanWeight: hit.rankingSignals.humanWeight,
    utility: hit.rankingSignals.utility,
  },
  weightedContributions: toExplainabilityWeightedContributions(
    normalized.rankingWeights,
    hit.rankingSignals
  ),
});

const toRetrievalExplainabilityResponse = (
  normalized: NormalizedRetrievalRequest,
  pagination: PaginatedPlannedHits
): RetrievalExplainabilityResponse => ({
  hits: Object.freeze(
    pagination.pageHits.map((hit, pageIndex) =>
      toRetrievalExplainabilityHit(
        normalized,
        hit,
        pagination.offset + pageIndex + 1
      )
    )
  ),
  totalHits: pagination.totalHits,
  nextCursor: pagination.nextCursor,
});

const actionablePackCategoryOrder: readonly ActionablePackCategory[] =
  Object.freeze(["do", "dont", "examples", "risks"]);

const dontCategoryPattern =
  /(?:^|\b)(?:do\s+not|don't|never|avoid|stop|skip)\b/i;
const examplesCategoryPattern =
  /(?:^|\b)(?:example|for\s+example|e\.g\.|sample|scenario)\b/i;
const risksCategoryPattern =
  /(?:^|\b)(?:risk|warning|caution|hazard|pitfall|failure)\b/i;
const doCategoryPattern =
  /(?:^|\b)(?:do|ensure|prefer|use|always|verify|confirm|check|apply|document|test)\b/i;

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const estimateTokenCount = (value: string): number => {
  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) {
    return 0;
  }
  return normalized.split(" ").length;
};

const toBoundedActionableText = (
  value: string,
  tokenLimit: number,
  characterLimit: number
): BoundedActionableText => {
  const withoutListPrefix = normalizeWhitespace(value)
    .replace(/^[-*0-9.)]+\s+/, "")
    .trim();
  if (withoutListPrefix.length === 0) {
    return {
      value: null,
      tokenCount: 0,
      truncated: false,
    };
  }

  let boundedText = withoutListPrefix;
  let truncated = false;
  if (boundedText.length > characterLimit) {
    boundedText = `${boundedText.slice(0, Math.max(0, characterLimit - 3)).trimEnd()}...`;
    truncated = true;
  }
  const tokens = boundedText.split(" ");
  if (tokens.length > tokenLimit) {
    boundedText = `${tokens.slice(0, tokenLimit).join(" ")}...`;
    truncated = true;
  }
  const normalized = normalizeWhitespace(boundedText);
  if (normalized.length === 0) {
    return {
      value: null,
      tokenCount: 0,
      truncated,
    };
  }
  return {
    value: normalized,
    tokenCount: estimateTokenCount(normalized),
    truncated,
  };
};

const routeActionableCategory = (
  line: string,
  layer: RetrievalHit["layer"]
): ActionablePackCategory => {
  if (dontCategoryPattern.test(line)) {
    return "dont";
  }
  if (examplesCategoryPattern.test(line)) {
    return "examples";
  }
  if (risksCategoryPattern.test(line)) {
    return "risks";
  }
  if (doCategoryPattern.test(line)) {
    return "do";
  }
  if (layer === "episodic") {
    return "examples";
  }
  return "do";
};

const createCategoryCounter = (): Record<ActionablePackCategory, number> => ({
  do: 0,
  dont: 0,
  examples: 0,
  risks: 0,
});

const createMutableActionablePack = (): MutableActionablePack => ({
  do: [],
  dont: [],
  examples: [],
  risks: [],
  sources: [],
  warnings: [],
});

const estimateActionableSourceTokens = (source: ActionablePackSource): number =>
  estimateTokenCount(source.memoryId) +
  estimateTokenCount(source.excerpt) +
  estimateTokenCount(source.metadata.layer) +
  1;

const toActionablePackWarnings = (
  stats: ActionablePackCompilerStats
): readonly string[] => {
  const warnings: string[] = [];
  if (stats.tokenBudgetDrops > 0) {
    warnings.push(
      `Actionable pack token budget (${actionablePackTokenBudget}) reached; additional content was omitted.`
    );
  }
  const cappedCategories = actionablePackCategoryOrder.filter(
    (category) => stats.categoryLimitDrops[category] > 0
  );
  if (cappedCategories.length > 0) {
    warnings.push(
      `Actionable pack category limits (${actionablePackPerCategoryLimit}) reached for ${cappedCategories.join(", ")}.`
    );
  }
  if (stats.sourceLimitDrops > 0) {
    warnings.push(
      `Actionable pack source limit (${actionablePackSourceLimit}) reached; additional sources were omitted.`
    );
  }
  if (stats.lineTruncations > 0 || stats.sourceExcerptTruncations > 0) {
    warnings.push(
      "Long excerpts were shortened to keep actionable output bounded."
    );
  }
  return Object.freeze(warnings);
};

const toActionablePackAnnotationWarnings = (
  sourceSignals: readonly ActionablePackWarningSignal[]
): readonly string[] => {
  const firstSourceSignal = sourceSignals[0];
  if (firstSourceSignal === undefined) {
    return Object.freeze([]);
  }

  let freshestUpdatedAtMillis = firstSourceSignal.updatedAtMillis;
  let staleSourceCount = 0;
  let lowConfidenceSourceCount = 0;

  for (const sourceSignal of sourceSignals) {
    freshestUpdatedAtMillis = Math.max(
      freshestUpdatedAtMillis,
      sourceSignal.updatedAtMillis
    );
    if (sourceSignal.score < actionablePackLowConfidenceScoreThreshold) {
      lowConfidenceSourceCount += 1;
    }
  }

  for (const sourceSignal of sourceSignals) {
    if (
      freshestUpdatedAtMillis - sourceSignal.updatedAtMillis >=
      actionablePackStaleAgeGapMillis
    ) {
      staleSourceCount += 1;
    }
  }

  const warnings: string[] = [];
  if (staleSourceCount > 0) {
    warnings.push(
      `Actionable pack includes stale guidance; ${staleSourceCount} source${staleSourceCount === 1 ? "" : "s"} ${staleSourceCount === 1 ? "is" : "are"} older than the freshest source.`
    );
  }
  if (lowConfidenceSourceCount > 0) {
    warnings.push(
      `Actionable pack includes low-confidence guidance; ${lowConfidenceSourceCount} source${lowConfidenceSourceCount === 1 ? "" : "s"} scored below ${actionablePackLowConfidenceScoreThreshold.toFixed(2)}.`
    );
  }

  return Object.freeze(warnings);
};

const finalizeActionablePack = (
  pack: MutableActionablePack
): ActionableRetrievalPack => ({
  do: Object.freeze([...pack.do]),
  dont: Object.freeze([...pack.dont]),
  examples: Object.freeze([...pack.examples]),
  risks: Object.freeze([...pack.risks]),
  sources: Object.freeze(
    pack.sources.map((source) => ({
      memoryId: source.memoryId,
      excerpt: source.excerpt,
      metadata: {
        score: source.metadata.score,
        layer: source.metadata.layer,
      },
    }))
  ),
  warnings: Object.freeze([...pack.warnings]),
});

const compileActionablePack = (
  hits: readonly PlannedHit[]
): ActionableRetrievalPack => {
  const pack = createMutableActionablePack();
  const seenLineKeys = new Set<string>();
  const sourceSignals: ActionablePackWarningSignal[] = [];
  const stats: ActionablePackCompilerStats = {
    categoryLimitDrops: createCategoryCounter(),
    tokenBudgetDrops: 0,
    sourceLimitDrops: 0,
    lineTruncations: 0,
    sourceExcerptTruncations: 0,
  };
  let contentTokens = 0;

  for (const hit of hits) {
    const boundedLine = toBoundedActionableText(
      hit.excerpt,
      actionablePackLineTokenLimit,
      actionablePackTextCharacterLimit
    );
    if (boundedLine.value !== null) {
      const category = routeActionableCategory(boundedLine.value, hit.layer);
      if (pack[category].length >= actionablePackPerCategoryLimit) {
        stats.categoryLimitDrops[category] += 1;
      } else {
        const lineKey = `${category}:${boundedLine.value.toLowerCase()}`;
        if (!seenLineKeys.has(lineKey)) {
          const nextContentTokenCount = contentTokens + boundedLine.tokenCount;
          if (nextContentTokenCount <= actionablePackContentTokenBudget) {
            pack[category].push(boundedLine.value);
            seenLineKeys.add(lineKey);
            contentTokens = nextContentTokenCount;
            if (boundedLine.truncated) {
              stats.lineTruncations += 1;
            }
          } else {
            stats.tokenBudgetDrops += 1;
          }
        }
      }
    }

    if (pack.sources.length >= actionablePackSourceLimit) {
      stats.sourceLimitDrops += 1;
      continue;
    }
    const boundedSourceExcerpt = toBoundedActionableText(
      hit.excerpt,
      actionablePackSourceExcerptTokenLimit,
      actionablePackTextCharacterLimit
    );
    if (boundedSourceExcerpt.value === null) {
      continue;
    }
    const source: ActionablePackSource = {
      memoryId: hit.memoryId,
      excerpt: boundedSourceExcerpt.value,
      metadata: {
        score: hit.score,
        layer: hit.layer,
      },
    };
    const nextContentTokenCount =
      contentTokens + estimateActionableSourceTokens(source);
    if (nextContentTokenCount > actionablePackContentTokenBudget) {
      stats.tokenBudgetDrops += 1;
      continue;
    }
    pack.sources.push(source);
    sourceSignals.push({
      updatedAtMillis: hit.updatedAtMillis,
      score: hit.score,
    });
    contentTokens = nextContentTokenCount;
    if (boundedSourceExcerpt.truncated) {
      stats.sourceExcerptTruncations += 1;
    }
  }

  const warningCandidates = Object.freeze([
    ...toActionablePackAnnotationWarnings(sourceSignals),
    ...toActionablePackWarnings(stats),
  ]);
  let warningTokens = 0;
  for (const warningCandidate of warningCandidates) {
    if (pack.warnings.length >= actionablePackWarningLimit) {
      break;
    }
    const boundedWarning = toBoundedActionableText(
      warningCandidate,
      actionablePackWarningTokenLimit,
      actionablePackTextCharacterLimit
    );
    if (boundedWarning.value === null) {
      continue;
    }
    const nextWarningTokenCount = warningTokens + boundedWarning.tokenCount;
    if (nextWarningTokenCount > actionablePackWarningTokenBudget) {
      break;
    }
    if (contentTokens + nextWarningTokenCount > actionablePackTokenBudget) {
      break;
    }
    pack.warnings.push(boundedWarning.value);
    warningTokens = nextWarningTokenCount;
  }

  return finalizeActionablePack(pack);
};

const paginateHits = (
  normalized: NormalizedRetrievalRequest,
  hits: readonly PlannedHit[]
): PaginatedPlannedHits => {
  const digest = toCursorDigest(
    normalized.request,
    normalized.selectors,
    normalized.policy,
    normalized.scopeAuthorization,
    normalized.rankingWeights,
    normalized.queryNormalized
  );
  const offset = decodeCursorOffset(normalized.request.cursor, digest);
  const totalHits = hits.length;
  const boundedOffset = Math.min(offset, totalHits);
  const limit = normalized.request.limit;
  const pageHits =
    limit === 0
      ? []
      : hits.slice(boundedOffset, Math.min(totalHits, boundedOffset + limit));
  const nextOffset = boundedOffset + pageHits.length;
  const nextCursor =
    limit > 0 && nextOffset < totalHits
      ? encodeCursor({
          v: 1,
          o: nextOffset,
          d: digest,
        })
      : null;

  return {
    pageHits: Object.freeze(pageHits),
    totalHits,
    nextCursor,
    offset: boundedOffset,
  };
};

const toRetrievalResponse = (
  pagination: PaginatedPlannedHits
): RetrievalResponse => ({
  hits: pagination.pageHits.map(toRetrievalHit),
  totalHits: pagination.totalHits,
  nextCursor: pagination.nextCursor,
  actionablePack: compileActionablePack(pagination.pageHits),
});

const planRetrieval = (
  normalized: NormalizedRetrievalRequest,
  policyService: PolicyService,
  snapshot: SqliteStorageSnapshotData
): Effect.Effect<PaginatedPlannedHits, RetrievalQueryError> =>
  Effect.try({
    try: () => ({
      scopeRows: parseScopeRows(snapshot, normalized.request.spaceId),
      memoryRows: parseMemoryRows(snapshot, normalized.request.spaceId),
    }),
    catch: (cause) =>
      toRetrievalQueryError(
        normalized.request,
        `Snapshot projection failed for retrieval planner: ${describeFailure(cause)}`
      ),
  }).pipe(
    Effect.flatMap(({ scopeRows, memoryRows }) =>
      Effect.try({
        try: () => buildPlannedHits(normalized, scopeRows, memoryRows),
        catch: (cause) =>
          toRetrievalQueryError(
            normalized.request,
            `Retrieval scope planning failed: ${describeFailure(cause)}`
          ),
      })
    ),
    Effect.flatMap((plannedHits) =>
      filterDeniedHits(normalized, policyService, plannedHits)
    ),
    Effect.map((policyFilteredHits) =>
      reconcileContradictoryHits(policyFilteredHits)
    ),
    Effect.flatMap((reconciledHits) =>
      Effect.try({
        try: () => paginateHits(normalized, reconciledHits),
        catch: (cause) =>
          toRetrievalQueryError(
            normalized.request,
            `Retrieval pagination failed: ${describeFailure(cause)}`
          ),
      })
    )
  );

interface PlannedRetrievalResult {
  readonly normalized: NormalizedRetrievalRequest;
  readonly pagination: PaginatedPlannedHits;
}

const executeRetrievalPlan = (
  request: RetrievalRequest,
  storageService: StorageService,
  policyService: PolicyService,
  snapshotSignatureSecret: string
): Effect.Effect<PlannedRetrievalResult, RetrievalServiceError> =>
  decodeRetrievalRequestEffect(request).pipe(
    Effect.flatMap((decodedRequest) => {
      const normalized = normalizeRetrievalRequest(decodedRequest);
      if (normalized.scopeAuthorizationSelectorDenyMessage !== null) {
        return Effect.fail(
          toRetrievalQueryError(
            decodedRequest,
            normalized.scopeAuthorizationSelectorDenyMessage
          )
        );
      }
      return storageService
        .exportSnapshot({
          signatureSecret: snapshotSignatureSecret,
        })
        .pipe(
          Effect.mapError((error) =>
            toRetrievalQueryError(
              decodedRequest,
              `Storage snapshot export failed for retrieval planner: ${describeFailure(error)}`
            )
          ),
          Effect.flatMap((snapshotExport) =>
            Effect.try({
              try: () =>
                parseSqliteStorageSnapshotPayload(snapshotExport.payload),
              catch: (cause) =>
                toRetrievalQueryError(
                  decodedRequest,
                  `Snapshot payload parsing failed for retrieval planner: ${describeFailure(cause)}`
                ),
            })
          ),
          Effect.flatMap((snapshot) =>
            planRetrieval(normalized, policyService, snapshot)
          ),
          Effect.map((pagination) => ({
            normalized,
            pagination,
          }))
        );
    })
  );

const emptyPaginatedPlannedHits: PaginatedPlannedHits = Object.freeze({
  pageHits: Object.freeze([]),
  totalHits: 0,
  nextCursor: null,
  offset: 0,
});

export const makeNoopRetrievalService = (): RetrievalService => ({
  retrieve: () =>
    Effect.succeed(toRetrievalResponse(emptyPaginatedPlannedHits)),
  retrieveExplainability: () =>
    Effect.succeed({
      hits: [],
      totalHits: 0,
      nextCursor: null,
    }),
});

export const makeRetrievalService = (
  storageService: StorageService,
  policyService: PolicyService,
  options: RetrievalPlannerOptions = {}
): RetrievalService => {
  const snapshotSignatureSecret =
    options.snapshotSignatureSecret ?? defaultSnapshotSignatureSecret;

  return {
    retrieve: (request) =>
      executeRetrievalPlan(
        request,
        storageService,
        policyService,
        snapshotSignatureSecret
      ).pipe(Effect.map(({ pagination }) => toRetrievalResponse(pagination))),
    retrieveExplainability: (request) =>
      executeRetrievalPlan(
        request,
        storageService,
        policyService,
        snapshotSignatureSecret
      ).pipe(
        Effect.map(({ normalized, pagination }) =>
          toRetrievalExplainabilityResponse(normalized, pagination)
        )
      ),
  };
};

export const makePolicyAwareRetrievalService = makeRetrievalService;

export const __testOnly = Object.freeze({
  toActionablePackAnnotationWarnings,
});

export const noopRetrievalLayer: Layer.Layer<RetrievalService> = Layer.succeed(
  RetrievalServiceTag,
  makeNoopRetrievalService()
);

export const deterministicTestRetrievalLayer: Layer.Layer<RetrievalService> =
  noopRetrievalLayer;
