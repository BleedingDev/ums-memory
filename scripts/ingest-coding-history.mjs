import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { executeOperation } from "../apps/api/src/core.mjs";
import { DEFAULT_SHARED_STATE_FILE, executeOperationWithSharedState } from "../apps/api/src/persistence.mjs";

const DEFAULT_STORE_ID = "coding-agent";
const DEFAULT_PROFILE = "agent-lessons-curated";
const DEFAULT_REPORT_PATH = resolve(
  process.cwd(),
  "docs/reports/coding-agent-persistent-ingestion-summary.json",
);
const MAX_CONTENT_LENGTH = Number.parseInt(process.env.UMS_INGEST_MAX_CONTENT || "2200", 10);
const MAX_FILES_PER_SOURCE = Number.parseInt(process.env.UMS_INGEST_MAX_FILES || "0", 10);
const MAX_LINES_PER_FILE = Number.parseInt(process.env.UMS_INGEST_MAX_LINES || "0", 10);
const CHUNK_SIZE = Number.parseInt(process.env.UMS_INGEST_CHUNK_SIZE || "250", 10);
const MAX_LINE_LENGTH = Number.parseInt(process.env.UMS_INGEST_MAX_LINE_LENGTH || "12000", 10);
const MIN_RULE_FREQUENCY = Number.parseInt(process.env.UMS_INGEST_MIN_RULE_FREQUENCY || "2", 10);
const MIN_ANTIPATTERN_FREQUENCY = Number.parseInt(process.env.UMS_INGEST_MIN_ANTIPATTERN_FREQUENCY || "2", 10);
const MAX_RULE_CANDIDATES = Number.parseInt(process.env.UMS_INGEST_MAX_RULE_CANDIDATES || "32", 10);
const MAX_ANTIPATTERN_NOTES = Number.parseInt(process.env.UMS_INGEST_MAX_ANTIPATTERNS || "12", 10);

const SENSITIVE_LINE_PATTERN =
  /\b(?:openai|anthropic|claude|codex|github|stripe|aws|azure|gcp)[-_]?(?:api[_-]?)?key\b|\b(?:id_token|access_token|refresh_token|client_secret|bearer|jwt|password|passphrase)\b/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:sk-[a-z0-9]{16,}|ghp_[a-z0-9]{16,}|github_pat_[a-z0-9_]{24,}|eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9._-]{20,}\.[a-zA-Z0-9._-]{20,})/i;
const JSONISH_NOISE_PATTERN =
  /\\[nrt]|"id_token"|"access_token"|"refresh_token"|"client_secret"|__typename|content-type:/i;

const RULE_DIRECTIVE_PATTERN = /\b(always|must|should|need to|make sure|prefer|ensure|verify|run|avoid)\b/i;
const RULE_WORKFLOW_PATTERN =
  /\b(test|tests|benchmark|lint|typecheck|build|artifact|dist|state|store|memory|ingest|validate|deterministic|replay|timeout|flaky|regression|persistence)\b/i;
const RULE_ACTION_PATTERN =
  /\b(cli|api|db|sqlite|json|schema|contract|migration|release|deploy|command|flag|option|parameter|coverage|e2e|unit|integration|perf|performance|benchmark)\b/i;
const RULE_BANNED_PATTERN =
  /\b(?:http:\/\/|https:\/\/|www\.|token|id_token|openai_api_key|bearer|jwt|click|button|screenshot|image|browser|coderabbit|jira|pull request|pr|fucking|schaltwerk|gh cli|codex-native|@techsio|worktree)\b/i;

const ANTIPATTERN_FAILURE_PATTERN = /\b(fail(?:ed|ure)?|blocked|timeout|flaky|regression|broken|error|crash)\b/i;
const ANTIPATTERN_WORKFLOW_PATTERN =
  /\b(build|test|tests|lint|typecheck|deploy|pipeline|validate|ingest|replay|ci|e2e|integration|unit|artifact|dist)\b/i;

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    stateFile: DEFAULT_SHARED_STATE_FILE,
    storeId: DEFAULT_STORE_ID,
    profile: DEFAULT_PROFILE,
    reportPath: DEFAULT_REPORT_PATH,
    help: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--state-file") {
      parsed.stateFile = args.shift() ?? "";
      continue;
    }
    if (token === "--store-id") {
      parsed.storeId = args.shift() ?? "";
      continue;
    }
    if (token === "--profile") {
      parsed.profile = args.shift() ?? "";
      continue;
    }
    if (token === "--report") {
      parsed.reportPath = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!parsed.storeId.trim()) {
    throw new Error("storeId must be a non-empty string.");
  }
  if (!parsed.profile.trim()) {
    throw new Error("profile must be a non-empty string.");
  }
  if (!parsed.reportPath.trim()) {
    throw new Error("report path must be a non-empty string.");
  }

  return parsed;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/ingest-coding-history.mjs [--state-file path] [--store-id id] [--profile id] [--report path]",
      "",
      "Defaults:",
      `  --state-file ${DEFAULT_SHARED_STATE_FILE}`,
      `  --store-id ${DEFAULT_STORE_ID}`,
      `  --profile ${DEFAULT_PROFILE}`,
      `  --report ${DEFAULT_REPORT_PATH}`,
      "",
      "Environment limits:",
      "  UMS_INGEST_MAX_FILES=0 (all files)",
      "  UMS_INGEST_MAX_LINES=0 (all lines)",
      "  UMS_INGEST_MAX_CONTENT=2200",
      "  UMS_INGEST_CHUNK_SIZE=250",
      "  UMS_INGEST_MAX_LINE_LENGTH=12000",
      "  UMS_INGEST_MIN_RULE_FREQUENCY=2",
      "  UMS_INGEST_MIN_ANTIPATTERN_FREQUENCY=2",
      "  UMS_INGEST_MAX_RULE_CANDIDATES=32",
      "  UMS_INGEST_MAX_ANTIPATTERNS=12",
    ].join("\n") + "\n",
  );
}

function truncate(value, maxLength = MAX_CONTENT_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

function normalizeText(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function shouldSkipRawLine(line) {
  const text = normalizeText(line);
  if (!text) {
    return true;
  }
  if (text.length > MAX_LINE_LENGTH) {
    return true;
  }
  if (SENSITIVE_LINE_PATTERN.test(text) || SENSITIVE_VALUE_PATTERN.test(text)) {
    return true;
  }
  return false;
}

function redactSensitiveContent(value) {
  let text = String(value ?? "");
  text = text
    .replace(
      /\b(?:openai|anthropic|claude|codex|github|stripe|aws|azure|gcp)[-_]?(?:api[_-]?)?key\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
      "[REDACTED_API_KEY]",
    )
    .replace(
      /\b(?:id_token|access_token|refresh_token|client_secret|password|passphrase)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
      "[REDACTED_SECRET]",
    )
    .replace(/\b(?:bearer|jwt)\s+[a-z0-9._-]{16,}/gi, "[REDACTED_TOKEN]")
    .replace(SENSITIVE_VALUE_PATTERN, "[REDACTED_TOKEN]");
  return text;
}

function looksLikeNoiseBlob(value) {
  const text = normalizeText(value);
  if (!text) {
    return true;
  }
  if (JSONISH_NOISE_PATTERN.test(text) && (text.match(/[:{}[\]"]/g)?.length ?? 0) > 24) {
    return true;
  }
  const letterCount = (text.match(/[a-z]/gi) ?? []).length;
  if (letterCount > 0) {
    const nonWordRatio = (text.match(/[^\w\s]/g) ?? []).length / text.length;
    if (nonWordRatio > 0.35 && letterCount / text.length < 0.45) {
      return true;
    }
  }
  return false;
}

function sanitizeEventContent(value) {
  const redacted = normalizeText(redactSensitiveContent(value));
  if (!redacted) {
    return "";
  }
  if (looksLikeNoiseBlob(redacted)) {
    return "";
  }
  return truncate(redacted);
}

function listJsonlFiles(rootDirectory) {
  if (!existsSync(rootDirectory)) {
    return [];
  }

  const files = [];
  const stack = [rootDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
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
  return MAX_FILES_PER_SOURCE > 0 ? files.slice(0, MAX_FILES_PER_SOURCE) : files;
}

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function pickFirstString(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const nested = pickFirstString(candidate, keys);
      if (nested) {
        return nested;
      }
    }
  }
  return "";
}

function pickText(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => pickText(entry)).filter(Boolean).join("\n").trim();
  }
  if (!value || typeof value !== "object") {
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

  if (Array.isArray(value.messages)) {
    const fromMessages = value.messages.map((entry) => pickText(entry)).filter(Boolean).join("\n");
    if (fromMessages) {
      return fromMessages.trim();
    }
  }

  return "";
}

function pickTimestamp(value) {
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

function pickRole(value) {
  const role = pickFirstString(value, ["role", "actor", "sender", "authorRole"]);
  return role || "unknown";
}

function buildTags(content, source, role) {
  const normalized = normalizeText(content).toLowerCase();
  const tags = [source, role];
  if (normalized.includes("cASS".toLowerCase()) || normalized.includes("ace pipeline")) {
    tags.push("cass");
  }
  if (
    normalized.includes("ncm") ||
    normalized.includes("neuromorphic") ||
    normalized.includes("stm") ||
    normalized.includes("ltm")
  ) {
    tags.push("ncm");
  }
  return Array.from(new Set(tags.filter(Boolean)));
}

async function loadConversationEvents({ files, source, storeId, profile }) {
  const events = [];
  for (const filePath of files) {
    const input = createReadStream(filePath, { encoding: "utf8" });
    const reader = createInterface({ input, crlfDelay: Infinity });

    let lineIndex = 0;
    for await (const line of reader) {
      lineIndex += 1;
      if (!line || !line.trim()) {
        continue;
      }
      if (MAX_LINES_PER_FILE > 0 && lineIndex > MAX_LINES_PER_FILE) {
        break;
      }
      if (shouldSkipRawLine(line)) {
        continue;
      }
      const parsed = tryParseJson(line);
      if (!parsed) {
        continue;
      }
      const content = pickText(parsed);
      if (!content) {
        continue;
      }
      const safeContent = sanitizeEventContent(content);
      if (!safeContent) {
        continue;
      }
      const role = pickRole(parsed).toLowerCase();
      const fileLabel = relative("/Users/satan", filePath) || filePath;
      const event = {
        id: `${source}-${fileLabel}-${lineIndex - 1}`,
        type: "note",
        source,
        content: safeContent,
        timestamp: pickTimestamp(parsed),
        tags: buildTags(safeContent, source, role),
        metadata: {
          role,
          file: fileLabel,
          line: lineIndex,
          storeId,
          profile,
        },
      };
      events.push(event);
    }

    input.close();
  }
  return events;
}

function loadCassNcmPlanEvents({ storeId, profile }) {
  const planPath = resolve(process.cwd(), "PLAN.md");
  if (!existsSync(planPath)) {
    return [];
  }
  const raw = readFileSync(planPath, "utf8");
  const sections = raw
    .split(/\n##\s+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const events = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const normalized = section.toLowerCase();
    if (!normalized.includes("cass") && !normalized.includes("ncm")) {
      continue;
    }
    const title = section.split("\n")[0] ?? "plan-section";
    events.push({
      id: `implementation-plan-${index}`,
      type: "note",
      source: "implementation-plan",
      content: truncate(section, 1800),
      timestamp: new Date().toISOString(),
      tags: buildTags(section, "implementation-plan", "doc"),
      metadata: {
        title,
        file: "PLAN.md",
        storeId,
        profile,
      },
    });
  }
  return events;
}

function chunk(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function normalizeLineForLesson(line) {
  return normalizeText(line)
    .replace(/^[-*>\d\).\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitContentLines(content) {
  return normalizeText(content)
    .replace(/\r/g, "\n")
    .split(/[\n.!?]+/g)
    .map(normalizeLineForLesson)
    .filter(Boolean);
}

function normalizeCandidateKey(line) {
  return normalizeText(line)
    .toLowerCase()
    .replace(/[`"'()[\]{}<>]/g, " ")
    .replace(/[:;,.!?/\\|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeRuleText(line) {
  let text = normalizeText(line).replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  const openParens = (text.match(/\(/g) ?? []).length;
  const closeParens = (text.match(/\)/g) ?? []).length;
  if (openParens > closeParens) {
    text = text.replace(/\([^)]*$/, "").trim();
  }
  if (text.length > 180) {
    text = `${text.slice(0, 177).trimEnd()}...`;
  }
  return text;
}

function isActionableRuleLine(line) {
  const text = normalizeText(line);
  if (!text) {
    return false;
  }
  if (text.length < 36 || text.length > 220) {
    return false;
  }
  if ((text.match(/\s+/g)?.length ?? 0) < 5) {
    return false;
  }
  if (text.startsWith("/") || text.includes('\\"') || text.includes("\\/")) {
    return false;
  }
  if (text.endsWith(":") || text.includes("?")) {
    return false;
  }
  if (/^(are|did|can|could|would|is|was|were|do you|did you)\b/i.test(text)) {
    return false;
  }
  if (text.includes("\\n") || text.includes("```")) {
    return false;
  }
  if (RULE_BANNED_PATTERN.test(text)) {
    return false;
  }
  if (!RULE_DIRECTIVE_PATTERN.test(text) || !RULE_WORKFLOW_PATTERN.test(text)) {
    return false;
  }
  if (!RULE_ACTION_PATTERN.test(text)) {
    return false;
  }
  return true;
}

function isActionableAntiPatternLine(line) {
  const text = normalizeText(line);
  if (!text) {
    return false;
  }
  if (text.length < 28 || text.length > 220) {
    return false;
  }
  if ((text.match(/\s+/g)?.length ?? 0) < 3) {
    return false;
  }
  if (text.includes("?") || text.includes("\\n") || text.endsWith(":")) {
    return false;
  }
  if (RULE_BANNED_PATTERN.test(text)) {
    return false;
  }
  if (!ANTIPATTERN_FAILURE_PATTERN.test(text) || !ANTIPATTERN_WORKFLOW_PATTERN.test(text)) {
    return false;
  }
  return true;
}

const CANONICAL_RULE_DEFINITIONS = [
  {
    statement: "Run lint, typecheck, and build before closing an implementation task.",
    test: (text) => /\blint\b/i.test(text) && /\b(typecheck|tsc)\b/i.test(text) && /\bbuild\b/i.test(text),
  },
  {
    statement: "Run E2E tests for critical flows before release or handoff.",
    test: (text) => /\b(e2e|playwright)\b/i.test(text),
  },
  {
    statement: "Benchmark after performance-affecting changes and compare against a baseline.",
    test: (text) => /\b(benchmark|perf|performance|latency|throughput)\b/i.test(text),
  },
  {
    statement: "Validate tests against built artifacts, not only source files.",
    test: (text) => /\b(artifact|dist|tarball|packed cli|compiled)\b/i.test(text),
  },
  {
    statement: "Keep tests deterministic and preserve replay information (such as seeds) on failure.",
    test: (text) => /\b(seed|deterministic|replay|fuzz)\b/i.test(text),
  },
  {
    statement: "Validate integrations in realistic conditions before marking work complete.",
    test: (text) => /\b(integration|real-world|real world|smoke test)\b/i.test(text),
  },
  {
    statement: "Track benchmark deltas and enforce regression gates in CI.",
    test: (text) => /\b(bench|regression|ci)\b/i.test(text),
  },
  {
    statement: "Prefer one shared persisted state model across CLI and API surfaces.",
    test: (text) => /\b(shared state|same state|cli and api|persistence|sqlite)\b/i.test(text),
  },
  {
    statement: "Add or update automated tests whenever behavior or interfaces change.",
    test: (text) => /\b(test|tests|coverage|unit|integration)\b/i.test(text) && /\b(change|new|update|behavior|interface)\b/i.test(text),
  },
  {
    statement: "Keep failure triage actionable by linking issues to reproducible commands and checks.",
    test: (text) => /\b(ready|triage|issue|reproduc|command|check)\b/i.test(text),
  },
  {
    statement: "Use Effect v4 patterns (including Effect.Service) for service wiring and error modeling.",
    test: (text) => /\b(effect v4|effectservice|effect\.service|effect-ts|effect patterns?)\b/i.test(text),
  },
  {
    statement: "Use Tailwind v4 conventions and keep Tailwind lint checks in CI.",
    test: (text) => /\b(tailwind v4|nativewind v5|lint:tailwind|tailwind)\b/i.test(text),
  },
  {
    statement: "Keep TypeScript strict mode enabled across packages.",
    test: (text) => /\b(strict typescript|strict ts|strict mode|strictnullchecks|noimplicitany)\b/i.test(text),
  },
  {
    statement: "Disallow explicit any in production code; model unknown input via schemas/decoders.",
    test: (text) => /\b(no any|avoid any|ban any|implicit any)\b/i.test(text),
  },
  {
    statement: "Disallow unsafe double assertions like 'as unknown as X'.",
    test: (text) => /\bas unknown as\b/i.test(text),
  },
];

function buildCanonicalRuleCandidates(events) {
  const matches = CANONICAL_RULE_DEFINITIONS.map((definition) => ({
    statement: definition.statement,
    sourceEventId: "unknown",
    frequency: 0,
  }));

  for (const event of events) {
    const text = normalizeText(event.content);
    if (!text) {
      continue;
    }
    for (let index = 0; index < CANONICAL_RULE_DEFINITIONS.length; index += 1) {
      const definition = CANONICAL_RULE_DEFINITIONS[index];
      if (!definition.test(text)) {
        continue;
      }
      const entry = matches[index];
      entry.frequency += 1;
      if (entry.sourceEventId === "unknown" && event.id) {
        entry.sourceEventId = event.id;
      }
    }
  }

  return matches
    .filter((entry) => entry.frequency > 0)
    .sort((left, right) => right.frequency - left.frequency || left.statement.localeCompare(right.statement))
    .map((entry) => ({
      statement: entry.statement,
      sourceEventId: entry.sourceEventId,
      confidence: Math.min(0.96, 0.68 + Math.log2(entry.frequency + 1) * 0.07),
      frequency: entry.frequency,
    }));
}

function buildHeuristicRuleCandidates(events, maxCandidates = MAX_RULE_CANDIDATES) {
  const buckets = new Map();

  for (const event of events) {
    const lines = splitContentLines(event.content);
    for (const line of lines) {
      const statement = sanitizeRuleText(line);
      if (!isActionableRuleLine(statement)) {
        continue;
      }
      const key = normalizeCandidateKey(statement);
      if (!key) {
        continue;
      }
      const existing = buckets.get(key) ?? {
        statement,
        sourceEventId: event.id,
        count: 0,
        sources: new Set(),
      };
      existing.count += 1;
      existing.sources.add(event.source);
      if (!existing.sourceEventId && event.id) {
        existing.sourceEventId = event.id;
      }
      buckets.set(key, existing);
    }
  }

  const sorted = [...buckets.values()].sort(
    (left, right) =>
      right.count - left.count ||
      right.sources.size - left.sources.size ||
      left.statement.localeCompare(right.statement),
  );
  const frequent = sorted.filter((entry) => entry.count >= MIN_RULE_FREQUENCY);
  const selected = [...frequent];
  if (selected.length < maxCandidates) {
    for (const entry of sorted) {
      if (selected.length >= maxCandidates) {
        break;
      }
      if (selected.includes(entry)) {
        continue;
      }
      selected.push(entry);
    }
  }

  return selected.slice(0, maxCandidates).map((entry) => ({
      statement: entry.statement,
      sourceEventId: entry.sourceEventId || "unknown",
      confidence: Math.min(0.97, 0.62 + Math.log2(entry.count + 1) * 0.08 + entry.sources.size * 0.03),
      frequency: entry.count,
    }));
}

function mergeRuleCandidates(candidateGroups, maxCandidates = MAX_RULE_CANDIDATES) {
  const merged = new Map();
  for (const group of candidateGroups) {
    for (const candidate of Array.isArray(group) ? group : []) {
      const statement = sanitizeRuleText(candidate?.statement);
      if (!statement) {
        continue;
      }
      const key = normalizeCandidateKey(statement);
      if (!key) {
        continue;
      }
      const existing = merged.get(key);
      const normalizedCandidate = {
        statement,
        sourceEventId: candidate?.sourceEventId || "unknown",
        confidence: Number(candidate?.confidence ?? 0.62),
        frequency: Number(candidate?.frequency ?? 1),
      };
      if (!existing) {
        merged.set(key, normalizedCandidate);
        continue;
      }
      existing.frequency = Math.max(existing.frequency, normalizedCandidate.frequency);
      existing.confidence = Math.max(existing.confidence, normalizedCandidate.confidence);
      if (existing.sourceEventId === "unknown" && normalizedCandidate.sourceEventId !== "unknown") {
        existing.sourceEventId = normalizedCandidate.sourceEventId;
      }
    }
  }
  return [...merged.values()]
    .sort((left, right) => right.frequency - left.frequency || right.confidence - left.confidence)
    .slice(0, maxCandidates);
}

function sanitizeAntiPatternText(value) {
  return normalizeText(value)
    .replace(/[✖✔⚠️✅•◆]/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .replace(/[:\-–—]{2,}/g, ":")
    .trim()
    .replace(/["']+$/, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

function extractActionableAntiPatterns(values, maxNotes = MAX_ANTIPATTERN_NOTES) {
  const deduped = Array.from(
    new Map(
      (Array.isArray(values) ? values : [])
        .map((raw) => sanitizeAntiPatternText(raw))
        .filter((note) => isActionableAntiPatternLine(note))
        .map((note) => [normalizeCandidateKey(note), note]),
    ).values(),
  );
  return deduped.slice(0, maxNotes);
}

function buildHeuristicAntiPatternNotes(events, maxNotes = MAX_ANTIPATTERN_NOTES) {
  const buckets = new Map();

  for (const event of events) {
    const lines = splitContentLines(event.content);
    for (const line of lines) {
      const note = sanitizeAntiPatternText(line);
      if (!isActionableAntiPatternLine(note)) {
        continue;
      }
      const key = normalizeCandidateKey(note);
      if (!key) {
        continue;
      }
      const existing = buckets.get(key) ?? { note, count: 0 };
      existing.count += 1;
      buckets.set(key, existing);
    }
  }

  const notes = [...buckets.values()]
    .filter((entry) => entry.count >= MIN_ANTIPATTERN_FREQUENCY)
    .sort((left, right) => right.count - left.count || left.note.localeCompare(right.note))
    .slice(0, maxNotes * 2)
    .map((entry) => entry.note);
  return extractActionableAntiPatterns(notes, maxNotes);
}

function toLearningInsights(contextPayload) {
  if (!contextPayload || !Array.isArray(contextPayload.matches)) {
    return [];
  }
  return contextPayload.matches.slice(0, 5).map((match) => ({
    eventId: match.eventId,
    source: match.source,
    content: truncate(match.content ?? match.excerpt ?? "", 260),
  }));
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printUsage();
    return 0;
  }

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
    source: "codex-cli",
    storeId: parsed.storeId,
    profile: parsed.profile,
  });
  const claudeEvents = await loadConversationEvents({
    files: claudeFiles,
    source: "claude-code",
    storeId: parsed.storeId,
    profile: parsed.profile,
  });
  const planEvents = loadCassNcmPlanEvents({ storeId: parsed.storeId, profile: parsed.profile });
  const allEvents = [...codexEvents, ...claudeEvents, ...planEvents];
  const eventChunks = chunk(allEvents, Math.max(1, CHUNK_SIZE));

  const ingestion = await executeOperationWithSharedState({
    operation: "ingest",
    stateFile: parsed.stateFile,
    executor: () => {
      const aggregate = {
        chunkCount: eventChunks.length,
        accepted: 0,
        duplicates: 0,
      };
      for (const eventChunk of eventChunks) {
        const result = executeOperation("ingest", {
          storeId: parsed.storeId,
          profile: parsed.profile,
          events: eventChunk,
        });
        aggregate.accepted += result.accepted;
        aggregate.duplicates += result.duplicates;
      }
      return aggregate;
    },
  });

  const learning = await executeOperationWithSharedState({
    operation: "curate",
    stateFile: parsed.stateFile,
    executor: () => {
      const canonicalCandidates = buildCanonicalRuleCandidates(allEvents);
      const heuristicCandidates = buildHeuristicRuleCandidates(allEvents, MAX_RULE_CANDIDATES);
      const highSignalHeuristics = heuristicCandidates.filter(
        (candidate) =>
          candidate.confidence >= 0.82 &&
          !/[^\x00-\x7F]/.test(candidate.statement) &&
          !/\b(@techsio|gskill|api keys|dockerfile|playwright_workers)\b/i.test(candidate.statement),
      );
      const combinedCandidates = mergeRuleCandidates([canonicalCandidates], MAX_RULE_CANDIDATES);
      const validate = executeOperation("validate", {
        storeId: parsed.storeId,
        profile: parsed.profile,
        candidates: combinedCandidates,
      });
      const curatedCandidates = combinedCandidates.filter((_, index) => validate.validations[index]?.valid);
      const curate = executeOperation("curate", {
        storeId: parsed.storeId,
        profile: parsed.profile,
        candidates: curatedCandidates,
      });
      const antiPatternNotes =
        ingestion.accepted > 0 ? buildHeuristicAntiPatternNotes(allEvents, MAX_ANTIPATTERN_NOTES) : [];
      const antiPatternSignals = [];
      if (antiPatternNotes.length > 0) {
        const defaultRuleId = curate.applied[0]?.ruleId ?? "history-ingest";
        for (const note of antiPatternNotes) {
          const feedback = executeOperation("feedback", {
            storeId: parsed.storeId,
            profile: parsed.profile,
            targetRuleId: defaultRuleId,
            signal: "harmful",
            note,
          });
          antiPatternSignals.push(feedback);
        }
      }
      const audit = executeOperation("audit", {
        storeId: parsed.storeId,
        profile: parsed.profile,
      });
      const exported = executeOperation("export", {
        storeId: parsed.storeId,
        profile: parsed.profile,
      });
      const cassContext = executeOperation("context", {
        storeId: parsed.storeId,
        profile: parsed.profile,
        query: "cass",
        limit: 5,
      });
      const ncmContext = executeOperation("context", {
        storeId: parsed.storeId,
        profile: parsed.profile,
        query: "ncm",
        limit: 5,
      });
      const doctor = executeOperation("doctor", {
        storeId: parsed.storeId,
        profile: parsed.profile,
      });
      return {
        canonicalCandidates,
        heuristicCandidates,
        highSignalHeuristics,
        combinedCandidates,
        validate,
        curate,
        antiPatternSignals,
        audit,
        exported,
        cassContext,
        ncmContext,
        doctor,
      };
    },
  });

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "coding-agent-only-persistent",
    stateFile: parsed.stateFile,
    storeId: parsed.storeId,
    profile: parsed.profile,
    sources: {
      codexJsonlFiles: codexFiles.length,
      claudeJsonlFiles: claudeFiles.length,
      planEvents: planEvents.length,
    },
    events: {
      prepared: allEvents.length,
      ingestedAccepted: ingestion.accepted,
      ingestedDuplicates: ingestion.duplicates,
      chunks: ingestion.chunkCount,
    },
    learning: {
      candidatesGenerated: learning.combinedCandidates.length,
      candidatesValidated: learning.validate.checked,
      rulesApplied: learning.curate.applied.length,
      totalRules: learning.curate.totalRules,
      antiPatternSignalsApplied: learning.antiPatternSignals.length,
      canonicalCandidatesGenerated: learning.canonicalCandidates.length,
      heuristicCandidatesGenerated: learning.heuristicCandidates.length,
      highSignalHeuristicCandidatesGenerated: learning.highSignalHeuristics.length,
      auditChecks: learning.audit.checks,
      topRules: learning.exported.playbook.topRules,
      antiPatterns: extractActionableAntiPatterns(learning.exported.playbook.antiPatterns, MAX_ANTIPATTERN_NOTES),
      cassEvidence: toLearningInsights(learning.cassContext),
      ncmEvidence: toLearningInsights(learning.ncmContext),
      doctorStatus: learning.doctor.status,
    },
  };

  mkdirSync(resolve(process.cwd(), "docs/reports"), { recursive: true });
  writeFileSync(resolve(parsed.reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`ingest-coding-history failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
