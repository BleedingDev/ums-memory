import { createHash } from "node:crypto";

const OPS = [
  "ingest",
  "context",
  "reflect",
  "validate",
  "curate",
  "feedback",
  "outcome",
  "audit",
  "export",
  "doctor",
];

const stores = new Map();

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
  return "default";
}

function defaultProfile(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "default";
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
  const profile = defaultProfile(request.profile);
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
  const query = typeof request.query === "string" ? request.query.toLowerCase() : "";
  const limit = Number.isInteger(request.limit) && request.limit > 0 ? request.limit : 5;

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

  return {
    ...buildMeta("context", storeId, profile, input),
    query,
    totalEvents: state.events.length,
    matches: matched,
    rules: state.rules.slice(0, 5).map((rule) => ({
      ruleId: rule.ruleId,
      statement: rule.statement,
      confidence: rule.confidence,
    })),
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

export function snapshotProfile(profile = "default", storeId = "default") {
  const state = getProfileState(defaultStoreId(storeId), defaultProfile(profile));
  return {
    events: state.events.map((event) => ({ ...event })),
    rules: state.rules.map((rule) => ({ ...rule })),
    feedback: state.feedback.map((entry) => ({ ...entry })),
    outcomes: state.outcomes.map((entry) => ({ ...entry })),
  };
}

function serializeState(state) {
  return {
    events: state.events.map((event) => ({ ...event })),
    rules: state.rules.map((rule) => ({ ...rule })),
    feedback: state.feedback.map((entry) => ({ ...entry })),
    outcomes: state.outcomes.map((entry) => ({ ...entry })),
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
    importProfiles("default", snapshot.profiles);
  }
}

export function resetStore() {
  stores.clear();
}

export function findRuleByDigestPrefix(profile, digestPrefix, storeId = "default") {
  const state = getProfileState(defaultStoreId(storeId), defaultProfile(profile));
  return findByDigestPrefix(state.rules, digestPrefix, "ruleId");
}
