import {
  createAntiPattern,
  createCurriculumPlanItem,
  createIdentityGraphEdge,
  createLearnerProfile,
  createMisconceptionRecord,
  createPersonalizationPolicyDecision,
  createProceduralRule,
  createReviewScheduleEntry,
  createWorkingMemoryEntry,
  PersonalizationPolicyOutcome,
  ProceduralEntryStatus,
} from "./entities.js";
import { ContractViolationError, ValidationError } from "./errors.js";
import { asSortedUniqueStrings, deepClone, deepFreeze, stableStringify, toIsoTimestamp } from "./utils.js";

function compareByUpdatedThenIdDesc(left, right) {
  const updatedDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  return left.id.localeCompare(right.id);
}

function compareByCreatedThenIdDesc(left, right) {
  const createdDiff = right.createdAt.localeCompare(left.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return left.id.localeCompare(right.id);
}

function compareByRankThenUpdatedThenId(left, right) {
  const rankDiff = left.recommendationRank - right.recommendationRank;
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const updatedDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  return left.id.localeCompare(right.id);
}

function compareByDueThenUpdatedThenId(left, right) {
  const dueDiff = left.dueAt.localeCompare(right.dueAt);
  if (dueDiff !== 0) {
    return dueDiff;
  }
  const updatedDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  return left.id.localeCompare(right.id);
}

function maxIsoTimestamp(...timestamps) {
  const values = timestamps.filter((timestamp) => typeof timestamp === "string" && timestamp.trim());
  if (values.length === 0) {
    return null;
  }
  return values.reduce((maxValue, value) => (value > maxValue ? value : maxValue));
}

function minIsoTimestamp(...timestamps) {
  const values = timestamps.filter((timestamp) => typeof timestamp === "string" && timestamp.trim());
  if (values.length === 0) {
    return null;
  }
  return values.reduce((minValue, value) => (value < minValue ? value : minValue));
}

function deterministicUnion(...collections) {
  return asSortedUniqueStrings(collections.flat());
}

function selectPreferredByUpdatedAt(existing, incoming) {
  const updatedDiff = incoming.updatedAt.localeCompare(existing.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff > 0 ? incoming : existing;
  }

  const incomingFingerprint = stableStringify(incoming);
  const existingFingerprint = stableStringify(existing);
  return incomingFingerprint.localeCompare(existingFingerprint) >= 0 ? incoming : existing;
}

function mergeMetadata(existingMetadata, incomingMetadata, preferIncoming) {
  if (preferIncoming) {
    return { ...existingMetadata, ...incomingMetadata };
  }
  return { ...incomingMetadata, ...existingMetadata };
}

function mergePolicyOutcome(leftOutcome, rightOutcome) {
  const weightByOutcome = {
    [PersonalizationPolicyOutcome.ALLOW]: 1,
    [PersonalizationPolicyOutcome.REVIEW]: 2,
    [PersonalizationPolicyOutcome.DENY]: 3,
  };
  return weightByOutcome[leftOutcome] >= weightByOutcome[rightOutcome] ? leftOutcome : rightOutcome;
}

export class ProceduralRepositoryContract {
  upsertRule() {
    throw new Error("upsertRule() not implemented");
  }

  getRuleById() {
    throw new Error("getRuleById() not implemented");
  }

  listRules() {
    throw new Error("listRules() not implemented");
  }

  upsertAntiPattern() {
    throw new Error("upsertAntiPattern() not implemented");
  }

  listAntiPatterns() {
    throw new Error("listAntiPatterns() not implemented");
  }
}

export class WorkingMemoryRepositoryContract {
  upsertEntry() {
    throw new Error("upsertEntry() not implemented");
  }

  getEntryById() {
    throw new Error("getEntryById() not implemented");
  }

  listEntries() {
    throw new Error("listEntries() not implemented");
  }
}

export class MemoryIndexContract {
  upsert() {
    throw new Error("upsert() not implemented");
  }

  search() {
    throw new Error("search() not implemented");
  }
}

export class LearnerProfileRepositoryContract {
  upsertProfile() {
    throw new Error("upsertProfile() not implemented");
  }

  getProfileById() {
    throw new Error("getProfileById() not implemented");
  }

  listProfiles() {
    throw new Error("listProfiles() not implemented");
  }
}

export class IdentityGraphRepositoryContract {
  upsertEdge() {
    throw new Error("upsertEdge() not implemented");
  }

  getEdgeById() {
    throw new Error("getEdgeById() not implemented");
  }

  listEdges() {
    throw new Error("listEdges() not implemented");
  }
}

export class MisconceptionRepositoryContract {
  upsertMisconception() {
    throw new Error("upsertMisconception() not implemented");
  }

  getMisconceptionById() {
    throw new Error("getMisconceptionById() not implemented");
  }

  listMisconceptions() {
    throw new Error("listMisconceptions() not implemented");
  }
}

export class CurriculumPlannerRepositoryContract {
  upsertPlanItem() {
    throw new Error("upsertPlanItem() not implemented");
  }

  getPlanItemById() {
    throw new Error("getPlanItemById() not implemented");
  }

  listPlanItems() {
    throw new Error("listPlanItems() not implemented");
  }
}

export class SpacedRepetitionRepositoryContract {
  upsertScheduleEntry() {
    throw new Error("upsertScheduleEntry() not implemented");
  }

  getScheduleEntryById() {
    throw new Error("getScheduleEntryById() not implemented");
  }

  listScheduleEntries() {
    throw new Error("listScheduleEntries() not implemented");
  }
}

export class PersonalizationPolicyRepositoryContract {
  upsertPolicyDecision() {
    throw new Error("upsertPolicyDecision() not implemented");
  }

  getPolicyDecisionById() {
    throw new Error("getPolicyDecisionById() not implemented");
  }

  listPolicyDecisions() {
    throw new Error("listPolicyDecisions() not implemented");
  }
}

export class MisconceptionIndexContract {
  upsert() {
    throw new Error("upsert() not implemented");
  }

  search() {
    throw new Error("search() not implemented");
  }
}

export class CurriculumPlannerIndexContract {
  upsert() {
    throw new Error("upsert() not implemented");
  }

  listRecommendations() {
    throw new Error("listRecommendations() not implemented");
  }
}

export class SpacedRepetitionIndexContract {
  upsert() {
    throw new Error("upsert() not implemented");
  }

  listDue() {
    throw new Error("listDue() not implemented");
  }
}

export class PersonalizationPolicyIndexContract {
  upsert() {
    throw new Error("upsert() not implemented");
  }

  search() {
    throw new Error("search() not implemented");
  }
}

export function assertProceduralRepositoryContract(repository) {
  const methods = ["upsertRule", "getRuleById", "listRules", "upsertAntiPattern", "listAntiPatterns"];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      throw new ContractViolationError("procedural repository contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertWorkingMemoryRepositoryContract(repository) {
  const methods = ["upsertEntry", "getEntryById", "listEntries", "countEntries"];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      throw new ContractViolationError("working memory repository contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertMemoryIndexContract(index) {
  const methods = ["upsert", "search"];
  for (const method of methods) {
    if (typeof index?.[method] !== "function") {
      throw new ContractViolationError("memory index contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertLearnerProfileRepositoryContract(repository) {
  const methods = ["upsertProfile", "getProfileById", "listProfiles", "countProfiles"];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      throw new ContractViolationError("learner profile repository contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertIdentityGraphRepositoryContract(repository) {
  const methods = ["upsertEdge", "getEdgeById", "listEdges", "countEdges"];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      throw new ContractViolationError("identity graph repository contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertMisconceptionRepositoryContract(repository) {
  const methods = ["upsertMisconception", "getMisconceptionById", "listMisconceptions", "countMisconceptions"];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      throw new ContractViolationError("misconception repository contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertCurriculumPlannerRepositoryContract(repository) {
  const methods = ["upsertPlanItem", "getPlanItemById", "listPlanItems", "countPlanItems"];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      throw new ContractViolationError("curriculum planner repository contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertSpacedRepetitionRepositoryContract(repository) {
  const methods = ["upsertScheduleEntry", "getScheduleEntryById", "listScheduleEntries", "countScheduleEntries"];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      throw new ContractViolationError("spaced repetition repository contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertPersonalizationPolicyRepositoryContract(repository) {
  const methods = ["upsertPolicyDecision", "getPolicyDecisionById", "listPolicyDecisions", "countPolicyDecisions"];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      throw new ContractViolationError("personalization policy repository contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertMisconceptionIndexContract(index) {
  const methods = ["upsert", "search"];
  for (const method of methods) {
    if (typeof index?.[method] !== "function") {
      throw new ContractViolationError("misconception index contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertCurriculumPlannerIndexContract(index) {
  const methods = ["upsert", "listRecommendations"];
  for (const method of methods) {
    if (typeof index?.[method] !== "function") {
      throw new ContractViolationError("curriculum planner index contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertSpacedRepetitionIndexContract(index) {
  const methods = ["upsert", "listDue"];
  for (const method of methods) {
    if (typeof index?.[method] !== "function") {
      throw new ContractViolationError("spaced repetition index contract violation", {
        missingMethod: method,
      });
    }
  }
}

export function assertPersonalizationPolicyIndexContract(index) {
  const methods = ["upsert", "search"];
  for (const method of methods) {
    if (typeof index?.[method] !== "function") {
      throw new ContractViolationError("personalization policy index contract violation", {
        missingMethod: method,
      });
    }
  }
}

export class InMemoryProceduralRepository extends ProceduralRepositoryContract {
  #rulesBySpace = new Map();
  #antiPatternsBySpace = new Map();

  #getSpaceRuleMap(spaceId) {
    const existing = this.#rulesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#rulesBySpace.set(spaceId, map);
    return map;
  }

  #getSpaceAntiPatternMap(spaceId) {
    const existing = this.#antiPatternsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#antiPatternsBySpace.set(spaceId, map);
    return map;
  }

  upsertRule(rawRule) {
    const incoming = createProceduralRule(rawRule);
    const rules = this.#getSpaceRuleMap(incoming.spaceId);
    const existing = rules.get(incoming.id);
    const merged = existing
      ? createProceduralRule({
          ...existing,
          ...incoming,
          id: existing.id,
          createdAt: existing.createdAt,
        })
      : incoming;
    rules.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  getRuleById(spaceId, ruleId) {
    const rule = this.#getSpaceRuleMap(spaceId).get(ruleId);
    return rule ? deepClone(rule) : null;
  }

  listRules(spaceId, options = {}) {
    const includeTombstoned = Boolean(options.includeTombstoned);
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;

    const rules = Array.from(this.#getSpaceRuleMap(spaceId).values())
      .filter((rule) => includeTombstoned || rule.status !== ProceduralEntryStatus.TOMBSTONED)
      .sort(compareByUpdatedThenIdDesc);

    return rules.slice(0, limit).map((rule) => deepClone(rule));
  }

  countRules(spaceId, options = {}) {
    return this.listRules(spaceId, { includeTombstoned: options.includeTombstoned, limit: Number.MAX_SAFE_INTEGER })
      .length;
  }

  upsertAntiPattern(rawAntiPattern) {
    const incoming = createAntiPattern(rawAntiPattern);
    const antiPatterns = this.#getSpaceAntiPatternMap(incoming.spaceId);
    antiPatterns.set(incoming.id, deepFreeze(deepClone(incoming)));
    return deepClone(incoming);
  }

  getAntiPatternById(spaceId, antiPatternId) {
    const antiPattern = this.#getSpaceAntiPatternMap(spaceId).get(antiPatternId);
    return antiPattern ? deepClone(antiPattern) : null;
  }

  listAntiPatterns(spaceId, options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;
    const antiPatterns = Array.from(this.#getSpaceAntiPatternMap(spaceId).values()).sort(
      compareByCreatedThenIdDesc,
    );
    return antiPatterns.slice(0, limit).map((antiPattern) => deepClone(antiPattern));
  }

  countAntiPatterns(spaceId) {
    return this.#getSpaceAntiPatternMap(spaceId).size;
  }
}

export class InMemoryWorkingMemoryRepository extends WorkingMemoryRepositoryContract {
  #entriesBySpace = new Map();

  #getSpaceEntryMap(spaceId) {
    const existing = this.#entriesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#entriesBySpace.set(spaceId, map);
    return map;
  }

  upsertEntry(rawEntry) {
    const entry = createWorkingMemoryEntry(rawEntry);
    this.#getSpaceEntryMap(entry.spaceId).set(entry.id, deepFreeze(deepClone(entry)));
    return deepClone(entry);
  }

  getEntryById(spaceId, entryId) {
    const entry = this.#getSpaceEntryMap(spaceId).get(entryId);
    return entry ? deepClone(entry) : null;
  }

  listEntries(spaceId, options = {}) {
    const kind = typeof options.kind === "string" ? options.kind : null;
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;

    const entries = Array.from(this.#getSpaceEntryMap(spaceId).values())
      .filter((entry) => (kind ? entry.kind === kind : true))
      .sort(compareByCreatedThenIdDesc);
    return entries.slice(0, limit).map((entry) => deepClone(entry));
  }

  countEntries(spaceId) {
    return this.#getSpaceEntryMap(spaceId).size;
  }
}

export class InMemoryLearnerProfileRepository extends LearnerProfileRepositoryContract {
  #profilesBySpace = new Map();

  #getSpaceProfileMap(spaceId) {
    const existing = this.#profilesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#profilesBySpace.set(spaceId, map);
    return map;
  }

  upsertProfile(rawProfile) {
    const incoming = createLearnerProfile(rawProfile);
    const profiles = this.#getSpaceProfileMap(incoming.spaceId);
    const existing = profiles.get(incoming.id);
    const merged = existing
      ? createLearnerProfile({
          ...existing,
          ...incoming,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: incoming.updatedAt,
          version: Math.max(existing.version, incoming.version),
          identityRefs: [...existing.identityRefs, ...incoming.identityRefs],
          goals: [...existing.goals, ...incoming.goals],
          interestTags: [...existing.interestTags, ...incoming.interestTags],
          misconceptionIds: [...existing.misconceptionIds, ...incoming.misconceptionIds],
          metadata: {
            ...existing.metadata,
            ...incoming.metadata,
          },
        })
      : incoming;

    profiles.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  getProfileById(spaceId, profileId) {
    const profile = this.#getSpaceProfileMap(spaceId).get(profileId);
    return profile ? deepClone(profile) : null;
  }

  listProfiles(spaceId, options = {}) {
    const status = typeof options.status === "string" ? options.status : null;
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;

    const profiles = Array.from(this.#getSpaceProfileMap(spaceId).values())
      .filter((profile) => (status ? profile.status === status : true))
      .sort(compareByUpdatedThenIdDesc);

    return profiles.slice(0, limit).map((profile) => deepClone(profile));
  }

  countProfiles(spaceId) {
    return this.#getSpaceProfileMap(spaceId).size;
  }
}

export class InMemoryIdentityGraphRepository extends IdentityGraphRepositoryContract {
  #edgesBySpace = new Map();

  #getSpaceEdgeMap(spaceId) {
    const existing = this.#edgesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#edgesBySpace.set(spaceId, map);
    return map;
  }

  upsertEdge(rawEdge) {
    const incoming = createIdentityGraphEdge(rawEdge);
    const edges = this.#getSpaceEdgeMap(incoming.spaceId);
    const existing = edges.get(incoming.id);
    const merged = existing
      ? createIdentityGraphEdge({
          ...existing,
          ...incoming,
          id: existing.id,
          createdAt: existing.createdAt,
          evidenceEpisodeIds: [...existing.evidenceEpisodeIds, ...incoming.evidenceEpisodeIds],
          metadata: {
            ...existing.metadata,
            ...incoming.metadata,
          },
        })
      : incoming;

    edges.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  getEdgeById(spaceId, edgeId) {
    const edge = this.#getSpaceEdgeMap(spaceId).get(edgeId);
    return edge ? deepClone(edge) : null;
  }

  listEdges(spaceId, options = {}) {
    const relation = typeof options.relation === "string" ? options.relation : null;
    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 200;

    const edges = Array.from(this.#getSpaceEdgeMap(spaceId).values())
      .filter((edge) => (relation ? edge.relation === relation : true))
      .filter((edge) => (profileId ? edge.profileId === profileId : true))
      .sort(compareByCreatedThenIdDesc);

    return edges.slice(0, limit).map((edge) => deepClone(edge));
  }

  countEdges(spaceId) {
    return this.#getSpaceEdgeMap(spaceId).size;
  }
}

function mergeMisconceptionRecords(existing, incoming) {
  const preferred = selectPreferredByUpdatedAt(existing, incoming);
  const preferIncoming = preferred === incoming;

  return createMisconceptionRecord({
    ...existing,
    ...incoming,
    ...preferred,
    id: existing.id,
    spaceId: existing.spaceId,
    profileId: existing.profileId,
    misconceptionKey: existing.misconceptionKey,
    createdAt: minIsoTimestamp(existing.createdAt, incoming.createdAt) ?? existing.createdAt,
    updatedAt: maxIsoTimestamp(existing.updatedAt, incoming.updatedAt) ?? preferred.updatedAt,
    lastSignalAt: maxIsoTimestamp(existing.lastSignalAt, incoming.lastSignalAt) ?? preferred.lastSignalAt,
    harmfulSignalCount: Math.max(existing.harmfulSignalCount, incoming.harmfulSignalCount),
    correctionSignalCount: Math.max(existing.correctionSignalCount, incoming.correctionSignalCount),
    conflictCount: Math.max(existing.conflictCount, incoming.conflictCount),
    evidenceEpisodeIds: deterministicUnion(existing.evidenceEpisodeIds, incoming.evidenceEpisodeIds),
    sourceSignalIds: deterministicUnion(existing.sourceSignalIds, incoming.sourceSignalIds),
    conflictEpisodeIds: deterministicUnion(existing.conflictEpisodeIds, incoming.conflictEpisodeIds),
    tags: deterministicUnion(existing.tags, incoming.tags),
    metadata: mergeMetadata(existing.metadata, incoming.metadata, preferIncoming),
  });
}

function mergeCurriculumPlanItems(existing, incoming) {
  const preferred = selectPreferredByUpdatedAt(existing, incoming);
  const preferIncoming = preferred === incoming;

  return createCurriculumPlanItem({
    ...existing,
    ...incoming,
    ...preferred,
    id: existing.id,
    spaceId: existing.spaceId,
    profileId: existing.profileId,
    objectiveId: existing.objectiveId,
    itemType: existing.itemType,
    createdAt: minIsoTimestamp(existing.createdAt, incoming.createdAt) ?? existing.createdAt,
    updatedAt: maxIsoTimestamp(existing.updatedAt, incoming.updatedAt) ?? preferred.updatedAt,
    recommendationRank: Math.min(existing.recommendationRank, incoming.recommendationRank),
    dueAt: preferred.dueAt ?? existing.dueAt ?? incoming.dueAt ?? null,
    recommendationWindowStartAt:
      minIsoTimestamp(existing.recommendationWindowStartAt, incoming.recommendationWindowStartAt) ?? null,
    recommendationWindowEndAt:
      maxIsoTimestamp(existing.recommendationWindowEndAt, incoming.recommendationWindowEndAt) ?? null,
    evidenceEpisodeIds: deterministicUnion(existing.evidenceEpisodeIds, incoming.evidenceEpisodeIds),
    sourceMisconceptionIds: deterministicUnion(
      existing.sourceMisconceptionIds,
      incoming.sourceMisconceptionIds,
    ),
    interestTags: deterministicUnion(existing.interestTags, incoming.interestTags),
    provenanceSignalIds: deterministicUnion(existing.provenanceSignalIds, incoming.provenanceSignalIds),
    metadata: mergeMetadata(existing.metadata, incoming.metadata, preferIncoming),
  });
}

function mergeReviewScheduleEntries(existing, incoming) {
  const preferred = selectPreferredByUpdatedAt(existing, incoming);
  const preferIncoming = preferred === incoming;

  return createReviewScheduleEntry({
    ...existing,
    ...incoming,
    ...preferred,
    id: existing.id,
    spaceId: existing.spaceId,
    profileId: existing.profileId,
    targetId: existing.targetId,
    createdAt: minIsoTimestamp(existing.createdAt, incoming.createdAt) ?? existing.createdAt,
    updatedAt: maxIsoTimestamp(existing.updatedAt, incoming.updatedAt) ?? preferred.updatedAt,
    dueAt: preferred.dueAt,
    lastReviewedAt: maxIsoTimestamp(existing.lastReviewedAt, incoming.lastReviewedAt),
    repetition: Math.max(existing.repetition, incoming.repetition),
    intervalDays: preferred.intervalDays,
    easeFactor: preferred.easeFactor,
    sourceEventIds: deterministicUnion(existing.sourceEventIds, incoming.sourceEventIds),
    evidenceEpisodeIds: deterministicUnion(existing.evidenceEpisodeIds, incoming.evidenceEpisodeIds),
    metadata: mergeMetadata(existing.metadata, incoming.metadata, preferIncoming),
  });
}

function mergePolicyDecisions(existing, incoming) {
  const preferred = selectPreferredByUpdatedAt(existing, incoming);
  const preferIncoming = preferred === incoming;

  return createPersonalizationPolicyDecision({
    ...existing,
    ...incoming,
    ...preferred,
    id: existing.id,
    auditId: preferred.auditId || existing.auditId || incoming.auditId,
    spaceId: existing.spaceId,
    profileId: existing.profileId,
    policyKey: existing.policyKey,
    surface: existing.surface,
    action: existing.action,
    createdAt: minIsoTimestamp(existing.createdAt, incoming.createdAt) ?? existing.createdAt,
    evaluatedAt: maxIsoTimestamp(existing.evaluatedAt, incoming.evaluatedAt) ?? preferred.evaluatedAt,
    updatedAt: maxIsoTimestamp(existing.updatedAt, incoming.updatedAt) ?? preferred.updatedAt,
    outcome: mergePolicyOutcome(existing.outcome, incoming.outcome),
    reasonCodes: deterministicUnion(existing.reasonCodes, incoming.reasonCodes),
    appliedControls: deterministicUnion(existing.appliedControls, incoming.appliedControls),
    provenanceEventIds: deterministicUnion(existing.provenanceEventIds, incoming.provenanceEventIds),
    evidenceEpisodeIds: deterministicUnion(existing.evidenceEpisodeIds, incoming.evidenceEpisodeIds),
    metadata: mergeMetadata(existing.metadata, incoming.metadata, preferIncoming),
  });
}

export class InMemoryMisconceptionRepository extends MisconceptionRepositoryContract {
  #recordsBySpace = new Map();

  #getSpaceRecordMap(spaceId) {
    const existing = this.#recordsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#recordsBySpace.set(spaceId, map);
    return map;
  }

  upsertMisconception(rawMisconception) {
    const incoming = createMisconceptionRecord(rawMisconception);
    const records = this.#getSpaceRecordMap(incoming.spaceId);
    const existing = records.get(incoming.id);
    const merged = existing ? mergeMisconceptionRecords(existing, incoming) : incoming;

    records.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  getMisconceptionById(spaceId, misconceptionId) {
    const record = this.#getSpaceRecordMap(spaceId).get(misconceptionId);
    return record ? deepClone(record) : null;
  }

  listMisconceptions(spaceId, options = {}) {
    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;

    const records = Array.from(this.#getSpaceRecordMap(spaceId).values())
      .filter((record) => (profileId ? record.profileId === profileId : true))
      .filter((record) => (status ? record.status === status : true))
      .sort(compareByUpdatedThenIdDesc);

    return records.slice(0, limit).map((record) => deepClone(record));
  }

  countMisconceptions(spaceId, options = {}) {
    return this.listMisconceptions(spaceId, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
  }
}

export class InMemoryCurriculumPlannerRepository extends CurriculumPlannerRepositoryContract {
  #planItemsBySpace = new Map();

  #getSpacePlanItemMap(spaceId) {
    const existing = this.#planItemsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#planItemsBySpace.set(spaceId, map);
    return map;
  }

  upsertPlanItem(rawPlanItem) {
    const incoming = createCurriculumPlanItem(rawPlanItem);
    const planItems = this.#getSpacePlanItemMap(incoming.spaceId);
    const existing = planItems.get(incoming.id);
    const merged = existing ? mergeCurriculumPlanItems(existing, incoming) : incoming;

    planItems.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  getPlanItemById(spaceId, planItemId) {
    const item = this.#getSpacePlanItemMap(spaceId).get(planItemId);
    return item ? deepClone(item) : null;
  }

  listPlanItems(spaceId, options = {}) {
    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const objectiveId = typeof options.objectiveId === "string" ? options.objectiveId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;

    const planItems = Array.from(this.#getSpacePlanItemMap(spaceId).values())
      .filter((item) => (profileId ? item.profileId === profileId : true))
      .filter((item) => (objectiveId ? item.objectiveId === objectiveId : true))
      .filter((item) => (status ? item.status === status : true))
      .sort(compareByRankThenUpdatedThenId);

    return planItems.slice(0, limit).map((item) => deepClone(item));
  }

  countPlanItems(spaceId, options = {}) {
    return this.listPlanItems(spaceId, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
  }
}

export class InMemorySpacedRepetitionRepository extends SpacedRepetitionRepositoryContract {
  #entriesBySpace = new Map();

  #getSpaceEntryMap(spaceId) {
    const existing = this.#entriesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#entriesBySpace.set(spaceId, map);
    return map;
  }

  upsertScheduleEntry(rawScheduleEntry) {
    const incoming = createReviewScheduleEntry(rawScheduleEntry);
    const entries = this.#getSpaceEntryMap(incoming.spaceId);
    const existing = entries.get(incoming.id);
    const merged = existing ? mergeReviewScheduleEntries(existing, incoming) : incoming;

    entries.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  getScheduleEntryById(spaceId, scheduleEntryId) {
    const entry = this.#getSpaceEntryMap(spaceId).get(scheduleEntryId);
    return entry ? deepClone(entry) : null;
  }

  listScheduleEntries(spaceId, options = {}) {
    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const dueBefore =
      options.dueBefore === undefined || options.dueBefore === null || options.dueBefore === ""
        ? null
        : toIsoTimestamp(options.dueBefore);
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;

    const entries = Array.from(this.#getSpaceEntryMap(spaceId).values())
      .filter((entry) => (profileId ? entry.profileId === profileId : true))
      .filter((entry) => (status ? entry.status === status : true))
      .filter((entry) => (dueBefore ? entry.dueAt <= dueBefore : true))
      .sort(compareByDueThenUpdatedThenId);

    return entries.slice(0, limit).map((entry) => deepClone(entry));
  }

  countScheduleEntries(spaceId, options = {}) {
    return this.listScheduleEntries(spaceId, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
  }
}

export class InMemoryPersonalizationPolicyRepository extends PersonalizationPolicyRepositoryContract {
  #decisionsBySpace = new Map();

  #getSpaceDecisionMap(spaceId) {
    const existing = this.#decisionsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#decisionsBySpace.set(spaceId, map);
    return map;
  }

  upsertPolicyDecision(rawPolicyDecision) {
    const incoming = createPersonalizationPolicyDecision(rawPolicyDecision);
    const decisions = this.#getSpaceDecisionMap(incoming.spaceId);
    const existing = decisions.get(incoming.id);
    const merged = existing ? mergePolicyDecisions(existing, incoming) : incoming;

    decisions.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  getPolicyDecisionById(spaceId, decisionId) {
    const decision = this.#getSpaceDecisionMap(spaceId).get(decisionId);
    return decision ? deepClone(decision) : null;
  }

  listPolicyDecisions(spaceId, options = {}) {
    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const policyKey = typeof options.policyKey === "string" ? options.policyKey : null;
    const outcome = typeof options.outcome === "string" ? options.outcome : null;
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;

    const decisions = Array.from(this.#getSpaceDecisionMap(spaceId).values())
      .filter((decision) => (profileId ? decision.profileId === profileId : true))
      .filter((decision) => (policyKey ? decision.policyKey === policyKey : true))
      .filter((decision) => (outcome ? decision.outcome === outcome : true))
      .sort(compareByUpdatedThenIdDesc);

    return decisions.slice(0, limit).map((decision) => deepClone(decision));
  }

  countPolicyDecisions(spaceId, options = {}) {
    return this.listPolicyDecisions(spaceId, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
  }
}

function tokenize(text) {
  return asSortedUniqueStrings(String(text ?? "").toLowerCase().split(/[^a-z0-9_]+/g).filter(Boolean));
}

function scoreMatch(document, queryTokens, queryString) {
  if (queryTokens.length === 0) {
    return 1;
  }

  let score = 0;
  for (const token of queryTokens) {
    if (document.tokenSet.has(token)) {
      score += 1;
    }
  }

  if (queryString && document.textLower.includes(queryString)) {
    score += 1;
  }

  return score;
}

export class InMemoryKeywordIndex extends MemoryIndexContract {
  #docsBySpace = new Map();

  #getSpaceMap(spaceId) {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  upsert(rawDocument) {
    const id = rawDocument?.id;
    const spaceId = rawDocument?.spaceId;
    const kind = rawDocument?.kind;
    const text = String(rawDocument?.text ?? "");

    if (typeof id !== "string" || !id.trim()) {
      throw new ValidationError("index document id must be a non-empty string", { id });
    }
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError("index document spaceId must be a non-empty string", { spaceId });
    }
    if (typeof kind !== "string" || !kind.trim()) {
      throw new ValidationError("index document kind must be a non-empty string", { kind });
    }

    const tags = asSortedUniqueStrings(rawDocument.tags);
    const createdAt = toIsoTimestamp(rawDocument.createdAt);
    const tokenSet = new Set(tokenize(`${text} ${tags.join(" ")}`));
    const document = deepFreeze({
      id: id.trim(),
      spaceId: spaceId.trim(),
      kind: kind.trim(),
      text,
      textLower: text.toLowerCase(),
      excerpt: text.slice(0, 200),
      createdAt,
      tags,
      tokenSet,
    });
    this.#getSpaceMap(document.spaceId).set(document.id, document);
    return deepClone(document);
  }

  search(options = {}) {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError("search requires a non-empty spaceId");
    }
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 20;
    const kinds = asSortedUniqueStrings(options.kinds);
    const queryString = String(options.query ?? "").toLowerCase().trim();
    const queryTokens = tokenize(queryString);

    const docs = Array.from(this.#getSpaceMap(spaceId).values());
    const filtered = kinds.length > 0 ? docs.filter((doc) => kinds.includes(doc.kind)) : docs;

    const ranked = filtered
      .map((document) => {
        const score = scoreMatch(document, queryTokens, queryString);
        return { document, score };
      })
      .filter(({ score }) => score > 0 || queryTokens.length === 0)
      .sort((left, right) => {
        const scoreDiff = right.score - left.score;
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        const createdDiff = right.document.createdAt.localeCompare(left.document.createdAt);
        if (createdDiff !== 0) {
          return createdDiff;
        }
        return left.document.id.localeCompare(right.document.id);
      })
      .slice(0, limit)
      .map(({ document, score }) => ({
        id: document.id,
        spaceId: document.spaceId,
        kind: document.kind,
        score,
        excerpt: document.excerpt,
        createdAt: document.createdAt,
        reason:
          queryTokens.length === 0
            ? "empty query fallback"
            : `matched ${Math.min(score, queryTokens.length)} query tokens`,
      }));

    return deepClone(ranked);
  }
}

export class InMemoryMisconceptionIndex extends MisconceptionIndexContract {
  #docsBySpace = new Map();

  #getSpaceMap(spaceId) {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  upsert(rawDocument) {
    const incoming = createMisconceptionRecord(rawDocument);
    const docs = this.#getSpaceMap(incoming.spaceId);
    const existing = docs.get(incoming.id);
    const merged = existing ? mergeMisconceptionRecords(existing, incoming) : incoming;
    docs.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  search(options = {}) {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError("misconception search requires a non-empty spaceId");
    }

    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const queryString = String(options.query ?? "").toLowerCase().trim();
    const queryTokens = tokenize(queryString);
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 50;

    const matches = Array.from(this.#getSpaceMap(spaceId).values())
      .filter((document) => (profileId ? document.profileId === profileId : true))
      .filter((document) => (status ? document.status === status : true))
      .map((document) => {
        const searchText = `${document.misconceptionKey} ${document.tags.join(" ")}`;
        const score = scoreMatch(
          {
            tokenSet: new Set(tokenize(searchText)),
            textLower: searchText.toLowerCase(),
          },
          queryTokens,
          queryString,
        );
        return { document, score };
      })
      .filter(({ score }) => score > 0 || queryTokens.length === 0)
      .sort((left, right) => {
        const scoreDiff = right.score - left.score;
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return compareByUpdatedThenIdDesc(left.document, right.document);
      })
      .slice(0, limit)
      .map(({ document, score }) => ({
        id: document.id,
        spaceId: document.spaceId,
        profileId: document.profileId,
        misconceptionKey: document.misconceptionKey,
        status: document.status,
        harmfulSignalCount: document.harmfulSignalCount,
        correctionSignalCount: document.correctionSignalCount,
        conflictCount: document.conflictCount,
        lastSignalAt: document.lastSignalAt,
        evidenceEpisodeIds: deepClone(document.evidenceEpisodeIds),
        score,
      }));

    return deepClone(matches);
  }
}

export class InMemoryCurriculumPlannerIndex extends CurriculumPlannerIndexContract {
  #docsBySpace = new Map();

  #getSpaceMap(spaceId) {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  upsert(rawDocument) {
    const incoming = createCurriculumPlanItem(rawDocument);
    const docs = this.#getSpaceMap(incoming.spaceId);
    const existing = docs.get(incoming.id);
    const merged = existing ? mergeCurriculumPlanItems(existing, incoming) : incoming;
    docs.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  listRecommendations(options = {}) {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError("curriculum recommendation listing requires a non-empty spaceId");
    }

    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const dueBefore =
      options.dueBefore === undefined || options.dueBefore === null || options.dueBefore === ""
        ? null
        : toIsoTimestamp(options.dueBefore);
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 50;

    const docs = Array.from(this.#getSpaceMap(spaceId).values())
      .filter((document) => (profileId ? document.profileId === profileId : true))
      .filter((document) => (status ? document.status === status : true))
      .filter((document) => (dueBefore ? (document.dueAt ? document.dueAt <= dueBefore : true) : true))
      .sort(compareByRankThenUpdatedThenId)
      .slice(0, limit)
      .map((document) => ({
        id: document.id,
        spaceId: document.spaceId,
        profileId: document.profileId,
        objectiveId: document.objectiveId,
        status: document.status,
        recommendationRank: document.recommendationRank,
        dueAt: document.dueAt,
        evidenceEpisodeIds: deepClone(document.evidenceEpisodeIds),
        sourceMisconceptionIds: deepClone(document.sourceMisconceptionIds),
      }));

    return deepClone(docs);
  }
}

export class InMemorySpacedRepetitionIndex extends SpacedRepetitionIndexContract {
  #docsBySpace = new Map();

  #getSpaceMap(spaceId) {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  upsert(rawDocument) {
    const incoming = createReviewScheduleEntry(rawDocument);
    const docs = this.#getSpaceMap(incoming.spaceId);
    const existing = docs.get(incoming.id);
    const merged = existing ? mergeReviewScheduleEntries(existing, incoming) : incoming;
    docs.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  listDue(options = {}) {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError("spaced repetition due listing requires a non-empty spaceId");
    }

    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const asOf = toIsoTimestamp(options.asOf);
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 50;

    const docs = Array.from(this.#getSpaceMap(spaceId).values())
      .filter((document) => (profileId ? document.profileId === profileId : true))
      .filter((document) => document.dueAt <= asOf)
      .sort(compareByDueThenUpdatedThenId)
      .slice(0, limit)
      .map((document) => ({
        id: document.id,
        spaceId: document.spaceId,
        profileId: document.profileId,
        targetId: document.targetId,
        status: document.status,
        dueAt: document.dueAt,
        intervalDays: document.intervalDays,
        repetition: document.repetition,
        sourceEventIds: deepClone(document.sourceEventIds),
      }));

    return deepClone(docs);
  }
}

export class InMemoryPersonalizationPolicyIndex extends PersonalizationPolicyIndexContract {
  #docsBySpace = new Map();

  #getSpaceMap(spaceId) {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  upsert(rawDocument) {
    const incoming = createPersonalizationPolicyDecision(rawDocument);
    const docs = this.#getSpaceMap(incoming.spaceId);
    const existing = docs.get(incoming.id);
    const merged = existing ? mergePolicyDecisions(existing, incoming) : incoming;
    docs.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  search(options = {}) {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError("policy decision search requires a non-empty spaceId");
    }

    const profileId = typeof options.profileId === "string" ? options.profileId : null;
    const policyKey = typeof options.policyKey === "string" ? options.policyKey : null;
    const outcome = typeof options.outcome === "string" ? options.outcome : null;
    const queryString = String(options.query ?? "").toLowerCase().trim();
    const queryTokens = tokenize(queryString);
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 50;

    const docs = Array.from(this.#getSpaceMap(spaceId).values())
      .filter((document) => (profileId ? document.profileId === profileId : true))
      .filter((document) => (policyKey ? document.policyKey === policyKey : true))
      .filter((document) => (outcome ? document.outcome === outcome : true))
      .map((document) => {
        const searchText = `${document.policyKey} ${document.reasonCodes.join(" ")} ${document.outcome}`;
        const score = scoreMatch(
          {
            tokenSet: new Set(tokenize(searchText)),
            textLower: searchText.toLowerCase(),
          },
          queryTokens,
          queryString,
        );
        return { document, score };
      })
      .filter(({ score }) => score > 0 || queryTokens.length === 0)
      .sort((left, right) => {
        const scoreDiff = right.score - left.score;
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return compareByUpdatedThenIdDesc(left.document, right.document);
      })
      .slice(0, limit)
      .map(({ document, score }) => ({
        id: document.id,
        auditId: document.auditId,
        spaceId: document.spaceId,
        profileId: document.profileId,
        policyKey: document.policyKey,
        outcome: document.outcome,
        reasonCodes: deepClone(document.reasonCodes),
        evaluatedAt: document.evaluatedAt,
        score,
      }));

    return deepClone(docs);
  }
}
