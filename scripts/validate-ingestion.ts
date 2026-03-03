import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import { createUmsEngine } from "../apps/api/src/ums/engine.ts";

const OUTPUT_PATH = resolve(
  process.cwd(),
  "docs/reports/multi-store-ingestion-validation-summary.json"
);
const MAX_CONTENT_LENGTH = Number.parseInt(
  process.env["UMS_VALIDATE_MAX_CONTENT"] || "2000",
  10
);
const MAX_FILES_PER_SOURCE = Number.parseInt(
  process.env["UMS_VALIDATE_MAX_FILES"] || "0",
  10
);
const MAX_LINES_PER_FILE = Number.parseInt(
  process.env["UMS_VALIDATE_MAX_LINES"] || "0",
  10
);

type JsonRecord = Record<string, unknown>;

interface ValidationEvent {
  readonly id: string;
  readonly storeId: string;
  readonly space: string;
  readonly source: string;
  readonly timestamp: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly metadata: {
    readonly role: string;
    readonly file: string;
    readonly line: number;
  };
}

interface ConversationLoadArgs {
  readonly files: readonly string[];
  readonly storeId: string;
  readonly space: string;
  readonly source: string;
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function truncate(value: unknown, maxLength = MAX_CONTENT_LENGTH): string {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

function normalizeText(value: unknown): string {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function listJsonlFiles(rootDirectory: string): string[] {
  if (!existsSync(rootDirectory)) {
    return [];
  }

  const files: string[] = [];
  const stack: string[] = [rootDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") {
        files.push(path);
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return MAX_FILES_PER_SOURCE > 0
    ? files.slice(0, MAX_FILES_PER_SOURCE)
    : files;
}

function tryParseJson(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function pickFirstString(value: unknown, keys: readonly string[]): string {
  if (!isJsonRecord(value)) {
    return "";
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (isJsonRecord(candidate)) {
      const nested = pickFirstString(candidate, keys);
      if (nested) {
        return nested;
      }
    }
  }
  return "";
}

function pickText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry): string => pickText(entry))
      .filter((entry): entry is string => entry.length > 0)
      .join("\n")
      .trim();
  }
  if (!isJsonRecord(value)) {
    return "";
  }

  const direct = pickFirstString(value, [
    "content",
    "text",
    "message",
    "prompt",
    "response",
    "output",
    "input",
    "body",
  ]);
  if (direct) {
    return direct;
  }

  const messages = value["messages"];
  if (Array.isArray(messages)) {
    const fromMessages = messages
      .map((entry): string => pickText(entry))
      .filter((entry): entry is string => entry.length > 0)
      .join("\n");
    if (fromMessages) {
      return fromMessages.trim();
    }
  }

  return "";
}

function pickTimestamp(value: unknown): string {
  const timestamp = pickFirstString(value, [
    "timestamp",
    "createdAt",
    "created_at",
    "updatedAt",
    "time",
    "ts",
  ]);
  return timestamp || new Date(0).toISOString();
}

function pickRole(value: unknown): string {
  const role = pickFirstString(value, [
    "role",
    "actor",
    "sender",
    "authorRole",
  ]);
  return role || "any";
}

async function loadConversationEvents({
  files,
  storeId,
  space,
  source,
}: ConversationLoadArgs): Promise<ValidationEvent[]> {
  const events: ValidationEvent[] = [];

  for (const filePath of files) {
    const input = createReadStream(filePath, { encoding: "utf8" });
    const reader = createInterface({
      input,
      crlfDelay: Infinity,
    });

    let lineIndex = 0;
    for await (const line of reader) {
      lineIndex += 1;
      if (!line || !line.trim()) {
        continue;
      }
      if (MAX_LINES_PER_FILE > 0 && lineIndex > MAX_LINES_PER_FILE) {
        break;
      }

      const parsed = tryParseJson(line);
      if (!parsed) {
        continue;
      }

      const content = pickText(parsed);
      if (!content) {
        continue;
      }

      const role = pickRole(parsed).toLowerCase();
      const fileLabel = relative("/Users/satan", filePath) || filePath;
      events.push({
        id: `${source}-${fileLabel}-${lineIndex - 1}`,
        storeId,
        space,
        source,
        timestamp: pickTimestamp(parsed),
        content: truncate(content),
        tags: [source, role].filter(Boolean),
        metadata: {
          role,
          file: fileLabel,
          line: lineIndex,
        },
      });
    }

    input.close();
  }

  return events;
}

function tokenize(content: unknown): string[] {
  return normalizeText(content)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 2);
}

function topTerms(
  events: readonly {
    readonly content: unknown;
  }[],
  limit = 12
): Array<{ term: string; count: number }> {
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "you",
    "was",
    "are",
    "not",
    "but",
    "into",
    "your",
    "they",
    "their",
    "about",
    "https",
    "http",
  ]);
  const counts = new Map();
  for (const event of events) {
    const seen = new Set();
    for (const token of tokenize(event.content)) {
      if (stopwords.has(token) || seen.has(token)) {
        continue;
      }
      seen.add(token);
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

function summarizeStore(storeEntry: {
  readonly storeId: string;
  readonly totals: unknown;
  readonly spaces: readonly {
    readonly space: string;
    readonly events: readonly {
      readonly source: string;
      readonly content: unknown;
    }[];
  }[];
}) {
  const events: Array<{ readonly source: string; readonly content: unknown }> =
    [];
  const sourceCounts = new Map();
  const spaceCounts = new Map();

  for (const spaceEntry of storeEntry.spaces) {
    spaceCounts.set(spaceEntry.space, spaceEntry.events.length);
    for (const event of spaceEntry.events) {
      events.push(event);
      sourceCounts.set(event.source, (sourceCounts.get(event.source) || 0) + 1);
    }
  }

  return {
    storeId: storeEntry.storeId,
    totals: storeEntry.totals,
    spaces: [...spaceCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([space, count]) => ({ space, count })),
    topSources: [...sourceCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([source, count]) => ({ source, count })),
    topTerms: topTerms(events),
  };
}

const jiraExamplePayload = {
  storeId: "jira-history",
  space: "ferndesk-support",
  jiraBaseUrl: "https://example.atlassian.net",
  issues: [
    {
      id: "10001",
      key: "SUP-1",
      fields: {
        summary: "Example issue",
        description: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
          ],
        },
        created: "2024-01-02T03:04:05.000+0000",
        updated: "2024-01-03T03:04:05.000+0000",
      },
      comments: [
        {
          id: "c-1",
          body: "A public reply",
          created: "2024-01-02T05:00:00.000+0000",
          public: true,
          author: { displayName: "Agent", accountId: "agent-1" },
        },
      ],
      metadata: {
        sourceRepo: "/Users/satan/work/techsio-prototypes/ferndesk-connector",
        sourceFixture: "tests/ferndesk-schema.test.ts",
      },
    },
    {
      id: "10002",
      key: "ABC-1",
      fields: {
        summary: "Invoice mismatch for Acme",
        description: "Customer reports wrong invoice amount.",
        created: "2026-02-13T10:00:00.000Z",
        updated: "2026-02-13T12:00:00.000Z",
      },
      comments: [
        {
          id: "20001",
          body: "Escalated to billing squad.",
          created: "2026-02-13T12:00:00.000Z",
          public: true,
          author: { displayName: "Support Agent", accountId: "agent-1" },
        },
      ],
      metadata: {
        sourceRepo: "/Users/satan/work/techsio-prototypes/ferndesk-connector",
        sourceFixture: "tests/local-app-sync-enrichment.test.ts",
      },
    },
  ],
};

const codexFiles = [
  ...listJsonlFiles("/Users/satan/.codex/archived_sessions"),
  ...listJsonlFiles("/Users/satan/.codex"),
];
const claudeFiles = [
  ...listJsonlFiles("/Users/satan/.claude/transcripts"),
  ...listJsonlFiles("/Users/satan/.claude/projects"),
];

const codexEvents = await loadConversationEvents({
  files: codexFiles,
  storeId: "coding-agent",
  space: "codex-cli",
  source: "codex-cli",
});
const claudeEvents = await loadConversationEvents({
  files: claudeFiles,
  storeId: "coding-agent",
  space: "claude-code",
  source: "claude-code",
});

const engine = createUmsEngine({
  seed: "validation-seed",
  defaultStore: "coding-agent",
  defaultSpace: "agent-history",
});

const jiraIngest = await engine.ingest(jiraExamplePayload);
const codingIngest = await engine.ingest([...codexEvents, ...claudeEvents]);

const jiraRecall = await engine.recall({
  storeId: "jira-history",
  space: "ferndesk-support",
  query: "invoice mismatch escalation billing",
  maxItems: 5,
  tokenBudget: 300,
});
const codingRecall = await engine.recall({
  storeId: "coding-agent",
  space: "codex-cli",
  query: "benchmark tests memory store jira",
  maxItems: 5,
  tokenBudget: 300,
});

const snapshot = engine.exportState();
const storeSummaries = snapshot.stores.map(summarizeStore);

const output = {
  generatedAt: new Date().toISOString(),
  sources: {
    jiraExampleRepo: "/Users/satan/work/techsio-prototypes/ferndesk-connector",
    codexJsonlFiles: codexFiles.length,
    claudeJsonlFiles: claudeFiles.length,
  },
  ingestion: {
    jira: jiraIngest,
    codingAgents: codingIngest,
  },
  snapshotTotals: snapshot.totals,
  stores: storeSummaries,
  reflections: {
    jiraHistory: {
      query: jiraRecall.query,
      sampleItems: jiraRecall.items.slice(0, 5).map((item) => ({
        id: item.id,
        source: item.source,
        content: truncate(item.content, 280),
      })),
    },
    codingAgent: {
      query: codingRecall.query,
      sampleItems: codingRecall.items.slice(0, 5).map((item) => ({
        id: item.id,
        source: item.source,
        content: truncate(item.content, 280),
      })),
    },
  },
};

mkdirSync(resolve(process.cwd(), "docs/reports"), { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(JSON.stringify(output, null, 2));
