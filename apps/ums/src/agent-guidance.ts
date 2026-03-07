import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import {
  type DaemonConfig,
  explainDaemonRouteResolution,
  formatDaemonConfigError,
  readDaemonConfig,
} from "./daemon-config.ts";

export const CANONICAL_UMS_SKILL_NAME = "ums-memory";
export const GENERATED_AGENT_BLOCK_START = "<!-- BEGIN UMS MEMORY -->";
export const GENERATED_AGENT_BLOCK_END = "<!-- END UMS MEMORY -->";

export type AgentSnippetFormat = "agents" | "claude" | "copilot";

export interface AgentMemoryBinding {
  readonly memory: string | null;
  readonly routeStatus: "matched" | "default" | "review" | "drop" | null;
  readonly storeId: string | null;
  readonly profile: string | null;
}

export interface RenderAgentSnippetInput {
  readonly format: AgentSnippetFormat;
  readonly repoRoot: string;
  readonly configFile: string | null;
  readonly binding: AgentMemoryBinding;
}

export interface GeneratedSnippetFile {
  readonly format: AgentSnippetFormat;
  readonly path: string;
  readonly content: string;
}

export interface AgentSkillPayload {
  readonly operation: "agent.skill";
  readonly skillName: string;
  readonly skillPath: string;
  readonly format: "json" | "markdown";
  readonly content: string;
}

export interface AgentBootstrapPayload {
  readonly operation: "agent.bootstrap";
  readonly repoRoot: string;
  readonly skillName: string;
  readonly files: ReadonlyArray<{
    readonly format: AgentSnippetFormat;
    readonly path: string;
    readonly changed: boolean;
  }>;
  readonly binding: AgentMemoryBinding;
}

export interface AgentBootstrapCheckPayload {
  readonly operation: "agent.bootstrap.check";
  readonly repoRoot: string;
  readonly healthy: boolean;
  readonly message: string | null;
  readonly files: ReadonlyArray<{
    readonly format: AgentSnippetFormat;
    readonly path: string;
    readonly status: "missing" | "up_to_date" | "out_of_date";
  }>;
  readonly binding: AgentMemoryBinding;
}

interface AgentSkillArgs {
  readonly format: "json" | "markdown";
}

interface AgentBootstrapArgs {
  readonly configFile: string | null;
  readonly repoRoot: string | null;
  readonly format: AgentSnippetFormat | "all";
  readonly output: string | null;
  readonly check: boolean;
  readonly force: boolean;
}

interface AgentBootstrapCheckFile {
  readonly format: AgentSnippetFormat;
  readonly path: string;
  readonly status: "missing" | "up_to_date" | "out_of_date";
}

export class AgentGuidanceArgumentError extends Schema.TaggedErrorClass<AgentGuidanceArgumentError>()(
  "AgentGuidanceArgumentError",
  {
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class AgentGuidanceIoError extends Schema.TaggedErrorClass<AgentGuidanceIoError>()(
  "AgentGuidanceIoError",
  {
    operation: Schema.String,
    path: Schema.String,
    code: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class AgentGuidanceConflictError extends Schema.TaggedErrorClass<AgentGuidanceConflictError>()(
  "AgentGuidanceConflictError",
  {
    path: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class AgentGuidanceConfigLoadError extends Schema.TaggedErrorClass<AgentGuidanceConfigLoadError>()(
  "AgentGuidanceConfigLoadError",
  {
    configFile: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

const ERRNO_CAUSE_SCHEMA = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const isString = Schema.is(Schema.String);
const isBoolean = Schema.is(Schema.Boolean);
const isErrnoCause = Schema.is(ERRNO_CAUSE_SCHEMA);

const COMMON_RULES = Object.freeze([
  "Use `ums context` before any non-trivial task.",
  "Use `ums outcome` after meaningful work, tests, or delivery milestones.",
  "Use `ums feedback` when the user corrects, rejects, or confirms memory-guided behavior.",
  "Treat memory as advice grounded in provenance, not as truth. Check provenance before applying surprising guidance.",
  "Cite provenance when recalled memory changes implementation, architecture, or policy decisions.",
  "Never edit UMS state files manually. Use CLI/runtime operations only.",
  "If a memory item looks harmful or stale, escalate through audit/quarantine flows instead of silently overwriting history.",
]);

const COMMON_COMMANDS = Object.freeze([
  'Pre-flight context: `ums context --store-id <store-id> --input \'{"profile":"<profile>","query":"<task summary>"}\'`',
  "Outcome logging: `ums outcome --store-id <store-id> --input @outcome.json`",
  "Feedback logging: `ums feedback --store-id <store-id> --input @feedback.json`",
  "Route explain: `ums route explain --config-file <config> --path <repo-root>`",
]);
const EMBEDDED_CANONICAL_SKILL_PATH = "embedded://ums-memory/SKILL.md";

const toCauseDetails = (cause: unknown): string =>
  isErrnoCause(cause) ? cause.message : String(cause);

const toErrnoCode = (cause: unknown): string =>
  isErrnoCause(cause) ? cause.code : "UNKNOWN";

const normalizeOptionalString = (value: unknown): string | null => {
  if (!isString(value)) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const parseAgentSkillOutputFormat = (
  value: unknown
): Effect.Effect<"json" | "markdown", AgentGuidanceArgumentError> => {
  const normalized = normalizeOptionalString(value);
  if (normalized === "json" || normalized === "markdown") {
    return Effect.succeed(normalized);
  }
  return Effect.fail(
    new AgentGuidanceArgumentError({
      message: "--format must be one of json, markdown.",
      details: `Received '${normalized ?? "<empty>"}'.`,
    })
  );
};

const parseAgentSnippetFormat = (
  value: unknown
): Effect.Effect<AgentSnippetFormat | "all", AgentGuidanceArgumentError> => {
  const normalized = normalizeOptionalString(value);
  if (
    normalized === "agents" ||
    normalized === "claude" ||
    normalized === "copilot" ||
    normalized === "all"
  ) {
    return Effect.succeed(normalized);
  }
  return Effect.fail(
    new AgentGuidanceArgumentError({
      message: "--format must be one of agents, claude, copilot, all.",
      details: `Received '${normalized ?? "<empty>"}'.`,
    })
  );
};

const readUtf8 = (path: string, operation: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new AgentGuidanceIoError({
        operation,
        path,
        code: toErrnoCode(cause),
        message: `${operation} failed for ${path}.`,
        details: toCauseDetails(cause),
      }),
  });

const writeUtf8 = (path: string, content: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(path), { recursive: true }),
      catch: (cause) =>
        new AgentGuidanceIoError({
          operation: "mkdir",
          path: dirname(path),
          code: toErrnoCode(cause),
          message: `mkdir failed for ${dirname(path)}.`,
          details: toCauseDetails(cause),
        }),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(path, content, "utf8"),
      catch: (cause) =>
        new AgentGuidanceIoError({
          operation: "writeFile",
          path,
          code: toErrnoCode(cause),
          message: `writeFile failed for ${path}.`,
          details: toCauseDetails(cause),
        }),
    });
  });

const fileExists = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      await access(path);
      return true;
    },
    catch: (cause) =>
      new AgentGuidanceIoError({
        operation: "access",
        path,
        code: toErrnoCode(cause),
        message: `access failed for ${path}.`,
        details: toCauseDetails(cause),
      }),
  }).pipe(
    Effect.match({
      onSuccess: () => Effect.succeed(true),
      onFailure: (error) =>
        error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error),
    }),
    Effect.flatten
  );

const emptyBinding = (): AgentMemoryBinding => ({
  memory: null,
  routeStatus: null,
  storeId: null,
  profile: null,
});

const formatHeading = (format: AgentSnippetFormat): string =>
  format === "copilot" ? "# UMS Memory Instructions" : "# UMS Memory Bootstrap";

const formatPreamble = (format: AgentSnippetFormat): readonly string[] =>
  format === "copilot"
    ? [
        "If a global skill system exists, load the canonical `ums-memory` skill first.",
        "This file is the repo-local thin wrapper for the same CLI-first contract.",
      ]
    : [
        "Load the canonical `ums-memory` skill when your agent runtime supports global skills.",
        "This file is the thin repo-local wrapper for the same CLI-first contract.",
      ];

export const defaultAgentSnippetPath = (
  repoRoot: string,
  format: AgentSnippetFormat
): string =>
  format === "agents"
    ? resolve(repoRoot, "AGENTS.md")
    : format === "claude"
      ? resolve(repoRoot, "CLAUDE.md")
      : resolve(repoRoot, ".github", "copilot-instructions.md");

const canonicalSkillPathCandidates = (): readonly string[] => [
  fileURLToPath(
    new URL("../../../skills/ums-memory/SKILL.md", import.meta.url)
  ),
  resolve(process.cwd(), "skills", "ums-memory", "SKILL.md"),
];

export const isMainImportMetaFlag = (
  value: boolean | undefined
): value is true => isBoolean(value) && value;

export const resolveAgentMemoryBinding = (
  config: DaemonConfig,
  repoRoot: string
): AgentMemoryBinding => {
  const resolution = explainDaemonRouteResolution(config, {
    path: repoRoot,
    repoRoot,
    workspaceRoot: repoRoot,
  });
  if (
    (resolution.status === "matched" || resolution.status === "default") &&
    resolution.memory
  ) {
    const memory = config.memories[resolution.memory];
    if (memory) {
      return {
        memory: resolution.memory,
        routeStatus: resolution.status,
        storeId: memory.storeId,
        profile: memory.profile,
      };
    }
  }
  return {
    memory: resolution.memory,
    routeStatus: resolution.status,
    storeId: null,
    profile: null,
  };
};

const renderBindingLines = (
  binding: AgentMemoryBinding,
  configFile: string | null
): readonly string[] =>
  binding.storeId && binding.profile
    ? [
        `Resolved memory: \`${binding.memory ?? "unknown"}\``,
        `Resolved store/profile: \`${binding.storeId}\` / \`${binding.profile}\``,
        ...(configFile ? [`Routing config: \`${configFile}\``] : []),
      ]
    : [
        "No repo-specific memory route is currently resolved.",
        ...(configFile
          ? [
              `Run \`ums route explain --config-file ${configFile} --path <repo-root>\` before relying on memory output.`,
            ]
          : [
              "Pass `--config-file` when you need deterministic repo-to-memory routing.",
            ]),
      ];

export const renderAgentSnippet = (input: RenderAgentSnippetInput): string => {
  const lines = [
    GENERATED_AGENT_BLOCK_START,
    formatHeading(input.format),
    "",
    ...formatPreamble(input.format),
    "",
    "## Required Behavior",
    ...COMMON_RULES.map((rule) => `- ${rule}`),
    "",
    "## CLI Patterns",
    ...COMMON_COMMANDS.map((command) => `- ${command}`),
    "",
    "## Repo Binding",
    ...renderBindingLines(input.binding, input.configFile).map(
      (line) => `- ${line}`
    ),
    "",
    "## Safety",
    "- If context recall conflicts with fresher evidence in the repo or tests, prefer the fresher evidence and record feedback/outcome.",
    "- Cite provenance when memory changes implementation behavior or policy decisions.",
    GENERATED_AGENT_BLOCK_END,
    "",
  ];
  return `${lines.join("\n")}\n`;
};

const renderCanonicalSkillContent = (): string =>
  `${[
    "---",
    `name: ${CANONICAL_UMS_SKILL_NAME}`,
    "description: Universal CLI-first UMS skill for pre-flight context retrieval, outcome logging, feedback, provenance discipline, and harmful-memory handling across Codex, Claude, Copilot, and similar agents.",
    "---",
    "",
    "# UMS Memory",
    "",
    "Use this skill whenever an agent should consume or manage UMS through the CLI-first runtime surface.",
    "",
    "## Core Contract",
    ...COMMON_RULES.map((rule) => `- ${rule}`),
    "",
    "## Minimal Workflow",
    "1. Before non-trivial work, call `ums context` with the repo/task query and the correct `storeId` / `profile` when known.",
    "2. During work, keep provenance in view and prefer fresher repo evidence over surprising recalled memory.",
    "3. After meaningful work, log `ums outcome` with task success/failure and the memory ids or rule ids used when available.",
    "4. When the user corrects or rejects behavior, log `ums feedback` rather than silently changing prompts or state.",
    "5. If memory looks harmful, stale, or unsafe, route to audit/quarantine controls instead of manually editing state files.",
    "",
    "## CLI Examples",
    ...COMMON_COMMANDS.map((command) => `- ${command}`),
    "",
    "## Scope and Provenance",
    "- Respect repo/project routing. Do not assume one repo's memory applies to another without an explicit route or shared memory definition.",
    "- Treat memory as bounded guidance tied to provenance and scope, not as an authority above current code, tests, or policy.",
    "- Prefer auditable controls (`feedback`, `policy_audit_export`, `manual_quarantine_override`) over hidden side channels.",
    "",
  ].join("\n")}\n`;

const resolveCanonicalSkillPathEffect = (): Effect.Effect<
  string,
  AgentGuidanceIoError
> =>
  Effect.gen(function* () {
    for (const candidate of canonicalSkillPathCandidates()) {
      const exists = yield* fileExists(candidate);
      if (exists) {
        return candidate;
      }
    }
    return EMBEDDED_CANONICAL_SKILL_PATH;
  });

const upsertGeneratedAgentBlockEffect = (input: {
  readonly currentContent: string | null;
  readonly renderedBlock: string;
  readonly forceReplaceWholeFile: boolean;
  readonly path: string;
}) => {
  if (input.currentContent === null) {
    return Effect.succeed({
      content: input.renderedBlock,
      changed: true,
    });
  }

  const startIndex = input.currentContent.indexOf(GENERATED_AGENT_BLOCK_START);
  const endIndex = input.currentContent.indexOf(GENERATED_AGENT_BLOCK_END);
  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    const afterBlockIndex = endIndex + GENERATED_AGENT_BLOCK_END.length;
    const content = `${input.currentContent.slice(0, startIndex)}${input.renderedBlock}${input.currentContent.slice(afterBlockIndex).replace(/^\n*/, "\n")}`;
    return Effect.succeed({
      content,
      changed: content !== input.currentContent,
    });
  }

  if (input.forceReplaceWholeFile) {
    return Effect.succeed({
      content: input.renderedBlock,
      changed: input.renderedBlock !== input.currentContent,
    });
  }

  return Effect.fail(
    new AgentGuidanceConflictError({
      path: input.path,
      message:
        "Target file exists without a managed UMS block. Re-run with --force or choose a different output path.",
      details:
        "The file already exists and does not contain the managed UMS block markers.",
    })
  );
};

const parseConfigFileFromArgs = (
  argv: readonly string[]
): {
  readonly configFile: string | null;
  readonly rest: readonly string[];
} => {
  const rest: string[] = [];
  let configFile: string | null = null;
  const args = [...argv];

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--config-file") {
      configFile = normalizeOptionalString(args.shift());
      continue;
    }
    rest.push(token);
  }

  return {
    configFile,
    rest,
  };
};

const parseAgentSkillArgsEffect = (
  argv: readonly string[]
): Effect.Effect<AgentSkillArgs, AgentGuidanceArgumentError> =>
  Effect.gen(function* () {
    const args = [...argv];
    let format: "json" | "markdown" = "json";

    while (args.length > 0) {
      const token = args.shift();
      if (!token) {
        continue;
      }
      if (token === "--format") {
        format = yield* parseAgentSkillOutputFormat(args.shift());
        continue;
      }
      yield* Effect.fail(
        new AgentGuidanceArgumentError({
          message: `Unknown agent skill argument: ${token}`,
          details: `Unsupported token '${token}'.`,
        })
      );
    }

    return { format };
  });

const parseAgentBootstrapArgsEffect = (
  argv: readonly string[]
): Effect.Effect<AgentBootstrapArgs, AgentGuidanceArgumentError> =>
  Effect.gen(function* () {
    const parsed = parseConfigFileFromArgs(argv);
    const args = [...parsed.rest];
    let repoRoot: string | null = null;
    let format: AgentSnippetFormat | "all" = "all";
    let output: string | null = null;
    let check = false;
    let force = false;

    while (args.length > 0) {
      const token = args.shift();
      if (!token) {
        continue;
      }
      if (token === "--repo-root") {
        repoRoot = normalizeOptionalString(args.shift());
        continue;
      }
      if (token === "--format") {
        format = yield* parseAgentSnippetFormat(args.shift());
        continue;
      }
      if (token === "--output") {
        output = normalizeOptionalString(args.shift());
        continue;
      }
      if (token === "--check") {
        check = true;
        continue;
      }
      if (token === "--force") {
        force = true;
        continue;
      }
      yield* Effect.fail(
        new AgentGuidanceArgumentError({
          message: `Unknown agent bootstrap argument: ${token}`,
          details: `Unsupported token '${token}'.`,
        })
      );
    }

    return {
      configFile: parsed.configFile,
      repoRoot,
      format,
      output,
      check,
      force,
    };
  });

const loadAgentBindingEffect = (
  configFile: string | null,
  repoRoot: string
): Effect.Effect<
  {
    readonly configFile: string | null;
    readonly binding: AgentMemoryBinding;
  },
  AgentGuidanceConfigLoadError
> =>
  configFile === null
    ? Effect.succeed({
        configFile: null,
        binding: emptyBinding(),
      })
    : Effect.tryPromise({
        try: () => readDaemonConfig(configFile),
        catch: (cause) =>
          new AgentGuidanceConfigLoadError({
            configFile,
            message: "Failed to load daemon config for agent routing.",
            details: formatDaemonConfigError(cause),
          }),
      }).pipe(
        Effect.map((loaded) => ({
          configFile: loaded.configFile,
          binding: resolveAgentMemoryBinding(loaded.config, repoRoot),
        }))
      );

export const readCanonicalSkillEffect = (
  argv: readonly string[]
): Effect.Effect<
  AgentSkillPayload,
  AgentGuidanceArgumentError | AgentGuidanceIoError
> =>
  Effect.gen(function* () {
    const parsed = yield* parseAgentSkillArgsEffect(argv);
    const skillPath = yield* resolveCanonicalSkillPathEffect();
    const content =
      skillPath === EMBEDDED_CANONICAL_SKILL_PATH
        ? renderCanonicalSkillContent()
        : yield* readUtf8(skillPath, "readFile");
    return {
      operation: "agent.skill",
      skillName: CANONICAL_UMS_SKILL_NAME,
      skillPath,
      format: parsed.format,
      content,
    };
  });

const writeManagedSnippetFileEffect = (input: {
  readonly path: string;
  readonly content: string;
  readonly force: boolean;
}) =>
  Effect.gen(function* () {
    const currentContent = yield* fileExists(input.path).pipe(
      Effect.flatMap((exists) =>
        exists
          ? readUtf8(input.path, "readFile")
          : Effect.succeed<string | null>(null)
      )
    );
    const next = yield* upsertGeneratedAgentBlockEffect({
      currentContent,
      renderedBlock: input.content,
      forceReplaceWholeFile: input.force,
      path: input.path,
    });
    if (next.changed) {
      yield* writeUtf8(input.path, next.content);
    }
    return {
      changed: next.changed,
    };
  });

const plannedFormats = (
  format: AgentSnippetFormat | "all"
): readonly AgentSnippetFormat[] =>
  format === "all" ? ["agents", "claude", "copilot"] : [format];

const renderPlannedFiles = (input: {
  readonly repoRoot: string;
  readonly output: string | null;
  readonly format: AgentSnippetFormat | "all";
  readonly configFile: string | null;
  readonly binding: AgentMemoryBinding;
}): readonly GeneratedSnippetFile[] =>
  plannedFormats(input.format).map((format) => ({
    format,
    path: input.output ?? defaultAgentSnippetPath(input.repoRoot, format),
    content: renderAgentSnippet({
      format,
      repoRoot: input.repoRoot,
      configFile: input.configFile,
      binding: input.binding,
    }),
  }));

const checkManagedSnippetFileEffect = (
  file: GeneratedSnippetFile
): Effect.Effect<AgentBootstrapCheckFile, AgentGuidanceIoError> =>
  Effect.gen(function* () {
    const exists = yield* fileExists(file.path);
    if (!exists) {
      return {
        format: file.format,
        path: file.path,
        status: "missing" as const,
      };
    }
    const current = yield* readUtf8(file.path, "readFile");
    return {
      format: file.format,
      path: file.path,
      status:
        current.includes(GENERATED_AGENT_BLOCK_START) &&
        current.includes(GENERATED_AGENT_BLOCK_END) &&
        current.includes(file.content.trim())
          ? ("up_to_date" as const)
          : ("out_of_date" as const),
    };
  });

export const runAgentBootstrapEffect = (
  argv: readonly string[]
): Effect.Effect<
  AgentBootstrapPayload | AgentBootstrapCheckPayload,
  | AgentGuidanceArgumentError
  | AgentGuidanceIoError
  | AgentGuidanceConflictError
  | AgentGuidanceConfigLoadError
> =>
  Effect.gen(function* () {
    const parsed = yield* parseAgentBootstrapArgsEffect(argv);
    const repoRoot = resolve(parsed.repoRoot ?? process.cwd());
    const bindingResult = yield* loadAgentBindingEffect(
      parsed.configFile,
      repoRoot
    );
    const selectedFormats = plannedFormats(parsed.format);

    if (parsed.output && selectedFormats.length !== 1) {
      yield* Effect.fail(
        new AgentGuidanceArgumentError({
          message: "--output can only be used with a single --format value.",
          details: "Pass a single --format when using --output.",
        })
      );
    }

    const plannedFiles = renderPlannedFiles({
      repoRoot,
      output: parsed.output,
      format: parsed.format,
      configFile: bindingResult.configFile,
      binding: bindingResult.binding,
    });

    if (parsed.check) {
      const files = yield* Effect.all(
        plannedFiles.map((file) => checkManagedSnippetFileEffect(file))
      );
      const unhealthy = files.filter((entry) => entry.status !== "up_to_date");
      if (unhealthy.length > 0) {
        return {
          operation: "agent.bootstrap.check",
          repoRoot,
          healthy: false,
          message: `Bootstrap snippet drift detected for ${unhealthy
            .map((entry) => `${entry.format}:${entry.status}`)
            .join(", ")}.`,
          files,
          binding: bindingResult.binding,
        };
      }
      return {
        operation: "agent.bootstrap.check",
        repoRoot,
        healthy: true,
        message: null,
        files,
        binding: bindingResult.binding,
      };
    }

    const files = yield* Effect.all(
      plannedFiles.map((file) =>
        writeManagedSnippetFileEffect({
          path: file.path,
          content: file.content,
          force: parsed.force,
        }).pipe(
          Effect.map((written) => ({
            format: file.format,
            path: file.path,
            changed: written.changed,
          }))
        )
      )
    );

    return {
      operation: "agent.bootstrap",
      repoRoot,
      skillName: CANONICAL_UMS_SKILL_NAME,
      files,
      binding: bindingResult.binding,
    };
  });
