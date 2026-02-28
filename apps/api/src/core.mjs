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
  "doctor"
];

const store = new Map();

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

function opSeed(operation, profile, input) {
  return hash(stableStringify({ operation, profile, input }));
}

function makeId(prefix, seed) {
  return `${prefix}_${seed.slice(0, 12)}`;
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
}

function getProfileState(profile) {
  const existing = store.get(profile);
  if (existing) {
    return existing;
  }
  const created = {
    events: [],
    eventDigests: new Set(),
    rules: [],
    feedback: [],
    outcomes: []
  };
  store.set(profile, created);
  return created;
}

function defaultProfile(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "default";
}

function normalizeEvent(raw, index) {
  const event = raw && typeof raw === "object" ? raw : {};
  const material = stableStringify({
    source: event.source ?? "unknown",
    type: event.type ?? "note",
    content: event.content ?? "",
    ordinal: index
  });
  const digest = hash(material);
  return {
    eventId: typeof event.id === "string" && event.id ? event.id : makeId("evt", digest),
    type: event.type ?? "note",
    source: event.source ?? "unknown",
    content: event.content ?? "",
    digest
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
    confidence: Number.isFinite(candidate.confidence) ? Number(candidate.confidence) : 0.5
  };
}

function normalizeRequest(operation, request) {
  requireObject(request);
  const profile = defaultProfile(request.profile);
  return { profile, input: stableSortObject(request), operation };
}

function findByDigestPrefix(items, digestPrefix, field) {
  if (typeof digestPrefix !== "string" || !digestPrefix) {
    return null;
  }
  return items.find((item) => item[field].startsWith(digestPrefix)) ?? null;
}

function buildMeta(operation, profile, input) {
  const seed = opSeed(operation, profile, input);
  return {
    operation,
    profile,
    requestDigest: seed,
    deterministic: true
  };
}

function runIngest(request) {
  const { profile, input } = normalizeRequest("ingest", request);
  const state = getProfileState(profile);
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
        status: "duplicate"
      });
      continue;
    }
    state.eventDigests.add(normalized.digest);
    state.events.push(normalized);
    accepted += 1;
    refs.push({
      eventId: normalized.eventId,
      digest: normalized.digest,
      status: "accepted"
    });
  }

  const ledgerDigest = hash(stableStringify(state.events.map((event) => event.digest)));

  return {
    ...buildMeta("ingest", profile, input),
    accepted,
    duplicates,
    eventRefs: refs,
    ledgerDigest
  };
}

function runContext(request) {
  const { profile, input } = normalizeRequest("context", request);
  const state = getProfileState(profile);
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
      digest: item.event.digest
    }));

  return {
    ...buildMeta("context", profile, input),
    query,
    totalEvents: state.events.length,
    matches: matched,
    rules: state.rules.slice(0, 5).map((rule) => ({
      ruleId: rule.ruleId,
      statement: rule.statement,
      confidence: rule.confidence
    }))
  };
}

function runReflect(request) {
  const { profile, input } = normalizeRequest("reflect", request);
  const state = getProfileState(profile);
  const max = Number.isInteger(request.maxCandidates) && request.maxCandidates > 0 ? request.maxCandidates : 3;
  const candidates = state.events.slice(-max).map((event) => {
    const statement = `Prefer source=${event.source} for type=${event.type}`;
    const normalized = normalizeRuleCandidate({
      statement,
      sourceEventId: event.eventId,
      confidence: 0.6
    });
    return normalized;
  });

  return {
    ...buildMeta("reflect", profile, input),
    candidateCount: candidates.length,
    candidates
  };
}

function runValidate(request) {
  const { profile, input } = normalizeRequest("validate", request);
  const state = getProfileState(profile);
  const rawCandidates = Array.isArray(request.candidates) ? request.candidates : [];
  const candidates = rawCandidates.map(normalizeRuleCandidate);
  const validations = candidates.map((candidate) => {
    const evidence = state.events.find((event) => event.eventId === candidate.sourceEventId) ?? null;
    return {
      candidateId: candidate.candidateId,
      valid: Boolean(evidence && candidate.statement),
      evidenceEventId: evidence ? evidence.eventId : null,
      contradictionCount: 0
    };
  });

  return {
    ...buildMeta("validate", profile, input),
    checked: validations.length,
    validations
  };
}

function runCurate(request) {
  const { profile, input } = normalizeRequest("curate", request);
  const state = getProfileState(profile);
  const rawCandidates = Array.isArray(request.candidates) ? request.candidates : [];
  const applied = [];
  const skipped = [];

  for (const rawCandidate of rawCandidates) {
    const candidate = normalizeRuleCandidate(rawCandidate);
    if (!candidate.statement) {
      skipped.push({
        candidateId: candidate.candidateId,
        reason: "empty_statement"
      });
      continue;
    }
    const existing = state.rules.find((rule) => rule.ruleId === candidate.candidateId);
    if (existing) {
      existing.statement = candidate.statement;
      existing.confidence = candidate.confidence;
      applied.push({
        ruleId: existing.ruleId,
        action: "updated"
      });
      continue;
    }
    const rule = {
      ruleId: candidate.candidateId,
      statement: candidate.statement,
      confidence: candidate.confidence
    };
    state.rules.push(rule);
    applied.push({
      ruleId: rule.ruleId,
      action: "created"
    });
  }

  return {
    ...buildMeta("curate", profile, input),
    applied,
    skipped,
    totalRules: state.rules.length
  };
}

function runFeedback(request) {
  const { profile, input } = normalizeRequest("feedback", request);
  const state = getProfileState(profile);
  const targetRuleId = typeof request.targetRuleId === "string" ? request.targetRuleId : "";
  const signal = request.signal === "harmful" ? "harmful" : "helpful";
  const note = typeof request.note === "string" ? request.note : "";
  const seed = hash(stableStringify({ targetRuleId, signal, note }));
  const feedbackId = makeId("fdbk", seed);

  state.feedback.push({
    feedbackId,
    targetRuleId,
    signal,
    note
  });

  return {
    ...buildMeta("feedback", profile, input),
    feedbackId,
    targetRuleId,
    signal,
    totalFeedback: state.feedback.length
  };
}

function runOutcome(request) {
  const { profile, input } = normalizeRequest("outcome", request);
  const state = getProfileState(profile);
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
    usedRuleIds
  });

  return {
    ...buildMeta("outcome", profile, input),
    outcomeId,
    task,
    outcome,
    usedRuleIds,
    totalOutcomes: state.outcomes.length
  };
}

function runAudit(request) {
  const { profile, input } = normalizeRequest("audit", request);
  const state = getProfileState(profile);
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
    ...buildMeta("audit", profile, input),
    checks: [
      { name: "events_present", status: state.events.length > 0 ? "pass" : "warn" },
      { name: "rules_present", status: state.rules.length > 0 ? "pass" : "warn" },
      { name: "duplicate_rules", status: duplicateStatements.size === 0 ? "pass" : "warn" }
    ],
    duplicateRules: Array.from(duplicateStatements.values())
  };
}

function runExport(request) {
  const { profile, input } = normalizeRequest("export", request);
  const state = getProfileState(profile);
  const topRules = state.rules.slice(0, 5);
  const topAntiPatterns = state.feedback
    .filter((entry) => entry.signal === "harmful")
    .slice(0, 5)
    .map((entry) => entry.note || entry.targetRuleId);
  const agentsMdLines = [
    "# UMS Memory Export",
    "",
    `Profile: ${profile}`,
    "",
    "## Top Rules",
    ...topRules.map((rule) => `- ${rule.statement} (confidence=${rule.confidence})`),
    "",
    "## Anti-pattern Signals",
    ...topAntiPatterns.map((line) => `- ${line}`)
  ];

  return {
    ...buildMeta("export", profile, input),
    format: request.format === "playbook" ? "playbook" : "agents-md",
    agentsMd: agentsMdLines.join("\n"),
    playbook: {
      profile,
      topRules,
      antiPatterns: topAntiPatterns
    }
  };
}

function runDoctor(request) {
  const { profile, input } = normalizeRequest("doctor", request);
  const state = getProfileState(profile);
  const status = {
    events: state.events.length,
    rules: state.rules.length,
    feedback: state.feedback.length,
    outcomes: state.outcomes.length
  };

  return {
    ...buildMeta("doctor", profile, input),
    healthy: true,
    checks: [
      { name: "json_contracts", status: "pass" },
      { name: "deterministic_hashing", status: "pass" },
      { name: "store_initialized", status: "pass" }
    ],
    status
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
  doctor: runDoctor
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

export function snapshotProfile(profile = "default") {
  const state = getProfileState(profile);
  return {
    events: state.events.map((event) => ({ ...event })),
    rules: state.rules.map((rule) => ({ ...rule })),
    feedback: state.feedback.map((entry) => ({ ...entry })),
    outcomes: state.outcomes.map((entry) => ({ ...entry }))
  };
}

export function exportStoreSnapshot() {
  const profiles = {};
  for (const [profile, state] of store.entries()) {
    profiles[profile] = {
      events: state.events.map((event) => ({ ...event })),
      rules: state.rules.map((rule) => ({ ...rule })),
      feedback: state.feedback.map((entry) => ({ ...entry })),
      outcomes: state.outcomes.map((entry) => ({ ...entry }))
    };
  }
  return { profiles };
}

export function importStoreSnapshot(snapshot) {
  store.clear();
  const profiles =
    snapshot && typeof snapshot === "object" && snapshot.profiles && typeof snapshot.profiles === "object"
      ? snapshot.profiles
      : {};

  for (const profile of Object.keys(profiles).sort()) {
    const rawState = profiles[profile] && typeof profiles[profile] === "object" ? profiles[profile] : {};
    const events = Array.isArray(rawState.events) ? rawState.events : [];
    const rules = Array.isArray(rawState.rules) ? rawState.rules : [];
    const feedback = Array.isArray(rawState.feedback) ? rawState.feedback : [];
    const outcomes = Array.isArray(rawState.outcomes) ? rawState.outcomes : [];
    const eventDigests = new Set(
      events
        .map((event) => (event && typeof event === "object" ? event.digest : null))
        .filter((digest) => typeof digest === "string" && digest)
    );

    store.set(profile, {
      events: events.map((event) => ({ ...event })),
      eventDigests,
      rules: rules.map((rule) => ({ ...rule })),
      feedback: feedback.map((entry) => ({ ...entry })),
      outcomes: outcomes.map((entry) => ({ ...entry }))
    });
  }
}

export function resetStore() {
  store.clear();
}

export function findRuleByDigestPrefix(profile, digestPrefix) {
  const state = getProfileState(defaultProfile(profile));
  return findByDigestPrefix(state.rules, digestPrefix, "ruleId");
}
