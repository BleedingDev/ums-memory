import {
  createAntiPattern,
  createProceduralRule,
  createWorkingMemoryEntry,
  ProceduralEntryStatus,
} from "./entities.js";
import { ContractViolationError, ValidationError } from "./errors.js";
import { asSortedUniqueStrings, deepClone, deepFreeze, toIsoTimestamp } from "./utils.js";

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
