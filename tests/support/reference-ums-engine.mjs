import { createHash } from "node:crypto";

const DEFAULTS = Object.freeze({
  seed: "ums-reference-v1",
  defaultSpace: "default",
  defaultMaxItems: 10,
  defaultTokenBudget: 256,
  maxMaxItems: 100,
  maxTokenBudget: 8192,
});

const UNSAFE_PATTERNS = Object.freeze([
  /ignore\s+previous\s+instructions/i,
  /reveal\s+system\s+prompt/i,
  /\bexfiltrate\b/i,
]);

function estimateTokens(content) {
  return Math.max(1, Math.ceil(String(content).length / 4));
}

function sha256(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

function hashToUnit(input) {
  const hex = sha256(input).slice(0, 12);
  return Number.parseInt(hex, 16) / Number.parseInt("ffffffffffff", 16);
}

function normalizeTimestamp(value) {
  if (!value) {
    return "1970-01-01T00:00:00.000Z";
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) {
    return "1970-01-01T00:00:00.000Z";
  }
  return date.toISOString();
}

function normalizeText(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serializedItems = value.map((item) => stableStringify(item));
    return `[${serializedItems.join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const serializedPairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${serializedPairs.join(",")}}`;
}

function tokenize(text) {
  return new Set(
    normalizeText(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length > 1)
  );
}

function compareEvents(a, b) {
  if (a.timestamp !== b.timestamp) {
    return b.timestamp.localeCompare(a.timestamp);
  }
  return a.id.localeCompare(b.id);
}

function redactSecrets(content) {
  let output = String(content);
  let count = 0;

  output = output.replace(/sk-[A-Za-z0-9]{8,}/g, () => {
    count += 1;
    return "[REDACTED_SECRET]";
  });

  output = output.replace(/(\b(?:api[_-]?key|token|password)\s*[:=]\s*)([^\s,;]+)/gi, (_match, prefix) => {
    count += 1;
    return `${prefix}[REDACTED]`;
  });

  output = output.replace(/\b[A-Fa-f0-9]{32,}\b/g, () => {
    count += 1;
    return "[REDACTED_SECRET]";
  });

  return { text: output, count };
}

function createSyntheticId(event) {
  const fingerprint = stableStringify({
    space: event.space,
    source: event.source,
    timestamp: event.timestamp,
    content: event.content,
    tags: event.tags,
    metadata: event.metadata,
  });
  return `evt-${sha256(fingerprint).slice(0, 16)}`;
}

function normalizeEvent(rawEvent, defaultSpace) {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  const space = normalizeText(rawEvent.space || defaultSpace);
  if (!space) {
    return null;
  }

  const contentCandidate = rawEvent.content ?? rawEvent.text ?? rawEvent.message ?? rawEvent.payload ?? "";
  const content =
    typeof contentCandidate === "string" ? contentCandidate : stableStringify(contentCandidate);
  const timestamp = normalizeTimestamp(rawEvent.timestamp || rawEvent.createdAt || rawEvent.occurredAt);
  const source = normalizeText(rawEvent.source) || "unknown";
  const tags = Array.isArray(rawEvent.tags)
    ? [...new Set(rawEvent.tags.map((tag) => normalizeText(tag)).filter(Boolean))].sort()
    : [];
  const metadata =
    rawEvent.metadata && typeof rawEvent.metadata === "object" && !Array.isArray(rawEvent.metadata)
      ? { ...rawEvent.metadata }
      : {};

  const normalized = {
    id: normalizeText(rawEvent.id),
    space,
    source,
    timestamp,
    content,
    tags,
    metadata,
  };

  if (!normalized.id) {
    normalized.id = createSyntheticId(normalized);
  }
  return normalized;
}

function eventScore(query, event, seed) {
  const queryTokens = tokenize(query);
  const contentTokens = tokenize(event.content);
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlap += 1;
    }
  }
  const tieBreaker = hashToUnit(`${seed}|${query}|${event.id}|${event.timestamp}`) * 0.01;
  return overlap + tieBreaker;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number.parseInt(String(value), 10);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function getBucket(spaces, space) {
  if (!spaces.has(space)) {
    spaces.set(space, new Map());
  }
  return spaces.get(space);
}

function exportEvent(record) {
  return {
    id: record.id,
    space: record.space,
    source: record.source,
    timestamp: record.timestamp,
    content: record.content,
    tags: record.tags,
    metadata: record.metadata,
    flags: record.flags,
  };
}

function importSnapshot(spaces, snapshot, defaultSpace) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.spaces)) {
    return;
  }

  for (const spaceEntry of snapshot.spaces) {
    const entrySpace = normalizeText(spaceEntry?.space || defaultSpace);
    const events = Array.isArray(spaceEntry?.events) ? spaceEntry.events : [];
    for (const rawEvent of events) {
      const normalized = normalizeEvent({ ...rawEvent, space: entrySpace }, defaultSpace);
      if (!normalized) {
        continue;
      }
      const redaction = redactSecrets(normalized.content);
      const unsafeInstruction = UNSAFE_PATTERNS.some((pattern) => pattern.test(redaction.text));
      const bucket = getBucket(spaces, normalized.space);
      bucket.set(normalized.id, {
        ...normalized,
        content: redaction.text,
        flags: {
          hasSecret: redaction.count > 0,
          unsafeInstruction,
        },
        tokenEstimate: estimateTokens(redaction.text),
      });
    }
  }
}

export function createUmsEngine(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const unsafePatterns = options.unsafePatterns ?? UNSAFE_PATTERNS;
  const spaces = new Map();

  importSnapshot(spaces, options.initialState, config.defaultSpace);

  function totalEvents() {
    let total = 0;
    for (const bucket of spaces.values()) {
      total += bucket.size;
    }
    return total;
  }

  function ingest(input) {
    const events = Array.isArray(input) ? input : [input];
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    let redactedSecrets = 0;
    let unsafeInstructions = 0;

    for (const rawEvent of events) {
      const normalized = normalizeEvent(rawEvent, config.defaultSpace);
      if (!normalized) {
        rejected += 1;
        continue;
      }

      const bucket = getBucket(spaces, normalized.space);
      if (bucket.has(normalized.id)) {
        duplicates += 1;
        continue;
      }

      const redaction = redactSecrets(normalized.content);
      const unsafeInstruction = unsafePatterns.some((pattern) => pattern.test(redaction.text));
      if (unsafeInstruction) {
        unsafeInstructions += 1;
      }
      redactedSecrets += redaction.count;

      bucket.set(normalized.id, {
        ...normalized,
        content: redaction.text,
        flags: {
          hasSecret: redaction.count > 0,
          unsafeInstruction,
        },
        tokenEstimate: estimateTokens(redaction.text),
      });
      accepted += 1;
    }

    return {
      accepted,
      duplicates,
      rejected,
      stats: {
        spaceCount: spaces.size,
        totalEvents: totalEvents(),
        redactedSecrets,
        unsafeInstructions,
      },
    };
  }

  function recall(request = {}) {
    const payload = typeof request === "string" ? { query: request } : request;
    const space = normalizeText(payload.space || config.defaultSpace);
    const query = normalizeText(payload.query || payload.text);
    const includeUnsafe = Boolean(payload.includeUnsafe);
    const maxItems = clampInteger(
      payload.maxItems,
      1,
      config.maxMaxItems,
      config.defaultMaxItems
    );
    const tokenBudget = clampInteger(
      payload.tokenBudget,
      1,
      config.maxTokenBudget,
      config.defaultTokenBudget
    );

    const bucket = spaces.get(space) ?? new Map();
    const ranked = [];
    let filteredUnsafe = 0;

    for (const event of bucket.values()) {
      if (event.flags.unsafeInstruction && !includeUnsafe) {
        filteredUnsafe += 1;
        continue;
      }
      ranked.push({
        event,
        score: eventScore(query, event, config.seed),
      });
    }

    ranked.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return compareEvents(a.event, b.event);
    });

    const items = [];
    let estimatedTokens = 0;

    for (const rankedEvent of ranked) {
      if (items.length >= maxItems) {
        break;
      }
      if (estimatedTokens + rankedEvent.event.tokenEstimate > tokenBudget) {
        continue;
      }

      estimatedTokens += rankedEvent.event.tokenEstimate;
      items.push({
        id: rankedEvent.event.id,
        space: rankedEvent.event.space,
        source: rankedEvent.event.source,
        timestamp: rankedEvent.event.timestamp,
        content: rankedEvent.event.content,
        score: Number(rankedEvent.score.toFixed(6)),
        flags: { ...rankedEvent.event.flags },
        evidence: {
          episodeId: rankedEvent.event.id,
          source: rankedEvent.event.source,
        },
      });
    }

    const payloadBytes = Buffer.byteLength(JSON.stringify(items), "utf8");

    return {
      query,
      space,
      maxItems,
      tokenBudget,
      estimatedTokens,
      payloadBytes,
      truncated: items.length < ranked.length,
      items,
      guardrails: {
        filteredUnsafe,
        redactedSecrets: items.filter((item) => item.flags.hasSecret).length,
        spaceIsolationEnforced: true,
      },
    };
  }

  function getEventCount(space) {
    if (space) {
      return (spaces.get(space) ?? new Map()).size;
    }
    return totalEvents();
  }

  function exportState() {
    const serializedSpaces = [...spaces.entries()]
      .sort(([spaceA], [spaceB]) => spaceA.localeCompare(spaceB))
      .map(([space, bucket]) => {
        const events = [...bucket.values()].sort(compareEvents).map(exportEvent);
        return { space, events };
      });

    return {
      spaces: serializedSpaces,
      totals: {
        spaceCount: serializedSpaces.length,
        eventCount: totalEvents(),
      },
    };
  }

  function stateDigest() {
    return sha256(stableStringify(exportState()));
  }

  return {
    ingest,
    recall,
    getEventCount,
    exportState,
    stateDigest,
  };
}
