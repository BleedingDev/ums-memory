import { createHash } from "node:crypto";

const DEFAULTS = Object.freeze({
  seed: "ums-engine-v1",
  defaultStore: "default",
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
      .filter((token) => token.length > 1),
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

function normalizeStoreId(value, fallback) {
  const normalized = normalizeText(value);
  return normalized || fallback;
}

function toObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function toBodyText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toBodyText(entry)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const candidate = value;
    if (typeof candidate.text === "string") {
      return candidate.text;
    }
    if (typeof candidate.value === "string") {
      return candidate.value;
    }
    if (typeof candidate.content === "string") {
      return candidate.content;
    }
    if (Array.isArray(candidate.content)) {
      return candidate.content.map((entry) => toBodyText(entry)).filter(Boolean).join("\n");
    }
  }
  return stableStringify(value);
}

function joinNonEmpty(lines) {
  return lines.map((entry) => normalizeText(entry)).filter(Boolean).join("\n");
}

function createSyntheticId(event) {
  const fingerprint = stableStringify({
    storeId: event.storeId,
    space: event.space,
    source: event.source,
    timestamp: event.timestamp,
    content: event.content,
    tags: event.tags,
    metadata: event.metadata,
  });
  return `evt-${sha256(fingerprint).slice(0, 16)}`;
}

function looksLikeJiraIssue(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (typeof value.key === "string" ||
        (value.fields && typeof value.fields === "object" && !Array.isArray(value.fields))),
  );
}

function looksLikeConversation(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray(value.messages) &&
      (typeof value.id === "string" || typeof value.conversationId === "string"),
  );
}

function makeContext(input, defaults, inherited = {}) {
  const raw = toObject(input);
  return {
    storeId: normalizeStoreId(
      raw.storeId ?? raw.store ?? raw.memoryStore ?? raw.namespace ?? inherited.storeId,
      defaults.defaultStore,
    ),
    space: normalizeText(raw.space ?? raw.project ?? raw.channel ?? inherited.space) || defaults.defaultSpace,
    source: normalizeText(raw.source ?? raw.connector ?? raw.platform ?? inherited.source),
    platform: normalizeText(raw.platform ?? inherited.platform),
    jiraBaseUrl: normalizeText(raw.jiraBaseUrl ?? inherited.jiraBaseUrl),
  };
}

function normalizeConversationMessage(rawMessage, context, index) {
  const message = toObject(rawMessage);
  const role = normalizeText(message.role || message.authorRole || message.speaker).toLowerCase() || "unknown";
  const conversationId =
    normalizeText(message.conversationId || context.conversationId) || `conversation-${context.space}`;
  const messageId = normalizeText(message.id || message.messageId) || `${conversationId}-msg-${index}`;

  const content = joinNonEmpty([
    typeof message.content === "string" ? message.content : "",
    typeof message.text === "string" ? message.text : "",
    typeof message.message === "string" ? message.message : "",
    typeof message.body === "string" ? message.body : "",
  ]);
  const normalizedContent = content || toBodyText(message.content ?? message.payload ?? message);

  return {
    id: messageId,
    storeId: context.storeId,
    space: context.space,
    source: context.source || `agent-conversation:${context.platform || "unknown"}`,
    timestamp: normalizeTimestamp(message.createdAt || message.timestamp || message.ts || message.time),
    content: normalizedContent,
    tags: [context.platform || "conversation", role].filter(Boolean),
    metadata: {
      role,
      conversationId,
      platform: context.platform || "unknown",
      messageIndex: index,
      meta: message.meta && typeof message.meta === "object" ? message.meta : undefined,
    },
  };
}

function normalizeFerndeskConversation(rawConversation, context) {
  const conversation = toObject(rawConversation);
  const explicitConversationId = normalizeText(conversation.id || conversation.conversationId);
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const fallbackSeed = stableStringify({
    space: context.space,
    source: context.source,
    ordinal: context.conversationOrdinal ?? 0,
    sample: messages.slice(0, 2).map((entry) => ({
      id: normalizeText(entry?.id),
      role: normalizeText(entry?.role),
      text: normalizeText(entry?.text ?? entry?.message ?? entry?.content ?? ""),
    })),
  });
  const conversationId =
    explicitConversationId || `conversation-${sha256(fallbackSeed).slice(0, 12)}`;
  const platform = context.platform || "jira-ferndesk";

  if (messages.length > 0) {
    return messages.map((message, index) =>
      normalizeConversationMessage(message, { ...context, conversationId, platform }, index),
    );
  }

  const summaryContent = joinNonEmpty([
    normalizeText(conversation.title),
    normalizeText(conversation.description),
  ]);
  if (!summaryContent) {
    return [];
  }

  return [
    {
      id: `${conversationId}-summary`,
      storeId: context.storeId,
      space: context.space,
      source: context.source || "jira",
      timestamp: normalizeTimestamp(conversation.lastMessageAt || conversation.updatedAt),
      content: summaryContent,
      tags: ["jira", "summary"],
      metadata: {
        conversationId,
        url: normalizeText(conversation.url) || undefined,
      },
    },
  ];
}

function normalizeJiraIssue(rawIssue, context, index) {
  const issue = toObject(rawIssue);
  const fields = toObject(issue.fields);
  const issueKey = normalizeText(issue.key || issue.id || `jira-issue-${index}`);
  const description = toBodyText(fields.description);
  const summary = normalizeText(fields.summary || issue.summary || issueKey);
  const createdAt = normalizeTimestamp(fields.created || issue.createdAt || fields.updated || issue.updatedAt);
  const commentsFromField = Array.isArray(fields.comments)
    ? fields.comments
    : Array.isArray(toObject(fields.comment).comments)
      ? toObject(fields.comment).comments
      : [];
  const comments = Array.isArray(issue.comments) ? issue.comments : commentsFromField;

  const issueEvent = {
    id: `jira-${issueKey}-summary`,
    storeId: context.storeId,
    space: context.space,
    source: context.source || "jira",
    timestamp: createdAt,
    content: joinNonEmpty([
      `[${issueKey}] ${summary}`,
      description ? `Description: ${description}` : "",
    ]),
    tags: ["jira", "issue"],
    metadata: {
      issueKey,
      issueId: normalizeText(issue.id) || undefined,
      status: normalizeText(toObject(fields.status).name) || undefined,
      priority: normalizeText(toObject(fields.priority).name) || undefined,
      url: context.jiraBaseUrl ? `${context.jiraBaseUrl.replace(/\/$/, "")}/browse/${issueKey}` : undefined,
    },
  };

  const commentEvents = comments.map((rawComment, commentIndex) => {
    const comment = toObject(rawComment);
    const author = toObject(comment.author);
    const authorName =
      normalizeText(author.displayName || author.name || author.accountId) || "unknown-author";
    const publicFlag =
      comment.public == null ? undefined : comment.public ? "public" : "private";
    return {
      id: `jira-${issueKey}-comment-${normalizeText(comment.id) || commentIndex}`,
      storeId: context.storeId,
      space: context.space,
      source: context.source || "jira-comment",
      timestamp: normalizeTimestamp(comment.created || comment.createdAt || issueEvent.timestamp),
      content: joinNonEmpty([
        `Comment by ${authorName}`,
        publicFlag ? `Visibility: ${publicFlag}` : "",
        toBodyText(comment.body || comment.content || comment.text),
      ]),
      tags: ["jira", "comment"],
      metadata: {
        issueKey,
        commentId: normalizeText(comment.id) || undefined,
        author: authorName,
        public: comment.public == null ? undefined : Boolean(comment.public),
      },
    };
  });

  return [issueEvent, ...commentEvents];
}

function toRawEvents(input, defaults, inherited = {}) {
  if (Array.isArray(input)) {
    return input.flatMap((entry) => toRawEvents(entry, defaults, inherited));
  }

  if (!input || typeof input !== "object") {
    const context = makeContext({}, defaults, inherited);
    return [
      {
        storeId: context.storeId,
        space: context.space,
        source: context.source || "unknown",
        timestamp: "1970-01-01T00:00:00.000Z",
        content: normalizeText(input),
        metadata: {},
      },
    ];
  }

  const context = makeContext(input, defaults, inherited);
  const envelope = toObject(input);

  if (Array.isArray(envelope.events)) {
    return envelope.events.flatMap((event) =>
      toRawEvents(event, defaults, {
        ...context,
        source: context.source || normalizeText(toObject(event).source),
      }),
    );
  }

  if (Array.isArray(envelope.conversations)) {
    return envelope.conversations.flatMap((conversation, conversationOrdinal) =>
      normalizeFerndeskConversation(conversation, {
        ...context,
        source: context.source || "jira",
        platform: context.platform || "jira-ferndesk",
        conversationOrdinal,
      }),
    );
  }

  if (Array.isArray(envelope.issues)) {
    return envelope.issues.flatMap((issue, index) =>
      normalizeJiraIssue(issue, { ...context, source: context.source || "jira" }, index),
    );
  }

  if (looksLikeConversation(envelope)) {
    return normalizeFerndeskConversation(envelope, {
      ...context,
      source: context.source || "agent-conversation",
      platform: context.platform || "agent-transcript",
    });
  }

  if (looksLikeJiraIssue(envelope)) {
    return normalizeJiraIssue(envelope, { ...context, source: context.source || "jira" }, 0);
  }

  return [envelope];
}

function normalizeEvent(rawEvent, defaults) {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  const storeId = normalizeStoreId(
    rawEvent.storeId ?? rawEvent.store ?? rawEvent.memoryStore,
    defaults.defaultStore,
  );
  const space =
    normalizeText(rawEvent.space || rawEvent.project || rawEvent.profile || defaults.defaultSpace) ||
    defaults.defaultSpace;
  if (!space) {
    return null;
  }

  const source =
    normalizeText(rawEvent.source || rawEvent.connector || rawEvent.platform || rawEvent.origin) || "unknown";
  const contentCandidate =
    rawEvent.content ??
    rawEvent.text ??
    rawEvent.message ??
    rawEvent.body ??
    rawEvent.payload ??
    rawEvent.summary ??
    "";
  const content = toBodyText(contentCandidate);
  const timestamp = normalizeTimestamp(
    rawEvent.timestamp || rawEvent.createdAt || rawEvent.occurredAt || rawEvent.updatedAt,
  );
  const tags = Array.isArray(rawEvent.tags)
    ? [...new Set(rawEvent.tags.map((tag) => normalizeText(tag)).filter(Boolean))].sort()
    : [];
  const metadata =
    rawEvent.metadata && typeof rawEvent.metadata === "object" && !Array.isArray(rawEvent.metadata)
      ? { ...rawEvent.metadata }
      : {};

  const role = normalizeText(rawEvent.role || rawEvent.authorRole).toLowerCase();
  if (role && !metadata.role) {
    metadata.role = role;
  }
  if (rawEvent.conversationId && !metadata.conversationId) {
    metadata.conversationId = normalizeText(rawEvent.conversationId);
  }
  if (rawEvent.issueKey && !metadata.issueKey) {
    metadata.issueKey = normalizeText(rawEvent.issueKey);
  }

  const normalized = {
    id: normalizeText(rawEvent.id),
    storeId,
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

function getStoreState(stores, storeId) {
  if (!stores.has(storeId)) {
    stores.set(storeId, { spaces: new Map() });
  }
  return stores.get(storeId);
}

function getSpaceBucket(storeState, space) {
  if (!storeState.spaces.has(space)) {
    storeState.spaces.set(space, new Map());
  }
  return storeState.spaces.get(space);
}

function exportEvent(record) {
  return {
    id: record.id,
    storeId: record.storeId,
    space: record.space,
    source: record.source,
    timestamp: record.timestamp,
    content: record.content,
    tags: record.tags,
    metadata: record.metadata,
    flags: record.flags,
  };
}

function importStoreEntry(stores, rawStoreId, rawSpaces, defaults) {
  const storeId = normalizeStoreId(rawStoreId, defaults.defaultStore);
  const storeState = getStoreState(stores, storeId);
  const spaces = Array.isArray(rawSpaces) ? rawSpaces : [];

  for (const spaceEntry of spaces) {
    const entrySpace = normalizeText(spaceEntry?.space || defaults.defaultSpace) || defaults.defaultSpace;
    const events = Array.isArray(spaceEntry?.events) ? spaceEntry.events : [];
    for (const rawEvent of events) {
      const normalized = normalizeEvent({ ...rawEvent, storeId, space: entrySpace }, defaults);
      if (!normalized) {
        continue;
      }
      const redaction = redactSecrets(normalized.content);
      const unsafeInstruction = UNSAFE_PATTERNS.some((pattern) => pattern.test(redaction.text));
      const bucket = getSpaceBucket(storeState, normalized.space);
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

function importSnapshot(stores, snapshot, defaults) {
  if (!snapshot || typeof snapshot !== "object") {
    return;
  }

  if (Array.isArray(snapshot.stores)) {
    for (const storeEntry of snapshot.stores) {
      importStoreEntry(stores, storeEntry?.storeId, storeEntry?.spaces, defaults);
    }
    return;
  }

  if (snapshot.stores && typeof snapshot.stores === "object" && !Array.isArray(snapshot.stores)) {
    for (const storeId of Object.keys(snapshot.stores).sort()) {
      const entry = snapshot.stores[storeId];
      importStoreEntry(stores, storeId, entry?.spaces, defaults);
    }
    return;
  }

  if (Array.isArray(snapshot.spaces)) {
    importStoreEntry(stores, defaults.defaultStore, snapshot.spaces, defaults);
  }
}

function totalEventsForStore(storeState) {
  let total = 0;
  for (const bucket of storeState.spaces.values()) {
    total += bucket.size;
  }
  return total;
}

function totalEvents(stores) {
  let total = 0;
  for (const storeState of stores.values()) {
    total += totalEventsForStore(storeState);
  }
  return total;
}

function totalSpaces(stores) {
  let total = 0;
  for (const storeState of stores.values()) {
    total += storeState.spaces.size;
  }
  return total;
}

export function createUmsEngine(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const unsafePatterns = options.unsafePatterns ?? UNSAFE_PATTERNS;
  const stores = new Map();

  importSnapshot(stores, options.initialState, config);

  function ingest(input) {
    const rawEvents = toRawEvents(input, config);
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    let redactedSecrets = 0;
    let unsafeInstructions = 0;

    for (const rawEvent of rawEvents) {
      const normalized = normalizeEvent(rawEvent, config);
      if (!normalized) {
        rejected += 1;
        continue;
      }

      const storeState = getStoreState(stores, normalized.storeId);
      const bucket = getSpaceBucket(storeState, normalized.space);
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
        storeCount: stores.size,
        spaceCount: totalSpaces(stores),
        totalEvents: totalEvents(stores),
        redactedSecrets,
        unsafeInstructions,
      },
    };
  }

  function recall(request = {}) {
    const payload = typeof request === "string" ? { query: request } : toObject(request);
    const storeId = normalizeStoreId(
      payload.storeId ?? payload.store ?? payload.memoryStore,
      config.defaultStore,
    );
    const space = normalizeText(payload.space || config.defaultSpace) || config.defaultSpace;
    const query = normalizeText(payload.query || payload.text);
    const includeUnsafe = Boolean(payload.includeUnsafe);
    const maxItems = clampInteger(payload.maxItems, 1, config.maxMaxItems, config.defaultMaxItems);
    const tokenBudget = clampInteger(payload.tokenBudget, 1, config.maxTokenBudget, config.defaultTokenBudget);

    const storeState = stores.get(storeId) ?? { spaces: new Map() };
    const bucket = storeState.spaces.get(space) ?? new Map();
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
        storeId: rankedEvent.event.storeId,
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
      storeId,
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
        storeIsolationEnforced: true,
        spaceIsolationEnforced: true,
      },
    };
  }

  function getEventCount(space, storeId = config.defaultStore) {
    const normalizedStore = normalizeStoreId(storeId, config.defaultStore);
    const storeState = stores.get(normalizedStore) ?? { spaces: new Map() };

    if (space) {
      return (storeState.spaces.get(space) ?? new Map()).size;
    }
    return totalEventsForStore(storeState);
  }

  function exportState() {
    const serializedStores = [...stores.entries()]
      .sort(([storeA], [storeB]) => storeA.localeCompare(storeB))
      .map(([storeId, storeState]) => {
        const spaces = [...storeState.spaces.entries()]
          .sort(([spaceA], [spaceB]) => spaceA.localeCompare(spaceB))
          .map(([space, bucket]) => {
            const events = [...bucket.values()].sort(compareEvents).map(exportEvent);
            return { space, events };
          });
        const eventCount = spaces.reduce((count, entry) => count + entry.events.length, 0);
        return {
          storeId,
          spaces,
          totals: {
            spaceCount: spaces.length,
            eventCount,
          },
        };
      });

    return {
      stores: serializedStores,
      totals: {
        storeCount: serializedStores.length,
        spaceCount: serializedStores.reduce((count, storeEntry) => count + storeEntry.totals.spaceCount, 0),
        eventCount: serializedStores.reduce((count, storeEntry) => count + storeEntry.totals.eventCount, 0),
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
