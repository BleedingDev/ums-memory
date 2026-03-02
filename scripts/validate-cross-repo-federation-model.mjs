import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RESULT_SCHEMA_VERSION = "cross_repo_federation_model_validation.v1";
const DEFAULT_RUNBOOK_PATH = path.resolve(
  process.cwd(),
  "docs/runbooks/cross-repo-memory-federation-model.md",
);

const REQUIRED_HEADINGS = Object.freeze([
  "## Purpose",
  "## Scope",
  "## Baseline Constraints (Must Hold)",
  "## Federation Topology",
  "## Policy Enforcement Model",
  "## Deterministic Retrieval and Conflict Rules",
  "## Operations, Deployment, and Monitoring",
  "## Rollout Plan",
  "## Go/No-Go Metrics",
  "## Explicit Non-Goals",
]);

const REQUIRED_PHRASES = Object.freeze([
  "ums-memory-dd2.4",
  "common, project, job_role, user",
  "policy enforcement",
  "tenant isolation",
  "Better Auth",
  "strict TypeScript + Effect",
  "compose-first",
  "SQLite",
]);

const REQUIRED_CONTENT_RULES = Object.freeze([
  Object.freeze({
    id: "required-denial-audit-event",
    pattern: /federation\.share\.denied/iu,
  }),
  Object.freeze({
    id: "cross-tenant-leak-zero",
    pattern: /cross-tenant leak incidents == 0/iu,
  }),
  Object.freeze({
    id: "federated-latency-threshold",
    pattern: /federated retrieval p95 latency delta <= 20%/iu,
  }),
  Object.freeze({
    id: "policy-cache-ttl",
    pattern: /policy decision cache ttl <= 60s/iu,
  }),
  Object.freeze({
    id: "deterministic-dedupe-precedence",
    pattern: /highest-precedence scope candidate wins/iu,
  }),
]);

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function validateCrossRepoFederationModel({
  runbookPath = DEFAULT_RUNBOOK_PATH,
} = {}) {
  const absoluteRunbookPath = path.resolve(runbookPath);
  const markdown = await readFile(absoluteRunbookPath, "utf8");

  const missingHeadings = REQUIRED_HEADINGS.filter((heading) => !markdown.includes(heading));
  const missingPhrases = REQUIRED_PHRASES.filter(
    (phrase) => !new RegExp(escapeRegExp(phrase), "iu").test(markdown),
  );
  const missingContentRules = REQUIRED_CONTENT_RULES.filter((rule) => !rule.pattern.test(markdown)).map(
    (rule) => rule.id,
  );

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runbookPath: normalizePath(absoluteRunbookPath),
    missingHeadings,
    missingPhrases,
    missingContentRules,
    ok: missingHeadings.length === 0 && missingPhrases.length === 0 && missingContentRules.length === 0,
  };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/validate-cross-repo-federation-model.mjs [--file <path>] [--json]",
      "",
      "Options:",
      "  --file         Path to cross-repo federation runbook markdown.",
      "  --json         Emit structured JSON output.",
      "  --help, -h     Show this help text.",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv) {
  const parsed = {
    runbookPath: DEFAULT_RUNBOOK_PATH,
    json: false,
    help: false,
  };

  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--file") {
      const value = args.shift();
      if (!value) {
        throw new Error("--file requires a value.");
      }
      parsed.runbookPath = path.resolve(value);
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function printResult(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Schema version: ${result.schemaVersion}`,
      `Runbook path: ${result.runbookPath}`,
      `Missing headings: ${result.missingHeadings.length}`,
      ...result.missingHeadings.map((heading) => `  - ${heading}`),
      `Missing phrases: ${result.missingPhrases.length}`,
      ...result.missingPhrases.map((phrase) => `  - ${phrase}`),
      `Missing content rules: ${result.missingContentRules.length}`,
      ...result.missingContentRules.map((rule) => `  - ${rule}`),
      `Result: ${result.ok ? "ok" : "failed"}`,
    ].join("\n") + "\n",
  );
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
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

  try {
    const result = await validateCrossRepoFederationModel({ runbookPath: parsed.runbookPath });
    printResult(result, parsed.json);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await main();
  process.exit(code);
}
