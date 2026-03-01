import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_TARGETS = ["bun-linux-x64", "bun-windows-x64"];
const DEFAULT_APPS = ["single"];
const SUPPORTED_APPS = new Map([
  ["single", { entry: "apps/ums/src/index.mjs", artifact: "ums" }],
  ["cli", { entry: "apps/cli/src/index.mjs", artifact: "ums-cli" }],
  ["api", { entry: "apps/api/src/server.mjs", artifact: "ums-api" }],
]);

function parseCsv(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const parsed = {
    targets: DEFAULT_TARGETS,
    apps: DEFAULT_APPS,
    outdir: "dist",
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
    if (token === "--targets") {
      parsed.targets = parseCsv(args.shift() ?? "");
      continue;
    }
    if (token === "--apps") {
      parsed.apps = parseCsv(args.shift() ?? "");
      continue;
    }
    if (token === "--outdir") {
      parsed.outdir = (args.shift() ?? "").trim();
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (parsed.targets.length === 0) {
    throw new Error("At least one target is required. Example: --targets bun-linux-x64,bun-windows-x64");
  }
  if (parsed.apps.length === 0) {
    throw new Error("At least one app is required. Example: --apps single");
  }
  if (!parsed.outdir) {
    throw new Error("Outdir must be a non-empty path.");
  }
  for (const app of parsed.apps) {
    if (!SUPPORTED_APPS.has(app)) {
      throw new Error(`Unsupported app '${app}'. Supported values: ${[...SUPPORTED_APPS.keys()].join(", ")}`);
    }
  }

  return parsed;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/build-sfe-matrix.mjs [--targets <csv>] [--apps <csv>] [--outdir <path>]",
      "",
      "Defaults:",
      `  --targets ${DEFAULT_TARGETS.join(",")}`,
      `  --apps ${DEFAULT_APPS.join(",")}`,
      "  --outdir dist",
      "",
      "Examples:",
      "  node scripts/build-sfe-matrix.mjs",
      "  node scripts/build-sfe-matrix.mjs --targets bun-linux-x64 --apps single",
      "  node scripts/build-sfe-matrix.mjs --targets bun-windows-x64,bun-linux-x64 --apps single,cli,api",
    ].join("\n") + "\n"
  );
}

function extensionForTarget(target) {
  return target.includes("windows") ? ".exe" : "";
}

function runBunBuild({ target, entry, outfile }) {
  const args = [
    "build",
    "--compile",
    "--minify",
    "--sourcemap",
    "--bytecode",
    `--target=${target}`,
    entry,
    "--outfile",
    outfile,
  ];
  const result = spawnSync("bun", args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`bun build failed for target '${target}' and entry '${entry}' (exit=${result.status}).`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const outputs = [];
  for (const target of parsed.targets) {
    const targetDir = resolve(parsed.outdir, target);
    await mkdir(targetDir, { recursive: true });
    for (const appName of parsed.apps) {
      const app = SUPPORTED_APPS.get(appName);
      const outfile = resolve(targetDir, `${app.artifact}${extensionForTarget(target)}`);
      process.stdout.write(`[build] ${appName} -> ${target} -> ${outfile}\n`);
      runBunBuild({
        target,
        entry: app.entry,
        outfile,
      });
      outputs.push(outfile);
    }
  }

  process.stdout.write(`\nBuilt ${outputs.length} executable(s):\n`);
  for (const output of outputs) {
    process.stdout.write(`- ${output}\n`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`build-sfe-matrix failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
