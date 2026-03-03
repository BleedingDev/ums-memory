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
  type AntiPattern,
  type CurriculumPlanItem,
  type EntityInput,
  type IdentityGraphEdge,
  type LearnerProfile,
  type MisconceptionRecord,
  type PersonalizationPolicyDecision,
  type PersonalizationPolicyOutcomeValue,
  type ProceduralRule,
  type ReviewScheduleEntry,
  type WorkingMemoryEntry,
} from "./entities.ts";
import { ContractViolationError, ValidationError } from "./errors.ts";
import {
  asSortedUniqueStrings,
  deepClone,
  deepFreeze,
  stableStringify,
  toIsoTimestamp,
} from "./utils.ts";

type Metadata = Record<string, unknown>;
type ContractCandidate = object | null | undefined;
interface WithUpdatedAt {
  id: string;
  updatedAt: string;
}
interface WithCreatedAt {
  id: string;
  createdAt: string;
}
interface WithRank {
  id: string;
  recommendationRank: number;
  updatedAt: string;
}
interface WithDue {
  id: string;
  dueAt: string;
  updatedAt: string;
}

interface ProceduralListOptions {
  includeTombstoned?: unknown;
  limit?: unknown;
}
interface AntiPatternListOptions {
  limit?: unknown;
}
interface WorkingMemoryListOptions {
  kind?: unknown;
  limit?: unknown;
}
interface LearnerProfileListOptions {
  status?: unknown;
  limit?: unknown;
}
interface IdentityGraphListOptions {
  relation?: unknown;
  profileId?: unknown;
  limit?: unknown;
}
interface MisconceptionListOptions {
  profileId?: unknown;
  status?: unknown;
  limit?: unknown;
}
interface CurriculumPlanListOptions {
  profileId?: unknown;
  objectiveId?: unknown;
  status?: unknown;
  limit?: unknown;
}
interface ScheduleEntryListOptions {
  profileId?: unknown;
  status?: unknown;
  dueBefore?: unknown;
  limit?: unknown;
}
interface PolicyDecisionListOptions {
  profileId?: unknown;
  policyKey?: unknown;
  outcome?: unknown;
  limit?: unknown;
}

interface KeywordDocument {
  id: string;
  spaceId: string;
  kind: string;
  text: string;
  textLower: string;
  excerpt: string;
  createdAt: string;
  tags: string[];
  tokenSet: Set<string>;
}

interface KeywordDocumentInput {
  id?: unknown;
  spaceId?: unknown;
  kind?: unknown;
  text?: unknown;
  tags?: unknown;
  createdAt?: unknown;
}

interface KeywordSearchOptions {
  spaceId?: unknown;
  limit?: unknown;
  kinds?: unknown;
  query?: unknown;
}

interface MisconceptionSearchOptions {
  spaceId?: unknown;
  profileId?: unknown;
  status?: unknown;
  query?: unknown;
  limit?: unknown;
}

interface CurriculumRecommendationOptions {
  spaceId?: unknown;
  profileId?: unknown;
  status?: unknown;
  dueBefore?: unknown;
  limit?: unknown;
}

interface DueListOptions {
  spaceId?: unknown;
  profileId?: unknown;
  asOf?: unknown;
  limit?: unknown;
}

interface PolicySearchOptions {
  spaceId?: unknown;
  profileId?: unknown;
  policyKey?: unknown;
  outcome?: unknown;
  query?: unknown;
  limit?: unknown;
}

interface TokenizedSearchDocument {
  tokenSet: ReadonlySet<string>;
  textLower: string;
}

interface KeywordSearchResult {
  id: string;
  spaceId: string;
  kind: string;
  score: number;
  excerpt: string;
  createdAt: string;
  reason: string;
}

interface MisconceptionSearchResult {
  id: string;
  spaceId: string;
  profileId: string;
  misconceptionKey: string;
  status: MisconceptionRecord["status"];
  harmfulSignalCount: number;
  correctionSignalCount: number;
  conflictCount: number;
  lastSignalAt: string;
  evidenceEpisodeIds: string[];
  score: number;
}

interface CurriculumRecommendation {
  id: string;
  spaceId: string;
  profileId: string;
  objectiveId: string;
  status: CurriculumPlanItem["status"];
  recommendationRank: number;
  dueAt: string | null;
  evidenceEpisodeIds: string[];
  sourceMisconceptionIds: string[];
}

interface DueReviewResult {
  id: string;
  spaceId: string;
  profileId: string;
  targetId: string;
  status: ReviewScheduleEntry["status"];
  dueAt: string;
  intervalDays: number;
  repetition: number;
  sourceEventIds: string[];
}

interface PolicySearchResult {
  id: string;
  auditId: string;
  spaceId: string;
  profileId: string;
  policyKey: string;
  outcome: PersonalizationPolicyOutcomeValue;
  reasonCodes: string[];
  evaluatedAt: string;
  score: number;
}

function toLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function assertContractMethods(
  candidate: ContractCandidate,
  methods: readonly string[],
  contractName: string
): void {
  for (const method of methods) {
    if (!candidate) {
      throw new ContractViolationError(`${contractName} contract violation`, {
        missingMethod: method,
      });
    }
    const contractCandidate = candidate as Record<string, unknown>;
    if (typeof contractCandidate[method] !== "function") {
      throw new ContractViolationError(`${contractName} contract violation`, {
        missingMethod: method,
      });
    }
  }
}

function compareByUpdatedThenIdDesc<T extends WithUpdatedAt>(
  left: T,
  right: T
): number {
  const updatedDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  return left.id.localeCompare(right.id);
}

function compareByCreatedThenIdDesc<T extends WithCreatedAt>(
  left: T,
  right: T
): number {
  const createdDiff = right.createdAt.localeCompare(left.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return left.id.localeCompare(right.id);
}

function compareByRankThenUpdatedThenId<T extends WithRank>(
  left: T,
  right: T
): number {
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

function compareByDueThenUpdatedThenId<T extends WithDue>(
  left: T,
  right: T
): number {
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

function maxIsoTimestamp(
  ...timestamps: Array<string | null | undefined>
): string | null {
  const values = timestamps.filter(
    (timestamp): timestamp is string =>
      typeof timestamp === "string" && timestamp.trim().length > 0
  );
  if (values.length === 0) {
    return null;
  }
  return values.reduce((maxValue, value) =>
    value > maxValue ? value : maxValue
  );
}

function minIsoTimestamp(
  ...timestamps: Array<string | null | undefined>
): string | null {
  const values = timestamps.filter(
    (timestamp): timestamp is string =>
      typeof timestamp === "string" && timestamp.trim().length > 0
  );
  if (values.length === 0) {
    return null;
  }
  return values.reduce((minValue, value) =>
    value < minValue ? value : minValue
  );
}

function deterministicUnion(...collections: unknown[]): string[] {
  return asSortedUniqueStrings(collections.flat());
}

function selectPreferredByUpdatedAt<T extends WithUpdatedAt>(
  existing: T,
  incoming: T
): T {
  const updatedDiff = incoming.updatedAt.localeCompare(existing.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff > 0 ? incoming : existing;
  }

  const incomingFingerprint = stableStringify(incoming);
  const existingFingerprint = stableStringify(existing);
  return incomingFingerprint.localeCompare(existingFingerprint) >= 0
    ? incoming
    : existing;
}

function mergeMetadata(
  existingMetadata: Metadata,
  incomingMetadata: Metadata,
  preferIncoming: boolean
): Metadata {
  if (preferIncoming) {
    return { ...existingMetadata, ...incomingMetadata };
  }
  return { ...incomingMetadata, ...existingMetadata };
}

function mergePolicyOutcome(
  leftOutcome: PersonalizationPolicyOutcomeValue,
  rightOutcome: PersonalizationPolicyOutcomeValue
): PersonalizationPolicyOutcomeValue {
  const weightByOutcome = {
    [PersonalizationPolicyOutcome.ALLOW]: 1,
    [PersonalizationPolicyOutcome.REVIEW]: 2,
    [PersonalizationPolicyOutcome.DENY]: 3,
  };
  return weightByOutcome[leftOutcome] >= weightByOutcome[rightOutcome]
    ? leftOutcome
    : rightOutcome;
}

export class ProceduralRepositoryContract {
  upsertRule(_rawRule: EntityInput): ProceduralRule {
    throw new Error("upsertRule() not implemented");
  }

  getRuleById(_spaceId: string, _ruleId: string): ProceduralRule | null {
    throw new Error("getRuleById() not implemented");
  }

  listRules(
    _spaceId: string,
    _options: ProceduralListOptions = {}
  ): ProceduralRule[] {
    throw new Error("listRules() not implemented");
  }

  upsertAntiPattern(_rawAntiPattern: EntityInput): AntiPattern {
    throw new Error("upsertAntiPattern() not implemented");
  }

  listAntiPatterns(
    _spaceId: string,
    _options: AntiPatternListOptions = {}
  ): AntiPattern[] {
    throw new Error("listAntiPatterns() not implemented");
  }
}

export class WorkingMemoryRepositoryContract {
  upsertEntry(_rawEntry: EntityInput): WorkingMemoryEntry {
    throw new Error("upsertEntry() not implemented");
  }

  getEntryById(_spaceId: string, _entryId: string): WorkingMemoryEntry | null {
    throw new Error("getEntryById() not implemented");
  }

  listEntries(
    _spaceId: string,
    _options: WorkingMemoryListOptions = {}
  ): WorkingMemoryEntry[] {
    throw new Error("listEntries() not implemented");
  }
}

export class MemoryIndexContract {
  upsert(_rawDocument: KeywordDocumentInput): KeywordDocument {
    throw new Error("upsert() not implemented");
  }

  search(_options: KeywordSearchOptions = {}): KeywordSearchResult[] {
    throw new Error("search() not implemented");
  }
}

export class LearnerProfileRepositoryContract {
  upsertProfile(_rawProfile: EntityInput): LearnerProfile {
    throw new Error("upsertProfile() not implemented");
  }

  getProfileById(_spaceId: string, _profileId: string): LearnerProfile | null {
    throw new Error("getProfileById() not implemented");
  }

  listProfiles(
    _spaceId: string,
    _options: LearnerProfileListOptions = {}
  ): LearnerProfile[] {
    throw new Error("listProfiles() not implemented");
  }
}

export class IdentityGraphRepositoryContract {
  upsertEdge(_rawEdge: EntityInput): IdentityGraphEdge {
    throw new Error("upsertEdge() not implemented");
  }

  getEdgeById(_spaceId: string, _edgeId: string): IdentityGraphEdge | null {
    throw new Error("getEdgeById() not implemented");
  }

  listEdges(
    _spaceId: string,
    _options: IdentityGraphListOptions = {}
  ): IdentityGraphEdge[] {
    throw new Error("listEdges() not implemented");
  }
}

export class MisconceptionRepositoryContract {
  upsertMisconception(_rawMisconception: EntityInput): MisconceptionRecord {
    throw new Error("upsertMisconception() not implemented");
  }

  getMisconceptionById(
    _spaceId: string,
    _misconceptionId: string
  ): MisconceptionRecord | null {
    throw new Error("getMisconceptionById() not implemented");
  }

  listMisconceptions(
    _spaceId: string,
    _options: MisconceptionListOptions = {}
  ): MisconceptionRecord[] {
    throw new Error("listMisconceptions() not implemented");
  }
}

export class CurriculumPlannerRepositoryContract {
  upsertPlanItem(_rawPlanItem: EntityInput): CurriculumPlanItem {
    throw new Error("upsertPlanItem() not implemented");
  }

  getPlanItemById(
    _spaceId: string,
    _planItemId: string
  ): CurriculumPlanItem | null {
    throw new Error("getPlanItemById() not implemented");
  }

  listPlanItems(
    _spaceId: string,
    _options: CurriculumPlanListOptions = {}
  ): CurriculumPlanItem[] {
    throw new Error("listPlanItems() not implemented");
  }
}

export class SpacedRepetitionRepositoryContract {
  upsertScheduleEntry(_rawScheduleEntry: EntityInput): ReviewScheduleEntry {
    throw new Error("upsertScheduleEntry() not implemented");
  }

  getScheduleEntryById(
    _spaceId: string,
    _scheduleEntryId: string
  ): ReviewScheduleEntry | null {
    throw new Error("getScheduleEntryById() not implemented");
  }

  listScheduleEntries(
    _spaceId: string,
    _options: ScheduleEntryListOptions = {}
  ): ReviewScheduleEntry[] {
    throw new Error("listScheduleEntries() not implemented");
  }
}

export class PersonalizationPolicyRepositoryContract {
  upsertPolicyDecision(
    _rawPolicyDecision: EntityInput
  ): PersonalizationPolicyDecision {
    throw new Error("upsertPolicyDecision() not implemented");
  }

  getPolicyDecisionById(
    _spaceId: string,
    _decisionId: string
  ): PersonalizationPolicyDecision | null {
    throw new Error("getPolicyDecisionById() not implemented");
  }

  listPolicyDecisions(
    _spaceId: string,
    _options: PolicyDecisionListOptions = {}
  ): PersonalizationPolicyDecision[] {
    throw new Error("listPolicyDecisions() not implemented");
  }
}

export class MisconceptionIndexContract {
  upsert(_rawDocument: EntityInput): MisconceptionRecord {
    throw new Error("upsert() not implemented");
  }

  search(
    _options: MisconceptionSearchOptions = {}
  ): MisconceptionSearchResult[] {
    throw new Error("search() not implemented");
  }
}

export class CurriculumPlannerIndexContract {
  upsert(_rawDocument: EntityInput): CurriculumPlanItem {
    throw new Error("upsert() not implemented");
  }

  listRecommendations(
    _options: CurriculumRecommendationOptions = {}
  ): CurriculumRecommendation[] {
    throw new Error("listRecommendations() not implemented");
  }
}

export class SpacedRepetitionIndexContract {
  upsert(_rawDocument: EntityInput): ReviewScheduleEntry {
    throw new Error("upsert() not implemented");
  }

  listDue(_options: DueListOptions = {}): DueReviewResult[] {
    throw new Error("listDue() not implemented");
  }
}

export class PersonalizationPolicyIndexContract {
  upsert(_rawDocument: EntityInput): PersonalizationPolicyDecision {
    throw new Error("upsert() not implemented");
  }

  search(_options: PolicySearchOptions = {}): PolicySearchResult[] {
    throw new Error("search() not implemented");
  }
}

export function assertProceduralRepositoryContract(
  repository: ContractCandidate
): void {
  assertContractMethods(
    repository,
    [
      "upsertRule",
      "getRuleById",
      "listRules",
      "upsertAntiPattern",
      "listAntiPatterns",
    ],
    "procedural repository"
  );
}

export function assertWorkingMemoryRepositoryContract(
  repository: ContractCandidate
): void {
  assertContractMethods(
    repository,
    ["upsertEntry", "getEntryById", "listEntries", "countEntries"],
    "working memory repository"
  );
}

export function assertMemoryIndexContract(index: ContractCandidate): void {
  assertContractMethods(index, ["upsert", "search"], "memory index");
}

export function assertLearnerProfileRepositoryContract(
  repository: ContractCandidate
): void {
  assertContractMethods(
    repository,
    ["upsertProfile", "getProfileById", "listProfiles", "countProfiles"],
    "learner profile repository"
  );
}

export function assertIdentityGraphRepositoryContract(
  repository: ContractCandidate
): void {
  assertContractMethods(
    repository,
    ["upsertEdge", "getEdgeById", "listEdges", "countEdges"],
    "identity graph repository"
  );
}

export function assertMisconceptionRepositoryContract(
  repository: ContractCandidate
): void {
  assertContractMethods(
    repository,
    [
      "upsertMisconception",
      "getMisconceptionById",
      "listMisconceptions",
      "countMisconceptions",
    ],
    "misconception repository"
  );
}

export function assertCurriculumPlannerRepositoryContract(
  repository: ContractCandidate
): void {
  assertContractMethods(
    repository,
    ["upsertPlanItem", "getPlanItemById", "listPlanItems", "countPlanItems"],
    "curriculum planner repository"
  );
}

export function assertSpacedRepetitionRepositoryContract(
  repository: ContractCandidate
): void {
  assertContractMethods(
    repository,
    [
      "upsertScheduleEntry",
      "getScheduleEntryById",
      "listScheduleEntries",
      "countScheduleEntries",
    ],
    "spaced repetition repository"
  );
}

export function assertPersonalizationPolicyRepositoryContract(
  repository: ContractCandidate
): void {
  assertContractMethods(
    repository,
    [
      "upsertPolicyDecision",
      "getPolicyDecisionById",
      "listPolicyDecisions",
      "countPolicyDecisions",
    ],
    "personalization policy repository"
  );
}

export function assertMisconceptionIndexContract(
  index: ContractCandidate
): void {
  assertContractMethods(index, ["upsert", "search"], "misconception index");
}

export function assertCurriculumPlannerIndexContract(
  index: ContractCandidate
): void {
  assertContractMethods(
    index,
    ["upsert", "listRecommendations"],
    "curriculum planner index"
  );
}

export function assertSpacedRepetitionIndexContract(
  index: ContractCandidate
): void {
  assertContractMethods(
    index,
    ["upsert", "listDue"],
    "spaced repetition index"
  );
}

export function assertPersonalizationPolicyIndexContract(
  index: ContractCandidate
): void {
  assertContractMethods(
    index,
    ["upsert", "search"],
    "personalization policy index"
  );
}

export class InMemoryProceduralRepository extends ProceduralRepositoryContract {
  #rulesBySpace = new Map<string, Map<string, ProceduralRule>>();
  #antiPatternsBySpace = new Map<string, Map<string, AntiPattern>>();

  #getSpaceRuleMap(spaceId: string): Map<string, ProceduralRule> {
    const existing = this.#rulesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, ProceduralRule>();
    this.#rulesBySpace.set(spaceId, map);
    return map;
  }

  #getSpaceAntiPatternMap(spaceId: string): Map<string, AntiPattern> {
    const existing = this.#antiPatternsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, AntiPattern>();
    this.#antiPatternsBySpace.set(spaceId, map);
    return map;
  }

  override upsertRule(rawRule: EntityInput): ProceduralRule {
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

  override getRuleById(spaceId: string, ruleId: string): ProceduralRule | null {
    const rule = this.#getSpaceRuleMap(spaceId).get(ruleId);
    return rule ? deepClone(rule) : null;
  }

  override listRules(
    spaceId: string,
    options: ProceduralListOptions = {}
  ): ProceduralRule[] {
    const includeTombstoned = Boolean(options.includeTombstoned);
    const limit = toLimit(options.limit, 100);

    const rules = [...this.#getSpaceRuleMap(spaceId).values()]
      .filter(
        (rule) =>
          includeTombstoned || rule.status !== ProceduralEntryStatus.TOMBSTONED
      )
      .sort(compareByUpdatedThenIdDesc);

    return rules.slice(0, limit).map((rule) => deepClone(rule));
  }

  countRules(spaceId: string, options: ProceduralListOptions = {}): number {
    return this.listRules(spaceId, {
      includeTombstoned: options.includeTombstoned,
      limit: Number.MAX_SAFE_INTEGER,
    }).length;
  }

  override upsertAntiPattern(rawAntiPattern: EntityInput): AntiPattern {
    const incoming = createAntiPattern(rawAntiPattern);
    const antiPatterns = this.#getSpaceAntiPatternMap(incoming.spaceId);
    antiPatterns.set(incoming.id, deepFreeze(deepClone(incoming)));
    return deepClone(incoming);
  }

  getAntiPatternById(
    spaceId: string,
    antiPatternId: string
  ): AntiPattern | null {
    const antiPattern =
      this.#getSpaceAntiPatternMap(spaceId).get(antiPatternId);
    return antiPattern ? deepClone(antiPattern) : null;
  }

  override listAntiPatterns(
    spaceId: string,
    options: AntiPatternListOptions = {}
  ): AntiPattern[] {
    const limit = toLimit(options.limit, 100);
    const antiPatterns = [
      ...this.#getSpaceAntiPatternMap(spaceId).values(),
    ].sort(compareByCreatedThenIdDesc);
    return antiPatterns
      .slice(0, limit)
      .map((antiPattern) => deepClone(antiPattern));
  }

  countAntiPatterns(spaceId: string): number {
    return this.#getSpaceAntiPatternMap(spaceId).size;
  }
}

export class InMemoryWorkingMemoryRepository extends WorkingMemoryRepositoryContract {
  #entriesBySpace = new Map<string, Map<string, WorkingMemoryEntry>>();

  #getSpaceEntryMap(spaceId: string): Map<string, WorkingMemoryEntry> {
    const existing = this.#entriesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, WorkingMemoryEntry>();
    this.#entriesBySpace.set(spaceId, map);
    return map;
  }

  override upsertEntry(rawEntry: EntityInput): WorkingMemoryEntry {
    const entry = createWorkingMemoryEntry(rawEntry);
    this.#getSpaceEntryMap(entry.spaceId).set(
      entry.id,
      deepFreeze(deepClone(entry))
    );
    return deepClone(entry);
  }

  override getEntryById(
    spaceId: string,
    entryId: string
  ): WorkingMemoryEntry | null {
    const entry = this.#getSpaceEntryMap(spaceId).get(entryId);
    return entry ? deepClone(entry) : null;
  }

  override listEntries(
    spaceId: string,
    options: WorkingMemoryListOptions = {}
  ): WorkingMemoryEntry[] {
    const kind = typeof options.kind === "string" ? options.kind : null;
    const limit = toLimit(options.limit, 100);

    const entries = [...this.#getSpaceEntryMap(spaceId).values()]
      .filter((entry) => (kind ? entry.kind === kind : true))
      .sort(compareByCreatedThenIdDesc);
    return entries.slice(0, limit).map((entry) => deepClone(entry));
  }

  countEntries(spaceId: string): number {
    return this.#getSpaceEntryMap(spaceId).size;
  }
}

export class InMemoryLearnerProfileRepository extends LearnerProfileRepositoryContract {
  #profilesBySpace = new Map<string, Map<string, LearnerProfile>>();

  #getSpaceProfileMap(spaceId: string): Map<string, LearnerProfile> {
    const existing = this.#profilesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, LearnerProfile>();
    this.#profilesBySpace.set(spaceId, map);
    return map;
  }

  override upsertProfile(rawProfile: EntityInput): LearnerProfile {
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
          misconceptionIds: [
            ...existing.misconceptionIds,
            ...incoming.misconceptionIds,
          ],
          metadata: {
            ...existing.metadata,
            ...incoming.metadata,
          },
        })
      : incoming;

    profiles.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override getProfileById(
    spaceId: string,
    profileId: string
  ): LearnerProfile | null {
    const profile = this.#getSpaceProfileMap(spaceId).get(profileId);
    return profile ? deepClone(profile) : null;
  }

  override listProfiles(
    spaceId: string,
    options: LearnerProfileListOptions = {}
  ): LearnerProfile[] {
    const status = typeof options.status === "string" ? options.status : null;
    const limit = toLimit(options.limit, 100);

    const profiles = [...this.#getSpaceProfileMap(spaceId).values()]
      .filter((profile) => (status ? profile.status === status : true))
      .sort(compareByUpdatedThenIdDesc);

    return profiles.slice(0, limit).map((profile) => deepClone(profile));
  }

  countProfiles(spaceId: string): number {
    return this.#getSpaceProfileMap(spaceId).size;
  }
}

export class InMemoryIdentityGraphRepository extends IdentityGraphRepositoryContract {
  #edgesBySpace = new Map<string, Map<string, IdentityGraphEdge>>();

  #getSpaceEdgeMap(spaceId: string): Map<string, IdentityGraphEdge> {
    const existing = this.#edgesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, IdentityGraphEdge>();
    this.#edgesBySpace.set(spaceId, map);
    return map;
  }

  override upsertEdge(rawEdge: EntityInput): IdentityGraphEdge {
    const incoming = createIdentityGraphEdge(rawEdge);
    const edges = this.#getSpaceEdgeMap(incoming.spaceId);
    const existing = edges.get(incoming.id);
    const merged = existing
      ? createIdentityGraphEdge({
          ...existing,
          ...incoming,
          id: existing.id,
          createdAt: existing.createdAt,
          evidenceEpisodeIds: [
            ...existing.evidenceEpisodeIds,
            ...incoming.evidenceEpisodeIds,
          ],
          metadata: {
            ...existing.metadata,
            ...incoming.metadata,
          },
        })
      : incoming;

    edges.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override getEdgeById(
    spaceId: string,
    edgeId: string
  ): IdentityGraphEdge | null {
    const edge = this.#getSpaceEdgeMap(spaceId).get(edgeId);
    return edge ? deepClone(edge) : null;
  }

  override listEdges(
    spaceId: string,
    options: IdentityGraphListOptions = {}
  ): IdentityGraphEdge[] {
    const relation =
      typeof options.relation === "string" ? options.relation : null;
    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const limit = toLimit(options.limit, 200);

    const edges = [...this.#getSpaceEdgeMap(spaceId).values()]
      .filter((edge) => (relation ? edge.relation === relation : true))
      .filter((edge) => (profileId ? edge.profileId === profileId : true))
      .sort(compareByCreatedThenIdDesc);

    return edges.slice(0, limit).map((edge) => deepClone(edge));
  }

  countEdges(spaceId: string): number {
    return this.#getSpaceEdgeMap(spaceId).size;
  }
}

function mergeMisconceptionRecords(
  existing: MisconceptionRecord,
  incoming: MisconceptionRecord
): MisconceptionRecord {
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
    createdAt:
      minIsoTimestamp(existing.createdAt, incoming.createdAt) ??
      existing.createdAt,
    updatedAt:
      maxIsoTimestamp(existing.updatedAt, incoming.updatedAt) ??
      preferred.updatedAt,
    lastSignalAt:
      maxIsoTimestamp(existing.lastSignalAt, incoming.lastSignalAt) ??
      preferred.lastSignalAt,
    harmfulSignalCount: Math.max(
      existing.harmfulSignalCount,
      incoming.harmfulSignalCount
    ),
    correctionSignalCount: Math.max(
      existing.correctionSignalCount,
      incoming.correctionSignalCount
    ),
    conflictCount: Math.max(existing.conflictCount, incoming.conflictCount),
    evidenceEpisodeIds: deterministicUnion(
      existing.evidenceEpisodeIds,
      incoming.evidenceEpisodeIds
    ),
    sourceSignalIds: deterministicUnion(
      existing.sourceSignalIds,
      incoming.sourceSignalIds
    ),
    conflictEpisodeIds: deterministicUnion(
      existing.conflictEpisodeIds,
      incoming.conflictEpisodeIds
    ),
    tags: deterministicUnion(existing.tags, incoming.tags),
    metadata: mergeMetadata(
      existing.metadata,
      incoming.metadata,
      preferIncoming
    ),
  });
}

function mergeCurriculumPlanItems(
  existing: CurriculumPlanItem,
  incoming: CurriculumPlanItem
): CurriculumPlanItem {
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
    createdAt:
      minIsoTimestamp(existing.createdAt, incoming.createdAt) ??
      existing.createdAt,
    updatedAt:
      maxIsoTimestamp(existing.updatedAt, incoming.updatedAt) ??
      preferred.updatedAt,
    recommendationRank: Math.min(
      existing.recommendationRank,
      incoming.recommendationRank
    ),
    dueAt: preferred.dueAt ?? existing.dueAt ?? incoming.dueAt ?? null,
    recommendationWindowStartAt:
      minIsoTimestamp(
        existing.recommendationWindowStartAt,
        incoming.recommendationWindowStartAt
      ) ?? null,
    recommendationWindowEndAt:
      maxIsoTimestamp(
        existing.recommendationWindowEndAt,
        incoming.recommendationWindowEndAt
      ) ?? null,
    evidenceEpisodeIds: deterministicUnion(
      existing.evidenceEpisodeIds,
      incoming.evidenceEpisodeIds
    ),
    sourceMisconceptionIds: deterministicUnion(
      existing.sourceMisconceptionIds,
      incoming.sourceMisconceptionIds
    ),
    interestTags: deterministicUnion(
      existing.interestTags,
      incoming.interestTags
    ),
    provenanceSignalIds: deterministicUnion(
      existing.provenanceSignalIds,
      incoming.provenanceSignalIds
    ),
    metadata: mergeMetadata(
      existing.metadata,
      incoming.metadata,
      preferIncoming
    ),
  });
}

function mergeReviewScheduleEntries(
  existing: ReviewScheduleEntry,
  incoming: ReviewScheduleEntry
): ReviewScheduleEntry {
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
    createdAt:
      minIsoTimestamp(existing.createdAt, incoming.createdAt) ??
      existing.createdAt,
    updatedAt:
      maxIsoTimestamp(existing.updatedAt, incoming.updatedAt) ??
      preferred.updatedAt,
    dueAt: preferred.dueAt,
    lastReviewedAt: maxIsoTimestamp(
      existing.lastReviewedAt,
      incoming.lastReviewedAt
    ),
    repetition: Math.max(existing.repetition, incoming.repetition),
    intervalDays: preferred.intervalDays,
    easeFactor: preferred.easeFactor,
    sourceEventIds: deterministicUnion(
      existing.sourceEventIds,
      incoming.sourceEventIds
    ),
    evidenceEpisodeIds: deterministicUnion(
      existing.evidenceEpisodeIds,
      incoming.evidenceEpisodeIds
    ),
    metadata: mergeMetadata(
      existing.metadata,
      incoming.metadata,
      preferIncoming
    ),
  });
}

function mergePolicyDecisions(
  existing: PersonalizationPolicyDecision,
  incoming: PersonalizationPolicyDecision
): PersonalizationPolicyDecision {
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
    createdAt:
      minIsoTimestamp(existing.createdAt, incoming.createdAt) ??
      existing.createdAt,
    evaluatedAt:
      maxIsoTimestamp(existing.evaluatedAt, incoming.evaluatedAt) ??
      preferred.evaluatedAt,
    updatedAt:
      maxIsoTimestamp(existing.updatedAt, incoming.updatedAt) ??
      preferred.updatedAt,
    outcome: mergePolicyOutcome(existing.outcome, incoming.outcome),
    reasonCodes: deterministicUnion(existing.reasonCodes, incoming.reasonCodes),
    appliedControls: deterministicUnion(
      existing.appliedControls,
      incoming.appliedControls
    ),
    provenanceEventIds: deterministicUnion(
      existing.provenanceEventIds,
      incoming.provenanceEventIds
    ),
    evidenceEpisodeIds: deterministicUnion(
      existing.evidenceEpisodeIds,
      incoming.evidenceEpisodeIds
    ),
    metadata: mergeMetadata(
      existing.metadata,
      incoming.metadata,
      preferIncoming
    ),
  });
}

export class InMemoryMisconceptionRepository extends MisconceptionRepositoryContract {
  #recordsBySpace = new Map<string, Map<string, MisconceptionRecord>>();

  #getSpaceRecordMap(spaceId: string): Map<string, MisconceptionRecord> {
    const existing = this.#recordsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, MisconceptionRecord>();
    this.#recordsBySpace.set(spaceId, map);
    return map;
  }

  override upsertMisconception(
    rawMisconception: EntityInput
  ): MisconceptionRecord {
    const incoming = createMisconceptionRecord(rawMisconception);
    const records = this.#getSpaceRecordMap(incoming.spaceId);
    const existing = records.get(incoming.id);
    const merged = existing
      ? mergeMisconceptionRecords(existing, incoming)
      : incoming;

    records.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override getMisconceptionById(
    spaceId: string,
    misconceptionId: string
  ): MisconceptionRecord | null {
    const record = this.#getSpaceRecordMap(spaceId).get(misconceptionId);
    return record ? deepClone(record) : null;
  }

  override listMisconceptions(
    spaceId: string,
    options: MisconceptionListOptions = {}
  ): MisconceptionRecord[] {
    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const limit = toLimit(options.limit, 100);

    const records = [...this.#getSpaceRecordMap(spaceId).values()]
      .filter((record) => (profileId ? record.profileId === profileId : true))
      .filter((record) => (status ? record.status === status : true))
      .sort(compareByUpdatedThenIdDesc);

    return records.slice(0, limit).map((record) => deepClone(record));
  }

  countMisconceptions(
    spaceId: string,
    options: MisconceptionListOptions = {}
  ): number {
    return this.listMisconceptions(spaceId, {
      ...options,
      limit: Number.MAX_SAFE_INTEGER,
    }).length;
  }
}

export class InMemoryCurriculumPlannerRepository extends CurriculumPlannerRepositoryContract {
  #planItemsBySpace = new Map<string, Map<string, CurriculumPlanItem>>();

  #getSpacePlanItemMap(spaceId: string): Map<string, CurriculumPlanItem> {
    const existing = this.#planItemsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, CurriculumPlanItem>();
    this.#planItemsBySpace.set(spaceId, map);
    return map;
  }

  override upsertPlanItem(rawPlanItem: EntityInput): CurriculumPlanItem {
    const incoming = createCurriculumPlanItem(rawPlanItem);
    const planItems = this.#getSpacePlanItemMap(incoming.spaceId);
    const existing = planItems.get(incoming.id);
    const merged = existing
      ? mergeCurriculumPlanItems(existing, incoming)
      : incoming;

    planItems.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override getPlanItemById(
    spaceId: string,
    planItemId: string
  ): CurriculumPlanItem | null {
    const item = this.#getSpacePlanItemMap(spaceId).get(planItemId);
    return item ? deepClone(item) : null;
  }

  override listPlanItems(
    spaceId: string,
    options: CurriculumPlanListOptions = {}
  ): CurriculumPlanItem[] {
    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const objectiveId =
      typeof options.objectiveId === "string" ? options.objectiveId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const limit = toLimit(options.limit, 100);

    const planItems = [...this.#getSpacePlanItemMap(spaceId).values()]
      .filter((item) => (profileId ? item.profileId === profileId : true))
      .filter((item) => (objectiveId ? item.objectiveId === objectiveId : true))
      .filter((item) => (status ? item.status === status : true))
      .sort(compareByRankThenUpdatedThenId);

    return planItems.slice(0, limit).map((item) => deepClone(item));
  }

  countPlanItems(
    spaceId: string,
    options: CurriculumPlanListOptions = {}
  ): number {
    return this.listPlanItems(spaceId, {
      ...options,
      limit: Number.MAX_SAFE_INTEGER,
    }).length;
  }
}

export class InMemorySpacedRepetitionRepository extends SpacedRepetitionRepositoryContract {
  #entriesBySpace = new Map<string, Map<string, ReviewScheduleEntry>>();

  #getSpaceEntryMap(spaceId: string): Map<string, ReviewScheduleEntry> {
    const existing = this.#entriesBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, ReviewScheduleEntry>();
    this.#entriesBySpace.set(spaceId, map);
    return map;
  }

  override upsertScheduleEntry(
    rawScheduleEntry: EntityInput
  ): ReviewScheduleEntry {
    const incoming = createReviewScheduleEntry(rawScheduleEntry);
    const entries = this.#getSpaceEntryMap(incoming.spaceId);
    const existing = entries.get(incoming.id);
    const merged = existing
      ? mergeReviewScheduleEntries(existing, incoming)
      : incoming;

    entries.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override getScheduleEntryById(
    spaceId: string,
    scheduleEntryId: string
  ): ReviewScheduleEntry | null {
    const entry = this.#getSpaceEntryMap(spaceId).get(scheduleEntryId);
    return entry ? deepClone(entry) : null;
  }

  override listScheduleEntries(
    spaceId: string,
    options: ScheduleEntryListOptions = {}
  ): ReviewScheduleEntry[] {
    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const dueBefore =
      options.dueBefore === undefined ||
      options.dueBefore === null ||
      options.dueBefore === ""
        ? null
        : toIsoTimestamp(options.dueBefore);
    const limit = toLimit(options.limit, 100);

    const entries = [...this.#getSpaceEntryMap(spaceId).values()]
      .filter((entry) => (profileId ? entry.profileId === profileId : true))
      .filter((entry) => (status ? entry.status === status : true))
      .filter((entry) => (dueBefore ? entry.dueAt <= dueBefore : true))
      .sort(compareByDueThenUpdatedThenId);

    return entries.slice(0, limit).map((entry) => deepClone(entry));
  }

  countScheduleEntries(
    spaceId: string,
    options: ScheduleEntryListOptions = {}
  ): number {
    return this.listScheduleEntries(spaceId, {
      ...options,
      limit: Number.MAX_SAFE_INTEGER,
    }).length;
  }
}

export class InMemoryPersonalizationPolicyRepository extends PersonalizationPolicyRepositoryContract {
  #decisionsBySpace = new Map<
    string,
    Map<string, PersonalizationPolicyDecision>
  >();

  #getSpaceDecisionMap(
    spaceId: string
  ): Map<string, PersonalizationPolicyDecision> {
    const existing = this.#decisionsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, PersonalizationPolicyDecision>();
    this.#decisionsBySpace.set(spaceId, map);
    return map;
  }

  override upsertPolicyDecision(
    rawPolicyDecision: EntityInput
  ): PersonalizationPolicyDecision {
    const incoming = createPersonalizationPolicyDecision(rawPolicyDecision);
    const decisions = this.#getSpaceDecisionMap(incoming.spaceId);
    const existing = decisions.get(incoming.id);
    const merged = existing
      ? mergePolicyDecisions(existing, incoming)
      : incoming;

    decisions.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override getPolicyDecisionById(
    spaceId: string,
    decisionId: string
  ): PersonalizationPolicyDecision | null {
    const decision = this.#getSpaceDecisionMap(spaceId).get(decisionId);
    return decision ? deepClone(decision) : null;
  }

  override listPolicyDecisions(
    spaceId: string,
    options: PolicyDecisionListOptions = {}
  ): PersonalizationPolicyDecision[] {
    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const policyKey =
      typeof options.policyKey === "string" ? options.policyKey : null;
    const outcome =
      typeof options.outcome === "string" ? options.outcome : null;
    const limit = toLimit(options.limit, 100);

    const decisions = [...this.#getSpaceDecisionMap(spaceId).values()]
      .filter((decision) =>
        profileId ? decision.profileId === profileId : true
      )
      .filter((decision) =>
        policyKey ? decision.policyKey === policyKey : true
      )
      .filter((decision) => (outcome ? decision.outcome === outcome : true))
      .sort(compareByUpdatedThenIdDesc);

    return decisions.slice(0, limit).map((decision) => deepClone(decision));
  }

  countPolicyDecisions(
    spaceId: string,
    options: PolicyDecisionListOptions = {}
  ): number {
    return this.listPolicyDecisions(spaceId, {
      ...options,
      limit: Number.MAX_SAFE_INTEGER,
    }).length;
  }
}

function tokenize(text: unknown): string[] {
  return asSortedUniqueStrings(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter(Boolean)
  );
}

function scoreMatch(
  document: TokenizedSearchDocument,
  queryTokens: readonly string[],
  queryString: string
): number {
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
  #docsBySpace = new Map<string, Map<string, KeywordDocument>>();

  #getSpaceMap(spaceId: string): Map<string, KeywordDocument> {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, KeywordDocument>();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  override upsert(rawDocument: KeywordDocumentInput): KeywordDocument {
    const id = rawDocument?.id;
    const spaceId = rawDocument?.spaceId;
    const kind = rawDocument?.kind;
    const text = String(rawDocument?.text ?? "");

    if (typeof id !== "string" || !id.trim()) {
      throw new ValidationError(
        "index document id must be a non-empty string",
        { id }
      );
    }
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError(
        "index document spaceId must be a non-empty string",
        { spaceId }
      );
    }
    if (typeof kind !== "string" || !kind.trim()) {
      throw new ValidationError(
        "index document kind must be a non-empty string",
        { kind }
      );
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

  override search(options: KeywordSearchOptions = {}): KeywordSearchResult[] {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError("search requires a non-empty spaceId");
    }
    const limit = toLimit(options.limit, 20);
    const kinds = asSortedUniqueStrings(options.kinds);
    const queryString = String(options.query ?? "")
      .toLowerCase()
      .trim();
    const queryTokens = tokenize(queryString);

    const docs = [...this.#getSpaceMap(spaceId).values()];
    const filtered =
      kinds.length > 0 ? docs.filter((doc) => kinds.includes(doc.kind)) : docs;

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
        const createdDiff = right.document.createdAt.localeCompare(
          left.document.createdAt
        );
        if (createdDiff !== 0) {
          return createdDiff;
        }
        return left.document.id.localeCompare(right.document.id);
      })
      .slice(0, limit)
      .map(
        ({ document, score }): KeywordSearchResult => ({
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
        })
      );

    return deepClone(ranked);
  }
}

export class InMemoryMisconceptionIndex extends MisconceptionIndexContract {
  #docsBySpace = new Map<string, Map<string, MisconceptionRecord>>();

  #getSpaceMap(spaceId: string): Map<string, MisconceptionRecord> {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, MisconceptionRecord>();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  override upsert(rawDocument: EntityInput): MisconceptionRecord {
    const incoming = createMisconceptionRecord(rawDocument);
    const docs = this.#getSpaceMap(incoming.spaceId);
    const existing = docs.get(incoming.id);
    const merged = existing
      ? mergeMisconceptionRecords(existing, incoming)
      : incoming;
    docs.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override search(
    options: MisconceptionSearchOptions = {}
  ): MisconceptionSearchResult[] {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError(
        "misconception search requires a non-empty spaceId"
      );
    }

    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const queryString = String(options.query ?? "")
      .toLowerCase()
      .trim();
    const queryTokens = tokenize(queryString);
    const limit = toLimit(options.limit, 50);

    const matches = [...this.#getSpaceMap(spaceId).values()]
      .filter((document) =>
        profileId ? document.profileId === profileId : true
      )
      .filter((document) => (status ? document.status === status : true))
      .map((document) => {
        const searchText = `${document.misconceptionKey} ${document.tags.join(" ")}`;
        const score = scoreMatch(
          {
            tokenSet: new Set(tokenize(searchText)),
            textLower: searchText.toLowerCase(),
          },
          queryTokens,
          queryString
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
      .map(
        ({ document, score }): MisconceptionSearchResult => ({
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
        })
      );

    return deepClone(matches);
  }
}

export class InMemoryCurriculumPlannerIndex extends CurriculumPlannerIndexContract {
  #docsBySpace = new Map<string, Map<string, CurriculumPlanItem>>();

  #getSpaceMap(spaceId: string): Map<string, CurriculumPlanItem> {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, CurriculumPlanItem>();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  override upsert(rawDocument: EntityInput): CurriculumPlanItem {
    const incoming = createCurriculumPlanItem(rawDocument);
    const docs = this.#getSpaceMap(incoming.spaceId);
    const existing = docs.get(incoming.id);
    const merged = existing
      ? mergeCurriculumPlanItems(existing, incoming)
      : incoming;
    docs.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override listRecommendations(
    options: CurriculumRecommendationOptions = {}
  ): CurriculumRecommendation[] {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError(
        "curriculum recommendation listing requires a non-empty spaceId"
      );
    }

    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const status = typeof options.status === "string" ? options.status : null;
    const dueBefore =
      options.dueBefore === undefined ||
      options.dueBefore === null ||
      options.dueBefore === ""
        ? null
        : toIsoTimestamp(options.dueBefore);
    const limit = toLimit(options.limit, 50);

    const docs = [...this.#getSpaceMap(spaceId).values()]
      .filter((document) =>
        profileId ? document.profileId === profileId : true
      )
      .filter((document) => (status ? document.status === status : true))
      .filter((document) =>
        dueBefore ? (document.dueAt ? document.dueAt <= dueBefore : true) : true
      )
      .sort(compareByRankThenUpdatedThenId)
      .slice(0, limit)
      .map(
        (document): CurriculumRecommendation => ({
          id: document.id,
          spaceId: document.spaceId,
          profileId: document.profileId,
          objectiveId: document.objectiveId,
          status: document.status,
          recommendationRank: document.recommendationRank,
          dueAt: document.dueAt,
          evidenceEpisodeIds: deepClone(document.evidenceEpisodeIds),
          sourceMisconceptionIds: deepClone(document.sourceMisconceptionIds),
        })
      );

    return deepClone(docs);
  }
}

export class InMemorySpacedRepetitionIndex extends SpacedRepetitionIndexContract {
  #docsBySpace = new Map<string, Map<string, ReviewScheduleEntry>>();

  #getSpaceMap(spaceId: string): Map<string, ReviewScheduleEntry> {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, ReviewScheduleEntry>();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  override upsert(rawDocument: EntityInput): ReviewScheduleEntry {
    const incoming = createReviewScheduleEntry(rawDocument);
    const docs = this.#getSpaceMap(incoming.spaceId);
    const existing = docs.get(incoming.id);
    const merged = existing
      ? mergeReviewScheduleEntries(existing, incoming)
      : incoming;
    docs.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override listDue(options: DueListOptions = {}): DueReviewResult[] {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError(
        "spaced repetition due listing requires a non-empty spaceId"
      );
    }

    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const asOf = toIsoTimestamp(options.asOf);
    const limit = toLimit(options.limit, 50);

    const docs = [...this.#getSpaceMap(spaceId).values()]
      .filter((document) =>
        profileId ? document.profileId === profileId : true
      )
      .filter((document) => document.dueAt <= asOf)
      .sort(compareByDueThenUpdatedThenId)
      .slice(0, limit)
      .map(
        (document): DueReviewResult => ({
          id: document.id,
          spaceId: document.spaceId,
          profileId: document.profileId,
          targetId: document.targetId,
          status: document.status,
          dueAt: document.dueAt,
          intervalDays: document.intervalDays,
          repetition: document.repetition,
          sourceEventIds: deepClone(document.sourceEventIds),
        })
      );

    return deepClone(docs);
  }
}

export class InMemoryPersonalizationPolicyIndex extends PersonalizationPolicyIndexContract {
  #docsBySpace = new Map<string, Map<string, PersonalizationPolicyDecision>>();

  #getSpaceMap(spaceId: string): Map<string, PersonalizationPolicyDecision> {
    const existing = this.#docsBySpace.get(spaceId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, PersonalizationPolicyDecision>();
    this.#docsBySpace.set(spaceId, map);
    return map;
  }

  override upsert(rawDocument: EntityInput): PersonalizationPolicyDecision {
    const incoming = createPersonalizationPolicyDecision(rawDocument);
    const docs = this.#getSpaceMap(incoming.spaceId);
    const existing = docs.get(incoming.id);
    const merged = existing
      ? mergePolicyDecisions(existing, incoming)
      : incoming;
    docs.set(merged.id, deepFreeze(deepClone(merged)));
    return deepClone(merged);
  }

  override search(options: PolicySearchOptions = {}): PolicySearchResult[] {
    const spaceId = options.spaceId;
    if (typeof spaceId !== "string" || !spaceId.trim()) {
      throw new ValidationError(
        "policy decision search requires a non-empty spaceId"
      );
    }

    const profileId =
      typeof options.profileId === "string" ? options.profileId : null;
    const policyKey =
      typeof options.policyKey === "string" ? options.policyKey : null;
    const outcome =
      typeof options.outcome === "string" ? options.outcome : null;
    const queryString = String(options.query ?? "")
      .toLowerCase()
      .trim();
    const queryTokens = tokenize(queryString);
    const limit = toLimit(options.limit, 50);

    const docs = [...this.#getSpaceMap(spaceId).values()]
      .filter((document) =>
        profileId ? document.profileId === profileId : true
      )
      .filter((document) =>
        policyKey ? document.policyKey === policyKey : true
      )
      .filter((document) => (outcome ? document.outcome === outcome : true))
      .map((document) => {
        const searchText = `${document.policyKey} ${document.reasonCodes.join(" ")} ${document.outcome}`;
        const score = scoreMatch(
          {
            tokenSet: new Set(tokenize(searchText)),
            textLower: searchText.toLowerCase(),
          },
          queryTokens,
          queryString
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
      .map(
        ({ document, score }): PolicySearchResult => ({
          id: document.id,
          auditId: document.auditId,
          spaceId: document.spaceId,
          profileId: document.profileId,
          policyKey: document.policyKey,
          outcome: document.outcome,
          reasonCodes: deepClone(document.reasonCodes),
          evaluatedAt: document.evaluatedAt,
          score,
        })
      );

    return deepClone(docs);
  }
}
