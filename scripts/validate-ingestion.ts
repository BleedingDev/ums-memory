import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { createUmsEngine } from "../apps/api/src/ums/engine.ts";

const RESULT_SCHEMA_VERSION = "ingestion_validation_summary.v2";
const DEFAULT_OUTPUT_PATH = resolve(
  process.cwd(),
  "docs/reports/multi-store-ingestion-validation-summary.json"
);
const DETERMINISTIC_GENERATED_AT = "2026-03-04T00:00:00.000Z";
const USER_HOME = process.env["HOME"] || homedir();
const CODEX_HISTORY_ROOT = join(USER_HOME, ".codex");
const CLAUDE_HISTORY_ROOT = join(USER_HOME, ".claude");

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

type ValidationMode = "check" | "refresh" | "local";
type ValidationSummaryMode = "deterministic" | "local";
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

interface FixtureConversationRecord {
  readonly role: string;
  readonly timestamp: string;
  readonly content: string;
}

interface ParsedArgs {
  readonly mode: ValidationMode;
  readonly outputPath: string;
  readonly json: boolean;
  readonly writeReport: boolean;
  readonly force: boolean;
  readonly help: boolean;
}

interface GenerateValidationSummaryOptions {
  readonly mode?: ValidationMode;
}

interface ValidationSummary {
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly sources: {
    readonly mode: ValidationSummaryMode;
    readonly jiraExampleRepo: string;
    readonly codexJsonlFiles: number;
    readonly claudeJsonlFiles: number;
  };
  readonly ingestion: {
    readonly jira: unknown;
    readonly codingAgents: unknown;
  };
  readonly snapshotTotals: unknown;
  readonly stores: readonly unknown[];
  readonly reflections: {
    readonly jiraHistory: {
      readonly query: string;
      readonly sampleItems: readonly {
        readonly id: string;
        readonly source: string;
        readonly content: string;
      }[];
    };
    readonly codingAgent: {
      readonly query: string;
      readonly sampleItems: readonly {
        readonly id: string;
        readonly source: string;
        readonly content: string;
      }[];
    };
  };
}

const FIXTURE_CODEX_RECORDS: readonly FixtureConversationRecord[] =
  Object.freeze([
    {
      role: "user",
      timestamp: "2026-02-20T12:10:00.000Z",
      content: "Need deterministic replay tests for ingestion.",
    },
    {
      role: "assistant",
      timestamp: "2026-02-20T12:11:00.000Z",
      content: "Add duplicate replay assertions and benchmark checks.",
    },
    {
      role: "user",
      timestamp: "2026-02-20T12:13:00.000Z",
      content: "Ensure report output never changes during CI checks.",
    },
  ]);

const FIXTURE_CLAUDE_RECORDS: readonly FixtureConversationRecord[] =
  Object.freeze([
    {
      role: "user",
      timestamp: "2026-02-21T09:00:00.000Z",
      content: "Design a schema-only boundary gate for adapter payloads.",
    },
    {
      role: "assistant",
      timestamp: "2026-02-21T09:01:00.000Z",
      content:
        "Use Effect Schema validators at runtime edges and block direct decodeUnknown usage.",
    },
  ]);

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
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const nextPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") {
        files.push(nextPath);
      }
    }
  }

  files.sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));
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
      .map((entry) => pickText(entry))
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
      .map((entry) => pickText(entry))
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
      const fileLabel = relative(USER_HOME, filePath) || filePath;
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

function toFixtureEvents({
  records,
  storeId,
  space,
  source,
}: {
  readonly records: readonly FixtureConversationRecord[];
  readonly storeId: string;
  readonly space: string;
  readonly source: string;
}): ValidationEvent[] {
  return records.map((record, index) => ({
    id: `${source}-fixture-${index + 1}`,
    storeId,
    space,
    source,
    timestamp: record.timestamp,
    content: truncate(record.content),
    tags: [source, record.role.toLowerCase()],
    metadata: {
      role: record.role.toLowerCase(),
      file: `${source}-fixture.jsonl`,
      line: index + 1,
    },
  }));
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
  const counts = new Map<string, number>();
  for (const event of events) {
    const seen = new Set<string>();
    for (const token of tokenize(event.content)) {
      if (stopwords.has(token) || seen.has(token)) {
        continue;
      }
      seen.add(token);
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((leftEntry, rightEntry) => {
      const countDelta = rightEntry[1] - leftEntry[1];
      if (countDelta !== 0) {
        return countDelta;
      }
      return leftEntry[0].localeCompare(rightEntry[0]);
    })
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
  const sourceCounts = new Map<string, number>();
  const spaceCounts = new Map<string, number>();

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
      .sort((leftEntry, rightEntry) => {
        const countDelta = rightEntry[1] - leftEntry[1];
        if (countDelta !== 0) {
          return countDelta;
        }
        return leftEntry[0].localeCompare(rightEntry[0]);
      })
      .map(([space, count]) => ({ space, count })),
    topSources: [...sourceCounts.entries()]
      .sort((leftEntry, rightEntry) => {
        const countDelta = rightEntry[1] - leftEntry[1];
        if (countDelta !== 0) {
          return countDelta;
        }
        return leftEntry[0].localeCompare(rightEntry[0]);
      })
      .slice(0, 10)
      .map(([source, count]) => ({ source, count })),
    topTerms: topTerms(events),
  };
}

function createJiraExamplePayload(mode: ValidationMode) {
  return {
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
          sourceRepo:
            mode === "local"
              ? "/Users/satan/work/techsio-prototypes/ferndesk-connector"
              : "/fixtures/ferndesk-connector",
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
          sourceRepo:
            mode === "local"
              ? "/Users/satan/work/techsio-prototypes/ferndesk-connector"
              : "/fixtures/ferndesk-connector",
          sourceFixture: "tests/local-app-sync-enrichment.test.ts",
        },
      },
    ],
  };
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }
  if (!isJsonRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, nestedValue]) => [key, normalizeJson(nestedValue)])
  );
}

function serializeSummary(summary: ValidationSummary): string {
  return `${JSON.stringify(normalizeJson(summary), null, 2)}\n`;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node --import tsx scripts/validate-ingestion.ts [--mode <check|refresh|local>] [--output <path>] [--json] [--write-report]",
      "",
      "Modes:",
      "  check      Build deterministic fixture-based summary and compare it with the tracked report (default).",
      "  refresh    Rebuild deterministic fixture-based summary and rewrite the tracked report.",
      "  local      Ingest local ~/.codex and ~/.claude histories for diagnostics.",
      "",
      "Options:",
      "  --mode            Validation mode.",
      "  --output          Report path (default docs/reports/multi-store-ingestion-validation-summary.json).",
      "  --write-report    In local mode, explicitly write report to --output.",
      "  --force           Allow writing local diagnostics to the tracked deterministic report path.",
      "  --json            Print JSON summary output.",
      "  --help, -h        Show this help text.",
    ].join("\n") + "\n"
  );
}

function parseMode(input: string | undefined): ValidationMode {
  switch (input) {
    case "check":
    case "refresh":
    case "local":
      return input;
    default:
      throw new Error(
        `Unsupported mode "${String(input)}". Expected one of: check, refresh, local.`
      );
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const envMode = process.env["UMS_VALIDATE_MODE"];
  let mode: ValidationMode = envMode ? parseMode(envMode) : "check";
  let outputPath = DEFAULT_OUTPUT_PATH;
  let json = false;
  let writeReport = false;
  let force = false;
  let help = false;

  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--write-report") {
      writeReport = true;
      continue;
    }
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--mode") {
      const value = args.shift();
      if (!value) {
        throw new Error("--mode requires a value.");
      }
      mode = parseMode(value);
      continue;
    }
    if (token === "--output") {
      const value = args.shift();
      if (!value) {
        throw new Error("--output requires a value.");
      }
      outputPath = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    mode,
    outputPath,
    json,
    writeReport,
    force,
    help,
  };
}

export async function generateIngestionValidationSummary({
  mode = "check",
}: GenerateValidationSummaryOptions = {}): Promise<ValidationSummary> {
  const codexFiles =
    mode === "local"
      ? [
          ...listJsonlFiles(join(CODEX_HISTORY_ROOT, "archived_sessions")),
          ...listJsonlFiles(CODEX_HISTORY_ROOT),
        ]
      : [];
  const claudeFiles =
    mode === "local"
      ? [
          ...listJsonlFiles(join(CLAUDE_HISTORY_ROOT, "transcripts")),
          ...listJsonlFiles(join(CLAUDE_HISTORY_ROOT, "projects")),
        ]
      : [];

  const codexEvents =
    mode === "local"
      ? await loadConversationEvents({
          files: codexFiles,
          storeId: "coding-agent",
          space: "codex-cli",
          source: "codex-cli",
        })
      : toFixtureEvents({
          records: FIXTURE_CODEX_RECORDS,
          storeId: "coding-agent",
          space: "codex-cli",
          source: "codex-cli",
        });
  const claudeEvents =
    mode === "local"
      ? await loadConversationEvents({
          files: claudeFiles,
          storeId: "coding-agent",
          space: "claude-code",
          source: "claude-code",
        })
      : toFixtureEvents({
          records: FIXTURE_CLAUDE_RECORDS,
          storeId: "coding-agent",
          space: "claude-code",
          source: "claude-code",
        });

  const engine = createUmsEngine({
    seed: "validation-seed",
    defaultStore: "coding-agent",
    defaultSpace: "agent-history",
  });

  const jiraIngest = await engine.ingest(createJiraExamplePayload(mode));
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

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    generatedAt:
      mode === "local" ? new Date().toISOString() : DETERMINISTIC_GENERATED_AT,
    sources: {
      mode: mode === "local" ? "local" : "deterministic",
      jiraExampleRepo:
        mode === "local"
          ? "/Users/satan/work/techsio-prototypes/ferndesk-connector"
          : "/fixtures/ferndesk-connector",
      codexJsonlFiles:
        mode === "local" ? codexFiles.length : FIXTURE_CODEX_RECORDS.length,
      claudeJsonlFiles:
        mode === "local" ? claudeFiles.length : FIXTURE_CLAUDE_RECORDS.length,
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
}

function writeSummary(outputPath: string, summary: ValidationSummary) {
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, serializeSummary(summary), "utf8");
}

function readBaseline(outputPath: string): ValidationSummary {
  const payload = readFileSync(outputPath, "utf8");
  return JSON.parse(payload) as ValidationSummary;
}

function printSummary(
  summary: ValidationSummary,
  asJson: boolean,
  reportPath: string
): void {
  if (asJson) {
    process.stdout.write(`${serializeSummary(summary)}`);
    return;
  }

  process.stdout.write(
    [
      `Schema version: ${summary.schemaVersion}`,
      `Mode: ${summary.sources.mode}`,
      `Generated at: ${summary.generatedAt}`,
      `Stores: ${String((summary.snapshotTotals as { storeCount?: unknown })?.storeCount ?? "n/a")}`,
      `Events: ${String((summary.snapshotTotals as { eventCount?: unknown })?.eventCount ?? "n/a")}`,
      `Report path: ${reportPath}`,
    ].join("\n") + "\n"
  );
}

export async function main(argv = process.argv.slice(2)) {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    printUsage();
    return 1;
  }

  if (parsed.help) {
    printUsage();
    return 0;
  }

  const writingTrackedDeterministicReport =
    parsed.mode === "local" &&
    parsed.writeReport &&
    resolve(parsed.outputPath) === resolve(DEFAULT_OUTPUT_PATH);
  if (writingTrackedDeterministicReport && !parsed.force) {
    process.stderr.write(
      [
        "Refusing to overwrite deterministic baseline with local diagnostics.",
        "Use a non-tracked output path, or pass --force intentionally.",
      ].join("\n") + "\n"
    );
    return 1;
  }

  try {
    const summary = await generateIngestionValidationSummary({
      mode: parsed.mode,
    });

    if (parsed.mode === "refresh") {
      writeSummary(parsed.outputPath, summary);
      printSummary(summary, parsed.json, parsed.outputPath);
      return 0;
    }

    if (parsed.mode === "check") {
      const baseline = readBaseline(parsed.outputPath);
      const expected = serializeSummary(baseline);
      const actual = serializeSummary(summary);
      if (actual !== expected) {
        process.stderr.write(
          [
            "Deterministic ingestion validation drift detected.",
            `Run this to refresh baseline intentionally: node --import tsx scripts/validate-ingestion.ts --mode refresh --output ${parsed.outputPath}`,
          ].join("\n") + "\n"
        );
        return 1;
      }
      printSummary(summary, parsed.json, parsed.outputPath);
      return 0;
    }

    if (parsed.writeReport) {
      writeSummary(parsed.outputPath, summary);
    }
    printSummary(summary, parsed.json, parsed.outputPath);
    return 0;
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await main();
  process.exit(code);
}
