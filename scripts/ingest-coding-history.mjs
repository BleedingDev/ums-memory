import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { executeOperation } from "../apps/api/src/core.mjs";
import { DEFAULT_SHARED_STATE_FILE, executeOperationWithSharedState } from "../apps/api/src/persistence.mjs";

const DEFAULT_STORE_ID = "coding-agent";
const DEFAULT_PROFILE = "agent-history";
const DEFAULT_REPORT_PATH = resolve(
  process.cwd(),
  "docs/reports/coding-agent-persistent-ingestion-summary.json",
);
const MAX_CONTENT_LENGTH = Number.parseInt(process.env.UMS_INGEST_MAX_CONTENT || "2200", 10);
const MAX_FILES_PER_SOURCE = Number.parseInt(process.env.UMS_INGEST_MAX_FILES || "0", 10);
const MAX_LINES_PER_FILE = Number.parseInt(process.env.UMS_INGEST_MAX_LINES || "0", 10);
const CHUNK_SIZE = Number.parseInt(process.env.UMS_INGEST_CHUNK_SIZE || "250", 10);

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
      const event = {
        type: "note",
        source,
        content: truncate(content),
        timestamp: pickTimestamp(parsed),
        tags: buildTags(content, source, role),
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
  for (const section of sections) {
    const normalized = section.toLowerCase();
    if (!normalized.includes("cass") && !normalized.includes("ncm")) {
      continue;
    }
    const title = section.split("\n")[0] ?? "plan-section";
    events.push({
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

function uniqueCandidates(candidates) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const statement = normalizeText(candidate?.statement).toLowerCase();
    if (!statement || seen.has(statement)) {
      continue;
    }
    seen.add(statement);
    deduped.push(candidate);
  }
  return deduped;
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
      const reflect = executeOperation("reflect", {
        storeId: parsed.storeId,
        profile: parsed.profile,
        maxCandidates: 48,
      });
      const validate = executeOperation("validate", {
        storeId: parsed.storeId,
        profile: parsed.profile,
        candidates: reflect.candidates,
      });
      const validCandidateIds = new Set(
        validate.validations.filter((entry) => entry.valid).map((entry) => entry.candidateId),
      );
      const curatedCandidates = uniqueCandidates(
        reflect.candidates.filter((candidate) => validCandidateIds.has(candidate.candidateId)),
      );
      const curate = executeOperation("curate", {
        storeId: parsed.storeId,
        profile: parsed.profile,
        candidates: curatedCandidates,
      });
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
        reflect,
        validate,
        curate,
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
      candidatesGenerated: learning.reflect.candidateCount,
      candidatesValidated: learning.validate.checked,
      rulesApplied: learning.curate.applied.length,
      totalRules: learning.curate.totalRules,
      auditChecks: learning.audit.checks,
      topRules: learning.exported.playbook.topRules,
      antiPatterns: learning.exported.playbook.antiPatterns,
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
