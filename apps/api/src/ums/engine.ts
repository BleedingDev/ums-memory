import { createHash } from "node:crypto";

interface EngineDefaults {
  seed: string;
  defaultStore: string;
  defaultSpace: string;
  defaultMaxItems: number;
  defaultTokenBudget: number;
  maxMaxItems: number;
  maxTokenBudget: number;
}

interface EventFlags {
  hasSecret: boolean;
  unsafeInstruction: boolean;
}

interface EventMetadata extends Record<string, unknown> {
  role?: string;
  conversationId?: string;
  issueKey?: string;
}

interface EventIdentity {
  id: string;
  timestamp: string;
}

interface NormalizedEvent extends EventIdentity {
  storeId: string;
  space: string;
  source: string;
  content: string;
  tags: string[];
  metadata: EventMetadata;
}

interface StoredEvent extends NormalizedEvent {
  flags: EventFlags;
  tokenEstimate: number;
}

interface StoreState {
  spaces: Map<string, Map<string, StoredEvent>>;
}

interface EngineContext {
  storeId: string;
  space: string;
  source: string;
  platform: string;
  jiraBaseUrl: string;
  conversationId?: string;
  conversationOrdinal?: number;
}

interface ContextInput {
  storeId?: unknown;
  store?: unknown;
  memoryStore?: unknown;
  namespace?: unknown;
  space?: unknown;
  project?: unknown;
  channel?: unknown;
  source?: unknown;
  connector?: unknown;
  platform?: unknown;
  jiraBaseUrl?: unknown;
}

interface MessageInput {
  role?: unknown;
  authorRole?: unknown;
  speaker?: unknown;
  conversationId?: unknown;
  id?: unknown;
  messageId?: unknown;
  content?: unknown;
  text?: unknown;
  message?: unknown;
  body?: unknown;
  payload?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
  ts?: unknown;
  time?: unknown;
  meta?: unknown;
}

interface ConversationInput {
  id?: unknown;
  conversationId?: unknown;
  messages?: unknown;
  title?: unknown;
  description?: unknown;
  lastMessageAt?: unknown;
  updatedAt?: unknown;
  url?: unknown;
}

interface JiraIssueInput {
  key?: unknown;
  id?: unknown;
  fields?: unknown;
  summary?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  comments?: unknown;
}

interface JiraCommentInput {
  id?: unknown;
  author?: unknown;
  public?: unknown;
  created?: unknown;
  createdAt?: unknown;
  body?: unknown;
  content?: unknown;
  text?: unknown;
}

interface JiraFieldsInput {
  description?: unknown;
  summary?: unknown;
  created?: unknown;
  updated?: unknown;
  comments?: unknown;
  comment?: unknown;
  status?: unknown;
  priority?: unknown;
}

interface CommentContainerInput {
  comments?: unknown;
}

interface ActorInput {
  displayName?: unknown;
  name?: unknown;
  accountId?: unknown;
}

interface NameFieldInput {
  name?: unknown;
}

interface SpaceEntryInput {
  space?: unknown;
  events?: unknown;
}

interface SnapshotStoreEntryInput {
  storeId?: unknown;
  spaces?: unknown;
}

interface SnapshotInput {
  stores?: unknown;
  spaces?: unknown;
}

interface RawEventInput extends ContextInput {
  id?: unknown;
  profile?: unknown;
  origin?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
  occurredAt?: unknown;
  updatedAt?: unknown;
  content?: unknown;
  text?: unknown;
  message?: unknown;
  body?: unknown;
  payload?: unknown;
  summary?: unknown;
  tags?: unknown;
  metadata?: unknown;
  role?: unknown;
  authorRole?: unknown;
  conversationId?: unknown;
  issueKey?: unknown;
  events?: unknown;
  conversations?: unknown;
  issues?: unknown;
}

interface RecallRequestInput {
  query?: unknown;
  text?: unknown;
  storeId?: unknown;
  store?: unknown;
  memoryStore?: unknown;
  space?: unknown;
  includeUnsafe?: unknown;
  maxItems?: unknown;
  tokenBudget?: unknown;
}

interface RankedEvent {
  event: StoredEvent;
  score: number;
}

interface RecallResultItem {
  id: string;
  storeId: string;
  space: string;
  source: string;
  timestamp: string;
  content: string;
  score: number;
  flags: EventFlags;
  evidence: {
    episodeId: string;
    source: string;
  };
}

interface RecallResult {
  query: string;
  storeId: string;
  space: string;
  maxItems: number;
  tokenBudget: number;
  estimatedTokens: number;
  payloadBytes: number;
  truncated: boolean;
  items: RecallResultItem[];
  guardrails: {
    filteredUnsafe: number;
    redactedSecrets: number;
    storeIsolationEnforced: true;
    spaceIsolationEnforced: true;
  };
}

interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  stats: {
    storeCount: number;
    spaceCount: number;
    totalEvents: number;
    redactedSecrets: number;
    unsafeInstructions: number;
  };
}

interface ExportedEvent {
  id: string;
  storeId: string;
  space: string;
  source: string;
  timestamp: string;
  content: string;
  tags: string[];
  metadata: EventMetadata;
  flags: EventFlags;
}

interface ExportedSpaceEntry {
  space: string;
  events: ExportedEvent[];
}

interface ExportedStoreEntry {
  storeId: string;
  spaces: ExportedSpaceEntry[];
  totals: {
    spaceCount: number;
    eventCount: number;
  };
}

interface ExportedState {
  stores: ExportedStoreEntry[];
  totals: {
    storeCount: number;
    spaceCount: number;
    eventCount: number;
  };
}

interface UmsEngineOptions extends Partial<EngineDefaults> {
  unsafePatterns?: readonly RegExp[];
  initialState?: unknown;
}

interface UmsEngine {
  ingest: (input: unknown) => IngestResult;
  recall: (request?: unknown) => RecallResult;
  getEventCount: (space?: string, storeId?: unknown) => number;
  exportState: () => ExportedState;
  stateDigest: () => string;
}

const DEFAULTS: Readonly<EngineDefaults> = Object.freeze({
  seed: "ums-engine-v1",
  defaultStore: "default",
  defaultSpace: "default",
  defaultMaxItems: 10,
  defaultTokenBudget: 256,
  maxMaxItems: 100,
  maxTokenBudget: 8192,
});

const UNSAFE_PATTERNS: readonly RegExp[] = Object.freeze([
  /ignore\s+previous\s+instructions/i,
  /reveal\s+system\s+prompt/i,
  /\bexfiltrate\b/i,
]);
const HASH_UNIT_DENOMINATOR = 281_474_976_710_655;

function estimateTokens(content: unknown): number {
  return Math.max(1, Math.ceil(String(content).length / 4));
}

function sha256(input: unknown): string {
  return createHash("sha256").update(String(input)).digest("hex");
}

function hashToUnit(input: unknown): number {
  const hex = sha256(input).slice(0, 12);
  return Number.parseInt(hex, 16) / HASH_UNIT_DENOMINATOR;
}

function normalizeTimestamp(value: unknown): string {
  if (!value) {
    return "1970-01-01T00:00:00.000Z";
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) {
    return "1970-01-01T00:00:00.000Z";
  }
  return date.toISOString();
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serializedItems = value.map((item) => stableStringify(item));
    return `[${serializedItems.join(",")}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  const serializedPairs = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`
  );
  return `{${serializedPairs.join(",")}}`;
}

function tokenize(text: unknown): Set<string> {
  return new Set(
    normalizeText(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length > 1)
  );
}

function compareEvents(
  a: { timestamp: string; id: string },
  b: { timestamp: string; id: string }
): number {
  if (a.timestamp !== b.timestamp) {
    return b.timestamp.localeCompare(a.timestamp);
  }
  return a.id.localeCompare(b.id);
}

function redactSecrets(content: unknown): { text: string; count: number } {
  let output = String(content);
  let count = 0;

  output = output.replace(/sk-[A-Za-z0-9]{8,}/g, () => {
    count += 1;
    return "[REDACTED_SECRET]";
  });

  output = output.replace(
    /(\b(?:api[_-]?key|token|password)\s*[:=]\s*)([^\s,;]+)/gi,
    (_match, prefix) => {
      count += 1;
      return `${prefix}[REDACTED]`;
    }
  );

  output = output.replace(/\b[A-Fa-f0-9]{32,}\b/g, () => {
    count += 1;
    return "[REDACTED_SECRET]";
  });

  return { text: output, count };
}

function normalizeStoreId(value: unknown, fallback: string): string {
  const normalized = normalizeText(value);
  return normalized || fallback;
}

function toObject<T extends object>(value: unknown): Partial<T> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Partial<T>;
  }
  return {};
}

function toBodyText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => toBodyText(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const candidate = toObject<{
      text?: unknown;
      value?: unknown;
      content?: unknown;
    }>(value);
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
      return candidate.content
        .map((entry) => toBodyText(entry))
        .filter(Boolean)
        .join("\n");
    }
  }
  return stableStringify(value);
}

function joinNonEmpty(lines: unknown[]): string {
  return lines
    .map((entry) => normalizeText(entry))
    .filter(Boolean)
    .join("\n");
}

function createSyntheticId(event: NormalizedEvent): string {
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

function looksLikeJiraIssue(value: unknown): boolean {
  const issue = toObject<JiraIssueInput>(value);
  const hasFieldsObject =
    issue.fields !== null &&
    issue.fields !== undefined &&
    typeof issue.fields === "object" &&
    !Array.isArray(issue.fields);
  return Boolean(typeof issue.key === "string" || hasFieldsObject);
}

function looksLikeConversation(value: unknown): boolean {
  const conversation = toObject<ConversationInput>(value);
  return Boolean(
    Array.isArray(conversation.messages) &&
    (typeof conversation.id === "string" ||
      typeof conversation.conversationId === "string")
  );
}

function makeContext(
  input: unknown,
  defaults: EngineDefaults,
  inherited: Partial<EngineContext> = {}
): EngineContext {
  const raw = toObject<ContextInput>(input);
  return {
    storeId: normalizeStoreId(
      raw.storeId ??
        raw.store ??
        raw.memoryStore ??
        raw.namespace ??
        inherited.storeId,
      defaults.defaultStore
    ),
    space:
      normalizeText(
        raw.space ?? raw.project ?? raw.channel ?? inherited.space
      ) || defaults.defaultSpace,
    source: normalizeText(
      raw.source ?? raw.connector ?? raw.platform ?? inherited.source
    ),
    platform: normalizeText(raw.platform ?? inherited.platform),
    jiraBaseUrl: normalizeText(raw.jiraBaseUrl ?? inherited.jiraBaseUrl),
  };
}

function normalizeConversationMessage(
  rawMessage: unknown,
  context: EngineContext,
  index: number
): NormalizedEvent {
  const message = toObject<MessageInput>(rawMessage);
  const role =
    normalizeText(
      message.role || message.authorRole || message.speaker
    ).toLowerCase() || "unknown";
  const conversationId =
    normalizeText(message.conversationId || context.conversationId) ||
    `conversation-${context.space}`;
  const messageId =
    normalizeText(message.id || message.messageId) ||
    `${conversationId}-msg-${index}`;

  const content = joinNonEmpty([
    typeof message.content === "string" ? message.content : "",
    typeof message.text === "string" ? message.text : "",
    typeof message.message === "string" ? message.message : "",
    typeof message.body === "string" ? message.body : "",
  ]);
  const normalizedContent =
    content || toBodyText(message.content ?? message.payload ?? message);

  return {
    id: messageId,
    storeId: context.storeId,
    space: context.space,
    source:
      context.source || `agent-conversation:${context.platform || "unknown"}`,
    timestamp: normalizeTimestamp(
      message.createdAt || message.timestamp || message.ts || message.time
    ),
    content: normalizedContent,
    tags: [context.platform || "conversation", role].filter(
      Boolean
    ) as string[],
    metadata: {
      role,
      conversationId,
      platform: context.platform || "unknown",
      messageIndex: index,
      meta:
        message.meta &&
        typeof message.meta === "object" &&
        !Array.isArray(message.meta)
          ? (message.meta as Record<string, unknown>)
          : undefined,
    },
  };
}

function normalizeFerndeskConversation(
  rawConversation: unknown,
  context: EngineContext
): NormalizedEvent[] {
  const conversation = toObject<ConversationInput>(rawConversation);
  const explicitConversationId = normalizeText(
    conversation.id || conversation.conversationId
  );
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages
    : [];
  const fallbackSeed = stableStringify({
    space: context.space,
    source: context.source,
    ordinal: context.conversationOrdinal ?? 0,
    sample: messages.slice(0, 2).map((entry: unknown) => {
      const sampleEntry = toObject<MessageInput>(entry);
      return {
        id: normalizeText(sampleEntry.id),
        role: normalizeText(sampleEntry.role),
        text: normalizeText(
          sampleEntry.text ?? sampleEntry.message ?? sampleEntry.content ?? ""
        ),
      };
    }),
  });
  const conversationId =
    explicitConversationId ||
    `conversation-${sha256(fallbackSeed).slice(0, 12)}`;
  const platform = context.platform || "jira-ferndesk";

  if (messages.length > 0) {
    return messages.map((message: unknown, index: number) =>
      normalizeConversationMessage(
        message,
        { ...context, conversationId, platform },
        index
      )
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
      timestamp: normalizeTimestamp(
        conversation.lastMessageAt || conversation.updatedAt
      ),
      content: summaryContent,
      tags: ["jira", "summary"],
      metadata: {
        conversationId,
        url: normalizeText(conversation.url) || undefined,
      },
    },
  ];
}

function normalizeJiraIssue(
  rawIssue: unknown,
  context: EngineContext,
  index: number
): NormalizedEvent[] {
  const issue = toObject<JiraIssueInput>(rawIssue);
  const fields = toObject<JiraFieldsInput>(issue.fields);
  const issueKey = normalizeText(
    issue.key || issue.id || `jira-issue-${index}`
  );
  const description = toBodyText(fields.description);
  const summary = normalizeText(fields.summary || issue.summary || issueKey);
  const createdAt = normalizeTimestamp(
    fields.created || issue.createdAt || fields.updated || issue.updatedAt
  );
  const commentsFromField: unknown[] = Array.isArray(fields.comments)
    ? fields.comments
    : Array.isArray(toObject<CommentContainerInput>(fields.comment).comments)
      ? (toObject<CommentContainerInput>(fields.comment).comments as unknown[])
      : [];
  const comments: unknown[] = Array.isArray(issue.comments)
    ? issue.comments
    : commentsFromField;

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
      status:
        normalizeText(toObject<NameFieldInput>(fields.status).name) ||
        undefined,
      priority:
        normalizeText(toObject<NameFieldInput>(fields.priority).name) ||
        undefined,
      url: context.jiraBaseUrl
        ? `${context.jiraBaseUrl.replace(/\/$/, "")}/browse/${issueKey}`
        : undefined,
    },
  };

  const commentEvents = comments.map(
    (rawComment: unknown, commentIndex: number) => {
      const comment = toObject<JiraCommentInput>(rawComment);
      const author = toObject<ActorInput>(comment.author);
      const authorName =
        normalizeText(author.displayName || author.name || author.accountId) ||
        "unknown-author";
      const publicFlag =
        comment.public === null || comment.public === undefined
          ? undefined
          : comment.public
            ? "public"
            : "private";
      return {
        id: `jira-${issueKey}-comment-${normalizeText(comment.id) || commentIndex}`,
        storeId: context.storeId,
        space: context.space,
        source: context.source || "jira-comment",
        timestamp: normalizeTimestamp(
          comment.created || comment.createdAt || issueEvent.timestamp
        ),
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
          public:
            comment.public === null || comment.public === undefined
              ? undefined
              : Boolean(comment.public),
        },
      };
    }
  );

  return [issueEvent, ...commentEvents];
}

function toRawEvents(
  input: unknown,
  defaults: EngineDefaults,
  inherited: Partial<EngineContext> = {}
): unknown[] {
  if (Array.isArray(input)) {
    return input.flatMap((entry: unknown) =>
      toRawEvents(entry, defaults, inherited)
    );
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
  const envelope = toObject<RawEventInput>(input);

  if (Array.isArray(envelope.events)) {
    return envelope.events.flatMap((event: unknown) =>
      toRawEvents(event, defaults, {
        ...context,
        source:
          context.source ||
          normalizeText(toObject<RawEventInput>(event).source),
      })
    );
  }

  if (Array.isArray(envelope.conversations)) {
    return envelope.conversations.flatMap(
      (conversation: unknown, conversationOrdinal: number) =>
        normalizeFerndeskConversation(conversation, {
          ...context,
          source: context.source || "jira",
          platform: context.platform || "jira-ferndesk",
          conversationOrdinal,
        })
    );
  }

  if (Array.isArray(envelope.issues)) {
    return envelope.issues.flatMap((issue: unknown, index: number) =>
      normalizeJiraIssue(
        issue,
        { ...context, source: context.source || "jira" },
        index
      )
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
    return normalizeJiraIssue(
      envelope,
      { ...context, source: context.source || "jira" },
      0
    );
  }

  return [envelope];
}

function normalizeEvent(
  rawEvent: unknown,
  defaults: EngineDefaults
): NormalizedEvent | null {
  if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
    return null;
  }
  const event = rawEvent as RawEventInput;

  const storeId = normalizeStoreId(
    event.storeId ?? event.store ?? event.memoryStore,
    defaults.defaultStore
  );
  const space =
    normalizeText(
      event.space || event.project || event.profile || defaults.defaultSpace
    ) || defaults.defaultSpace;
  if (!space) {
    return null;
  }

  const source =
    normalizeText(
      event.source || event.connector || event.platform || event.origin
    ) || "unknown";
  const contentCandidate =
    event.content ??
    event.text ??
    event.message ??
    event.body ??
    event.payload ??
    event.summary ??
    "";
  const content = toBodyText(contentCandidate);
  const timestamp = normalizeTimestamp(
    event.timestamp || event.createdAt || event.occurredAt || event.updatedAt
  );
  const tags = Array.isArray(event.tags)
    ? [
        ...new Set(
          event.tags.map((tag: unknown) => normalizeText(tag)).filter(Boolean)
        ),
      ].sort()
    : [];
  const metadata: EventMetadata =
    event.metadata &&
    typeof event.metadata === "object" &&
    !Array.isArray(event.metadata)
      ? { ...(event.metadata as Record<string, unknown>) }
      : {};

  const role = normalizeText(event.role || event.authorRole).toLowerCase();
  if (role && !metadata.role) {
    metadata.role = role;
  }
  if (event.conversationId && !metadata.conversationId) {
    metadata.conversationId = normalizeText(event.conversationId);
  }
  if (event.issueKey && !metadata.issueKey) {
    metadata.issueKey = normalizeText(event.issueKey);
  }

  const normalized: NormalizedEvent = {
    id: normalizeText(event.id),
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

function eventScore(
  query: string,
  event: Pick<StoredEvent, "id" | "timestamp" | "content">,
  seed: string
): number {
  const queryTokens = tokenize(query);
  const contentTokens = tokenize(event.content);
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlap += 1;
    }
  }
  const tieBreaker =
    hashToUnit(`${seed}|${query}|${event.id}|${event.timestamp}`) * 0.01;
  return overlap + tieBreaker;
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const numeric = Number.parseInt(String(value), 10);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function getStoreState(
  stores: Map<string, StoreState>,
  storeId: string
): StoreState {
  if (!stores.has(storeId)) {
    stores.set(storeId, {
      spaces: new Map<string, Map<string, StoredEvent>>(),
    });
  }
  return stores.get(storeId) as StoreState;
}

function getSpaceBucket(
  storeState: StoreState,
  space: string
): Map<string, StoredEvent> {
  if (!storeState.spaces.has(space)) {
    storeState.spaces.set(space, new Map<string, StoredEvent>());
  }
  return storeState.spaces.get(space) as Map<string, StoredEvent>;
}

function exportEvent(record: StoredEvent): ExportedEvent {
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

function importStoreEntry(
  stores: Map<string, StoreState>,
  rawStoreId: unknown,
  rawSpaces: unknown,
  defaults: EngineDefaults
): void {
  const storeId = normalizeStoreId(rawStoreId, defaults.defaultStore);
  const storeState = getStoreState(stores, storeId);
  const spaces = Array.isArray(rawSpaces) ? rawSpaces : [];

  for (const spaceEntry of spaces) {
    const parsedSpaceEntry = toObject<SpaceEntryInput>(spaceEntry);
    const entrySpace =
      normalizeText(parsedSpaceEntry.space || defaults.defaultSpace) ||
      defaults.defaultSpace;
    const events = Array.isArray(parsedSpaceEntry.events)
      ? parsedSpaceEntry.events
      : [];
    for (const rawEvent of events) {
      const normalized = normalizeEvent(
        {
          ...(toObject<RawEventInput>(rawEvent) as RawEventInput),
          storeId,
          space: entrySpace,
        },
        defaults
      );
      if (!normalized) {
        continue;
      }
      const redaction = redactSecrets(normalized.content);
      const unsafeInstruction = UNSAFE_PATTERNS.some((pattern) =>
        pattern.test(redaction.text)
      );
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

function importSnapshot(
  stores: Map<string, StoreState>,
  snapshot: unknown,
  defaults: EngineDefaults
): void {
  const parsedSnapshot = toObject<SnapshotInput>(snapshot);

  if (Array.isArray(parsedSnapshot.stores)) {
    for (const storeEntry of parsedSnapshot.stores) {
      const parsedStoreEntry = toObject<SnapshotStoreEntryInput>(storeEntry);
      importStoreEntry(
        stores,
        parsedStoreEntry.storeId,
        parsedStoreEntry.spaces,
        defaults
      );
    }
    return;
  }

  if (
    parsedSnapshot.stores &&
    typeof parsedSnapshot.stores === "object" &&
    !Array.isArray(parsedSnapshot.stores)
  ) {
    const storesById = parsedSnapshot.stores as Record<string, unknown>;
    for (const storeId of Object.keys(storesById).sort()) {
      const entry = toObject<SnapshotStoreEntryInput>(storesById[storeId]);
      importStoreEntry(stores, storeId, entry.spaces, defaults);
    }
    return;
  }

  if (Array.isArray(parsedSnapshot.spaces)) {
    importStoreEntry(
      stores,
      defaults.defaultStore,
      parsedSnapshot.spaces,
      defaults
    );
  }
}

function totalEventsForStore(storeState: StoreState): number {
  let total = 0;
  for (const bucket of storeState.spaces.values()) {
    total += bucket.size;
  }
  return total;
}

function totalEvents(stores: Map<string, StoreState>): number {
  let total = 0;
  for (const storeState of stores.values()) {
    total += totalEventsForStore(storeState);
  }
  return total;
}

function totalSpaces(stores: Map<string, StoreState>): number {
  let total = 0;
  for (const storeState of stores.values()) {
    total += storeState.spaces.size;
  }
  return total;
}

export function createUmsEngine(options: UmsEngineOptions = {}): UmsEngine {
  const config: EngineDefaults = { ...DEFAULTS, ...options };
  const unsafePatterns = options.unsafePatterns ?? UNSAFE_PATTERNS;
  const stores = new Map<string, StoreState>();

  importSnapshot(stores, options.initialState, config);

  function ingest(input: unknown): IngestResult {
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
      const unsafeInstruction = unsafePatterns.some((pattern) =>
        pattern.test(redaction.text)
      );
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

  function recall(request: unknown = {}): RecallResult {
    const payload =
      typeof request === "string"
        ? ({ query: request } as RecallRequestInput)
        : toObject<RecallRequestInput>(request);
    const storeId = normalizeStoreId(
      payload.storeId ?? payload.store ?? payload.memoryStore,
      config.defaultStore
    );
    const space =
      normalizeText(payload.space || config.defaultSpace) ||
      config.defaultSpace;
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

    const storeState =
      stores.get(storeId) ??
      ({ spaces: new Map<string, Map<string, StoredEvent>>() } as StoreState);
    const bucket =
      storeState.spaces.get(space) ?? new Map<string, StoredEvent>();
    const ranked: RankedEvent[] = [];
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

    const items: RecallResultItem[] = [];
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

  function getEventCount(
    space?: string,
    storeId: unknown = config.defaultStore
  ): number {
    const normalizedStore = normalizeStoreId(storeId, config.defaultStore);
    const storeState =
      stores.get(normalizedStore) ??
      ({ spaces: new Map<string, Map<string, StoredEvent>>() } as StoreState);

    if (space) {
      return (storeState.spaces.get(space) ?? new Map()).size;
    }
    return totalEventsForStore(storeState);
  }

  function exportState(): ExportedState {
    const serializedStores = [...stores.entries()]
      .sort(([storeA], [storeB]) => storeA.localeCompare(storeB))
      .map(([storeId, storeState]) => {
        const spaces = [...storeState.spaces.entries()]
          .sort(([spaceA], [spaceB]) => spaceA.localeCompare(spaceB))
          .map(([space, bucket]) => {
            const events = [...bucket.values()]
              .sort(compareEvents)
              .map(exportEvent);
            return { space, events };
          });
        const eventCount = spaces.reduce(
          (count, entry) => count + entry.events.length,
          0
        );
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
        spaceCount: serializedStores.reduce(
          (count, storeEntry) => count + storeEntry.totals.spaceCount,
          0
        ),
        eventCount: serializedStores.reduce(
          (count, storeEntry) => count + storeEntry.totals.eventCount,
          0
        ),
      },
    };
  }

  function stateDigest(): string {
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
