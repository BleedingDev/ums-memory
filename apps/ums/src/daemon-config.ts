import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";

import { Cause, Effect, Exit, Schema } from "effect";

const DEFAULT_CONFIG_FILE = resolve(homedir(), ".ums", "config.jsonc");
const DEFAULT_STATE_ROOT = resolve(homedir(), ".ums", "state");
const DEFAULT_JOURNAL_DIR = resolve(DEFAULT_STATE_ROOT, "journal");
const DEFAULT_CHECKPOINT_DIR = resolve(DEFAULT_STATE_ROOT, "checkpoints");
const DEFAULT_COMPACT_DELIVERED_AFTER_HOURS = 168;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_MAX_EVENTS_PER_CYCLE = 400;
const ACCOUNT_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CREDENTIAL_REF_PATTERN =
  /^(keychain|credential-manager|secret-service):\/\/.+$/;
const UNKNOWN_RECORD_SCHEMA = Schema.Record(Schema.String, Schema.Unknown);
const ROUTE_SOURCE_SET = new Set([
  "codex",
  "claude",
  "cursor",
  "opencode",
  "vscode",
  "codex-native",
  "plan",
]);
const SOURCE_BINDING_STATUS_SET = new Set([
  "pending",
  "approved",
  "disabled",
  "ignored",
]);
const SOURCE_BINDING_KIND_SET = new Set(["directory", "file"]);
const SOURCE_BINDING_HEALTH_SET = new Set(["ready", "missing", "unsupported"]);
const SOURCE_KEYS = [
  "codex",
  "claude",
  "cursor",
  "opencode",
  "vscode",
  "codexNative",
  "plan",
] as const;
const DAEMON_CONFIG_ISSUE_SCHEMA = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});
const DAEMON_CONFIG_ERROR_LIKE_SCHEMA = Schema.Struct({
  code: Schema.Union([
    Schema.Literal("DAEMON_CONFIG_PARSE_ERROR"),
    Schema.Literal("DAEMON_CONFIG_VALIDATION_ERROR"),
  ]),
  message: Schema.String,
  issues: Schema.Array(DAEMON_CONFIG_ISSUE_SCHEMA),
  configFile: Schema.NullOr(Schema.String),
});
const ERROR_WITH_MESSAGE_SCHEMA = Schema.Struct({
  message: Schema.String,
});
const ERRNO_CAUSE_SCHEMA = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const isDaemonConfigErrorLike = Schema.is(DAEMON_CONFIG_ERROR_LIKE_SCHEMA);
const isErrorWithMessage = Schema.is(ERROR_WITH_MESSAGE_SCHEMA);
const isErrnoCause = Schema.is(ERRNO_CAUSE_SCHEMA);
const isUnknownRecord = Schema.is(UNKNOWN_RECORD_SCHEMA);
const isString = Schema.is(Schema.String);
const isBoolean = Schema.is(Schema.Boolean);

type JsonRecord = Record<string, unknown>;

export type DaemonConfigRouteSource =
  | "codex"
  | "claude"
  | "cursor"
  | "opencode"
  | "vscode"
  | "codex-native"
  | "plan";
export type DaemonConfigSourceKey =
  | "codex"
  | "claude"
  | "cursor"
  | "opencode"
  | "vscode"
  | "codexNative"
  | "plan";
export type DaemonConfigAmbiguousPolicy = "review" | "default" | "drop";
export type DaemonSourceBindingStatus =
  | "pending"
  | "approved"
  | "disabled"
  | "ignored";
export type DaemonSourceBindingKind = "directory" | "file";
export type DaemonSourceBindingHealth = "ready" | "missing" | "unsupported";

export interface DaemonConfigState {
  readonly rootDir: string;
  readonly journalDir: string;
  readonly checkpointDir: string;
  readonly compactDeliveredAfterHours: number;
}

export interface LocalDaemonAccountConfig {
  readonly type: "local";
}

export interface KeychainDaemonAccountAuthConfig {
  readonly mode: "oauth-device" | "oidc-pkce" | "session-ref";
  readonly credentialRef: string;
}

export interface EnvDaemonAccountAuthConfig {
  readonly mode: "token-env";
  readonly env: string;
}

export type DaemonAccountAuthConfig =
  | KeychainDaemonAccountAuthConfig
  | EnvDaemonAccountAuthConfig;

export interface HttpDaemonAccountConfig {
  readonly type: "http";
  readonly apiBaseUrl: string;
  readonly auth: DaemonAccountAuthConfig;
}

export type DaemonAccountConfig =
  | LocalDaemonAccountConfig
  | HttpDaemonAccountConfig;

export interface DaemonMemoryConfig {
  readonly account: string;
  readonly storeId: string;
  readonly profile: string;
  readonly project?: string;
  readonly workspace?: string;
  readonly readOnly: boolean;
  readonly tags: readonly string[];
}

export interface DaemonAdapterConfig {
  readonly enabled?: boolean;
  readonly roots: readonly string[];
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
}

export interface DaemonSourceBinding {
  readonly id: string;
  readonly source: DaemonConfigRouteSource;
  readonly kind: DaemonSourceBindingKind;
  readonly path: string;
  readonly status: DaemonSourceBindingStatus;
  readonly label?: string;
  readonly health?: DaemonSourceBindingHealth;
  readonly lastSeenAt?: string;
}

export interface DaemonSourcesConfig {
  readonly defaults: {
    readonly scanIntervalMs: number;
    readonly maxEventsPerCycle: number;
  };
  readonly bindings: readonly DaemonSourceBinding[];
  readonly codex?: DaemonAdapterConfig;
  readonly claude?: DaemonAdapterConfig;
  readonly cursor?: DaemonAdapterConfig;
  readonly opencode?: DaemonAdapterConfig;
  readonly vscode?: DaemonAdapterConfig;
  readonly codexNative?: DaemonAdapterConfig;
  readonly plan?: DaemonAdapterConfig;
}

export interface DaemonRouteMatchConfig {
  readonly pathPrefix?: string;
  readonly repoRoot?: string;
  readonly workspaceRoot?: string;
  readonly source?: DaemonConfigRouteSource;
}

export interface DaemonRouteConfig {
  readonly match: DaemonRouteMatchConfig;
  readonly memory: string;
  readonly priority: number;
  readonly project?: string;
  readonly workspace?: string;
  readonly notes?: string;
}

export interface DaemonDefaultsConfig {
  readonly memory: string;
  readonly onAmbiguous: DaemonConfigAmbiguousPolicy;
  readonly sync: {
    readonly intervalMs: number;
    readonly maxEventsPerCycle: number;
  };
}

export interface DaemonPolicyConfig {
  readonly allowEnvTokenFallback: boolean;
  readonly allowPlaintextDevAuth: boolean;
  readonly requireProjectForManagedWrites: boolean;
  readonly managedMemoryPrefixes: readonly string[];
}

export interface DaemonConfig {
  readonly version: 1;
  readonly state: DaemonConfigState;
  readonly accounts: Readonly<Record<string, DaemonAccountConfig>>;
  readonly memories: Readonly<Record<string, DaemonMemoryConfig>>;
  readonly sources: DaemonSourcesConfig;
  readonly routes: readonly DaemonRouteConfig[];
  readonly defaults: DaemonDefaultsConfig;
  readonly policy: DaemonPolicyConfig;
}

export interface DaemonConfigIssue {
  readonly path: string;
  readonly message: string;
}

export class DaemonConfigError extends Schema.TaggedErrorClass<DaemonConfigError>()(
  "DaemonConfigError",
  {
    code: Schema.Union([
      Schema.Literal("DAEMON_CONFIG_PARSE_ERROR"),
      Schema.Literal("DAEMON_CONFIG_VALIDATION_ERROR"),
    ]),
    message: Schema.String,
    issues: Schema.Array(DAEMON_CONFIG_ISSUE_SCHEMA),
    configFile: Schema.NullOr(Schema.String),
  }
) {}

export interface ReadDaemonConfigResult {
  readonly configFile: string;
  readonly config: DaemonConfig;
}

export interface DaemonRouteResolutionInput {
  readonly path?: string | null;
  readonly repoRoot?: string | null;
  readonly workspaceRoot?: string | null;
  readonly source?: DaemonConfigRouteSource | null;
}

export interface DaemonRouteResolutionCandidate {
  readonly index: number;
  readonly memory: string;
  readonly priority: number;
  readonly specificity: number;
  readonly pathPrefixLength: number;
  readonly matchReasons: readonly string[];
  readonly route: DaemonRouteConfig;
}

export interface DaemonRouteResolutionResult {
  readonly status: "matched" | "default" | "review" | "drop";
  readonly memory: string | null;
  readonly routeIndex: number | null;
  readonly candidates: readonly DaemonRouteResolutionCandidate[];
  readonly normalizedInput: {
    readonly path: string | null;
    readonly repoRoot: string | null;
    readonly workspaceRoot: string | null;
    readonly source: DaemonConfigRouteSource | null;
  };
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  isUnknownRecord(value);

const normalizeNonEmptyString = (value: unknown): string | null => {
  if (!isString(value)) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  isBoolean(value) ? value : fallback;

const normalizePositiveInteger = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const hashValue = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const buildDaemonSourceBindingId = (
  source: DaemonConfigRouteSource,
  kind: DaemonSourceBindingKind,
  path: string
): string => `src_${hashValue(`${source}|${kind}|${path}`).slice(0, 16)}`;

const pushIssue = (
  issues: DaemonConfigIssue[],
  path: string,
  message: string
): void => {
  issues.push({ path, message });
};

const expandHomePath = (
  value: string,
  baseDir: string = process.cwd()
): string => {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(baseDir, value);
};

const normalizeOptionalPath = (
  value: string | null | undefined
): string | null => {
  const normalized = normalizeNonEmptyString(value);
  return normalized ? expandHomePath(normalized) : null;
};

const isWindowsLikePath = (path: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\");

const pathStartsWithPrefix = (path: string, prefix: string): boolean => {
  const pathModule =
    isWindowsLikePath(path) || isWindowsLikePath(prefix)
      ? win32
      : { relative, isAbsolute };
  const relativePath = pathModule.relative(prefix, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath))
  );
};

const normalizePathString = (
  value: unknown,
  path: string,
  issues: DaemonConfigIssue[],
  baseDir: string
): string | null => {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    pushIssue(issues, path, "must be a non-empty path string.");
    return null;
  }
  return expandHomePath(normalized, baseDir);
};

const normalizeAlias = (
  value: unknown,
  path: string,
  issues: DaemonConfigIssue[]
): string | null => {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    pushIssue(issues, path, "must be a non-empty alias.");
    return null;
  }
  if (!ACCOUNT_ALIAS_PATTERN.test(normalized)) {
    pushIssue(issues, path, "must match ^[a-z0-9][a-z0-9._-]{0,63}$.");
    return null;
  }
  return normalized;
};

const normalizeStringArray = (
  value: unknown,
  path: string,
  issues: DaemonConfigIssue[],
  normalizeEntry: (entry: string) => string = (entry) => entry
): readonly string[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    pushIssue(issues, path, "must be an array of strings.");
    return [];
  }
  const deduped = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const normalized = normalizeNonEmptyString(entry);
    if (!normalized) {
      pushIssue(issues, `${path}[${index}]`, "must be a non-empty string.");
      continue;
    }
    deduped.add(normalizeEntry(normalized));
  }
  return [...deduped].sort((left, right) => left.localeCompare(right));
};

const normalizeRouteSource = (
  value: unknown,
  path: string,
  issues: DaemonConfigIssue[]
): DaemonConfigRouteSource | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    pushIssue(issues, path, "must be a non-empty source string.");
    return undefined;
  }
  if (!ROUTE_SOURCE_SET.has(normalized)) {
    pushIssue(
      issues,
      path,
      `must be one of ${[...ROUTE_SOURCE_SET].join(", ")}.`
    );
    return undefined;
  }
  return normalized as DaemonConfigRouteSource;
};

const inferSourceBindingKind = (path: string): DaemonSourceBindingKind =>
  /\.(?:jsonl|json|md|sqlite|db)$/i.test(path) ? "file" : "directory";

const normalizeSourceBindingKind = (
  value: unknown,
  path: string,
  issues: DaemonConfigIssue[],
  fallbackPath: string | null
): DaemonSourceBindingKind => {
  if (value === undefined) {
    return fallbackPath ? inferSourceBindingKind(fallbackPath) : "directory";
  }
  const normalized = normalizeNonEmptyString(value);
  if (!normalized || !SOURCE_BINDING_KIND_SET.has(normalized)) {
    pushIssue(
      issues,
      path,
      `must be one of ${[...SOURCE_BINDING_KIND_SET].join(", ")}.`
    );
    return fallbackPath ? inferSourceBindingKind(fallbackPath) : "directory";
  }
  return normalized as DaemonSourceBindingKind;
};

const normalizeSourceBindingStatus = (
  value: unknown,
  path: string,
  issues: DaemonConfigIssue[]
): DaemonSourceBindingStatus => {
  if (value === undefined) {
    return "approved";
  }
  const normalized = normalizeNonEmptyString(value);
  if (!normalized || !SOURCE_BINDING_STATUS_SET.has(normalized)) {
    pushIssue(
      issues,
      path,
      `must be one of ${[...SOURCE_BINDING_STATUS_SET].join(", ")}.`
    );
    return "approved";
  }
  return normalized as DaemonSourceBindingStatus;
};

const normalizeSourceBindingHealth = (
  value: unknown,
  path: string,
  issues: DaemonConfigIssue[]
): DaemonSourceBindingHealth | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeNonEmptyString(value);
  if (!normalized || !SOURCE_BINDING_HEALTH_SET.has(normalized)) {
    pushIssue(
      issues,
      path,
      `must be one of ${[...SOURCE_BINDING_HEALTH_SET].join(", ")}.`
    );
    return undefined;
  }
  return normalized as DaemonSourceBindingHealth;
};

const sourceBindingSortKey = (binding: DaemonSourceBinding): string =>
  JSON.stringify({
    source: binding.source,
    kind: binding.kind,
    path: binding.path,
    status: binding.status,
    label: binding.label ?? null,
    health: binding.health ?? null,
    lastSeenAt: binding.lastSeenAt ?? null,
    id: binding.id,
  });

const routeMatchSpecificity = (match: DaemonRouteMatchConfig): number => {
  if (match.repoRoot) {
    return 0;
  }
  if (match.workspaceRoot) {
    return 1;
  }
  if (match.pathPrefix) {
    return 2;
  }
  return 3;
};

const routeSortKey = (route: DaemonRouteConfig): string =>
  JSON.stringify({
    match: route.match,
    memory: route.memory,
    project: route.project ?? null,
    workspace: route.workspace ?? null,
    notes: route.notes ?? null,
  });

const stableSortObject = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );

const removeJsonComments = (input: string): string => {
  let output = "";
  let index = 0;
  let inString = false;
  let escaping = false;

  while (index < input.length) {
    const current = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (inString) {
      output += current;
      if (escaping) {
        escaping = false;
      } else if (current === "\\") {
        escaping = true;
      } else if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      index += 1;
      continue;
    }

    if (current === "/" && next === "/") {
      index += 2;
      while (index < input.length) {
        const char = input[index] ?? "";
        if (char === "\n" || char === "\r") {
          output += char;
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (index < input.length) {
        const char = input[index] ?? "";
        const lookahead = input[index + 1] ?? "";
        if (char === "*" && lookahead === "/") {
          index += 2;
          break;
        }
        if (char === "\n" || char === "\r") {
          output += char;
        }
        index += 1;
      }
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
};

const removeTrailingCommas = (input: string): string => {
  let output = "";
  let inString = false;
  let escaping = false;
  let index = 0;

  while (index < input.length) {
    const current = input[index] ?? "";
    if (inString) {
      output += current;
      if (escaping) {
        escaping = false;
      } else if (current === "\\") {
        escaping = true;
      } else if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      index += 1;
      continue;
    }

    if (current === ",") {
      let lookahead = index + 1;
      while (lookahead < input.length) {
        const next = input[lookahead] ?? "";
        if (next.trim().length === 0) {
          lookahead += 1;
          continue;
        }
        if (next === "]" || next === "}") {
          index += 1;
          break;
        }
        output += current;
        index += 1;
        break;
      }
      if (lookahead >= input.length) {
        output += current;
        index += 1;
      }
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
};

export const parseJsonc = (input: string): unknown => {
  const withoutComments = removeJsonComments(input);
  const withoutTrailingCommas = removeTrailingCommas(withoutComments);
  return JSON.parse(withoutTrailingCommas);
};

const normalizeAccountConfig = (
  alias: string,
  value: unknown,
  issues: DaemonConfigIssue[]
): DaemonAccountConfig | null => {
  if (!isJsonRecord(value)) {
    pushIssue(issues, `accounts.${alias}`, "must be an object.");
    return null;
  }
  const type = normalizeNonEmptyString(value["type"]);
  if (type === "local") {
    return { type: "local" };
  }
  if (type !== "http") {
    pushIssue(issues, `accounts.${alias}.type`, "must be 'local' or 'http'.");
    return null;
  }
  const apiBaseUrl = normalizeNonEmptyString(value["apiBaseUrl"]);
  if (!apiBaseUrl) {
    pushIssue(
      issues,
      `accounts.${alias}.apiBaseUrl`,
      "must be a non-empty absolute URL."
    );
  }
  let sanitizedApiBaseUrl: string | null = null;
  if (apiBaseUrl) {
    if (!URL.canParse(apiBaseUrl)) {
      pushIssue(
        issues,
        `accounts.${alias}.apiBaseUrl`,
        "must be a valid absolute URL."
      );
    } else {
      const parsedUrl = new URL(apiBaseUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        pushIssue(
          issues,
          `accounts.${alias}.apiBaseUrl`,
          "must use http or https."
        );
      } else {
        parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
        sanitizedApiBaseUrl = parsedUrl.toString().replace(/\/$/, "");
      }
    }
  }
  const auth = isJsonRecord(value["auth"]) ? value["auth"] : null;
  if (!auth) {
    pushIssue(issues, `accounts.${alias}.auth`, "must be an object.");
    return null;
  }
  const mode = normalizeNonEmptyString(auth["mode"]);
  if (
    mode === "oauth-device" ||
    mode === "oidc-pkce" ||
    mode === "session-ref"
  ) {
    const credentialRef = normalizeNonEmptyString(auth["credentialRef"]);
    if (!credentialRef) {
      pushIssue(
        issues,
        `accounts.${alias}.auth.credentialRef`,
        "must be a non-empty secure credential reference."
      );
      return null;
    }
    if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) {
      pushIssue(
        issues,
        `accounts.${alias}.auth.credentialRef`,
        "must use keychain://, credential-manager://, or secret-service://."
      );
      return null;
    }
    if (!sanitizedApiBaseUrl) {
      return null;
    }
    return {
      type: "http",
      apiBaseUrl: sanitizedApiBaseUrl,
      auth: {
        mode,
        credentialRef,
      },
    };
  }
  if (mode === "token-env") {
    const env = normalizeNonEmptyString(auth["env"]);
    if (!env) {
      pushIssue(
        issues,
        `accounts.${alias}.auth.env`,
        "must be a non-empty environment variable name."
      );
      return null;
    }
    if (!sanitizedApiBaseUrl) {
      return null;
    }
    return {
      type: "http",
      apiBaseUrl: sanitizedApiBaseUrl,
      auth: {
        mode,
        env,
      },
    };
  }
  pushIssue(
    issues,
    `accounts.${alias}.auth.mode`,
    "must be one of oauth-device, oidc-pkce, session-ref, token-env."
  );
  return null;
};

const normalizeMemoryConfig = (
  alias: string,
  value: unknown,
  issues: DaemonConfigIssue[]
): DaemonMemoryConfig | null => {
  if (!isJsonRecord(value)) {
    pushIssue(issues, `memories.${alias}`, "must be an object.");
    return null;
  }
  const account = normalizeAlias(
    value["account"],
    `memories.${alias}.account`,
    issues
  );
  const storeId = normalizeNonEmptyString(value["storeId"]);
  if (!storeId) {
    pushIssue(
      issues,
      `memories.${alias}.storeId`,
      "must be a non-empty string."
    );
  }
  const profile = normalizeNonEmptyString(value["profile"]);
  if (!profile) {
    pushIssue(
      issues,
      `memories.${alias}.profile`,
      "must be a non-empty string."
    );
  }
  const project = normalizeNonEmptyString(value["project"]) ?? undefined;
  const workspace = normalizeNonEmptyString(value["workspace"]) ?? undefined;
  const readOnly = normalizeBoolean(value["readOnly"], false);
  const tags = normalizeStringArray(
    value["tags"],
    `memories.${alias}.tags`,
    issues
  );
  if (!account || !storeId || !profile) {
    return null;
  }
  return {
    account,
    storeId,
    profile,
    ...(project ? { project } : {}),
    ...(workspace ? { workspace } : {}),
    readOnly,
    tags,
  };
};

const normalizeAdapterConfig = (
  adapterKey: string,
  value: unknown,
  issues: DaemonConfigIssue[],
  baseDir: string
): DaemonAdapterConfig | null => {
  if (value === undefined) {
    return null;
  }
  if (!isJsonRecord(value)) {
    pushIssue(issues, `sources.${adapterKey}`, "must be an object.");
    return null;
  }
  return {
    ...(isBoolean(value["enabled"]) ? { enabled: value["enabled"] } : {}),
    roots: normalizeStringArray(
      value["roots"],
      `sources.${adapterKey}.roots`,
      issues,
      (entry) => expandHomePath(entry, baseDir)
    ),
    includeGlobs: normalizeStringArray(
      value["includeGlobs"],
      `sources.${adapterKey}.includeGlobs`,
      issues
    ),
    excludeGlobs: normalizeStringArray(
      value["excludeGlobs"],
      `sources.${adapterKey}.excludeGlobs`,
      issues
    ),
  };
};

const normalizeSourceBinding = (
  value: unknown,
  index: number,
  issues: DaemonConfigIssue[],
  baseDir: string
): DaemonSourceBinding | null => {
  const path = `sources.bindings[${index}]`;
  if (!isJsonRecord(value)) {
    pushIssue(issues, path, "must be an object.");
    return null;
  }
  const source = normalizeRouteSource(
    value["source"],
    `${path}.source`,
    issues
  );
  const normalizedPath = normalizePathString(
    value["path"],
    `${path}.path`,
    issues,
    baseDir
  );
  const kind = normalizeSourceBindingKind(
    value["kind"],
    `${path}.kind`,
    issues,
    normalizedPath
  );
  const status = normalizeSourceBindingStatus(
    value["status"],
    `${path}.status`,
    issues
  );
  const label = normalizeNonEmptyString(value["label"]) ?? undefined;
  const health = normalizeSourceBindingHealth(
    value["health"],
    `${path}.health`,
    issues
  );
  const lastSeenAt = normalizeNonEmptyString(value["lastSeenAt"]) ?? undefined;
  if (!source || !normalizedPath) {
    return null;
  }
  return {
    id:
      normalizeNonEmptyString(value["id"]) ??
      buildDaemonSourceBindingId(source, kind, normalizedPath),
    source,
    kind,
    path: normalizedPath,
    status,
    ...(label ? { label } : {}),
    ...(health ? { health } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
  };
};

const normalizeSourceBindings = (
  value: unknown,
  issues: DaemonConfigIssue[],
  baseDir: string
): readonly DaemonSourceBinding[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    pushIssue(issues, "sources.bindings", "must be an array.");
    return [];
  }
  const bindings: DaemonSourceBinding[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const normalized = normalizeSourceBinding(entry, index, issues, baseDir);
    if (!normalized) {
      continue;
    }
    if (seenIds.has(normalized.id)) {
      pushIssue(
        issues,
        `sources.bindings[${index}].id`,
        `duplicates existing binding id '${normalized.id}'.`
      );
      continue;
    }
    const pathKey = `${normalized.source}|${normalized.kind}|${normalized.path}`;
    if (seenPaths.has(pathKey)) {
      pushIssue(
        issues,
        `sources.bindings[${index}]`,
        "duplicates another binding after normalization."
      );
      continue;
    }
    seenIds.add(normalized.id);
    seenPaths.add(pathKey);
    bindings.push(normalized);
  }
  return bindings.sort((left, right) =>
    sourceBindingSortKey(left).localeCompare(sourceBindingSortKey(right))
  );
};

const normalizeSourcesConfig = (
  value: unknown,
  issues: DaemonConfigIssue[],
  baseDir: string
): DaemonSourcesConfig => {
  const record = isJsonRecord(value) ? value : {};
  const defaults = isJsonRecord(record["defaults"]) ? record["defaults"] : {};
  const adapters: Partial<Record<DaemonConfigSourceKey, DaemonAdapterConfig>> =
    {};
  for (const adapterKey of SOURCE_KEYS) {
    const normalized = normalizeAdapterConfig(
      adapterKey,
      record[adapterKey],
      issues,
      baseDir
    );
    if (normalized) {
      adapters[adapterKey] = normalized;
    }
  }
  return {
    defaults: {
      scanIntervalMs: normalizePositiveInteger(
        defaults["scanIntervalMs"],
        DEFAULT_SCAN_INTERVAL_MS
      ),
      maxEventsPerCycle: normalizePositiveInteger(
        defaults["maxEventsPerCycle"],
        DEFAULT_MAX_EVENTS_PER_CYCLE
      ),
    },
    bindings: normalizeSourceBindings(record["bindings"], issues, baseDir),
    ...adapters,
  };
};

const normalizeRouteConfig = (
  value: unknown,
  index: number,
  issues: DaemonConfigIssue[],
  baseDir: string
): DaemonRouteConfig | null => {
  const path = `routes[${index}]`;
  if (!isJsonRecord(value)) {
    pushIssue(issues, path, "must be an object.");
    return null;
  }
  const match = isJsonRecord(value["match"]) ? value["match"] : null;
  if (!match) {
    pushIssue(issues, `${path}.match`, "must be an object.");
    return null;
  }
  const normalizedMatch: {
    pathPrefix?: string;
    repoRoot?: string;
    workspaceRoot?: string;
    source?: DaemonConfigRouteSource;
  } = {};
  if (match["pathPrefix"] !== undefined) {
    const pathPrefix = normalizePathString(
      match["pathPrefix"],
      `${path}.match.pathPrefix`,
      issues,
      baseDir
    );
    if (pathPrefix) {
      normalizedMatch.pathPrefix = pathPrefix;
    }
  }
  if (match["repoRoot"] !== undefined) {
    const repoRoot = normalizePathString(
      match["repoRoot"],
      `${path}.match.repoRoot`,
      issues,
      baseDir
    );
    if (repoRoot) {
      normalizedMatch.repoRoot = repoRoot;
    }
  }
  if (match["workspaceRoot"] !== undefined) {
    const workspaceRoot = normalizePathString(
      match["workspaceRoot"],
      `${path}.match.workspaceRoot`,
      issues,
      baseDir
    );
    if (workspaceRoot) {
      normalizedMatch.workspaceRoot = workspaceRoot;
    }
  }
  if (match["source"] !== undefined) {
    const source = normalizeRouteSource(
      match["source"],
      `${path}.match.source`,
      issues
    );
    if (source) {
      normalizedMatch.source = source;
    }
  }
  if (Object.keys(normalizedMatch).length === 0) {
    pushIssue(
      issues,
      `${path}.match`,
      "must include at least one match field."
    );
  }
  const memory = normalizeAlias(value["memory"], `${path}.memory`, issues);
  const priorityRaw = Number.parseInt(String(value["priority"] ?? "0"), 10);
  const priority =
    Number.isFinite(priorityRaw) &&
    priorityRaw >= -10_000 &&
    priorityRaw <= 10_000
      ? priorityRaw
      : 0;
  if (
    value["priority"] !== undefined &&
    (!Number.isFinite(priorityRaw) ||
      priorityRaw < -10_000 ||
      priorityRaw > 10_000)
  ) {
    pushIssue(
      issues,
      `${path}.priority`,
      "must be an integer between -10000 and 10000."
    );
  }
  const project = normalizeNonEmptyString(value["project"]) ?? undefined;
  const workspace = normalizeNonEmptyString(value["workspace"]) ?? undefined;
  const notes = normalizeNonEmptyString(value["notes"]) ?? undefined;
  if (!memory || Object.keys(normalizedMatch).length === 0) {
    return null;
  }
  return {
    match: normalizedMatch,
    memory,
    priority,
    ...(project ? { project } : {}),
    ...(workspace ? { workspace } : {}),
    ...(notes ? { notes } : {}),
  };
};

const normalizeDefaultsConfig = (
  value: unknown,
  issues: DaemonConfigIssue[]
): DaemonDefaultsConfig | null => {
  if (!isJsonRecord(value)) {
    pushIssue(issues, "defaults", "must be an object.");
    return null;
  }
  const memory = normalizeAlias(value["memory"], "defaults.memory", issues);
  const onAmbiguousRaw = normalizeNonEmptyString(value["onAmbiguous"]);
  const onAmbiguous =
    onAmbiguousRaw === "review" ||
    onAmbiguousRaw === "default" ||
    onAmbiguousRaw === "drop"
      ? onAmbiguousRaw
      : null;
  if (!onAmbiguous) {
    pushIssue(
      issues,
      "defaults.onAmbiguous",
      "must be one of review, default, drop."
    );
  }
  const sync = isJsonRecord(value["sync"]) ? value["sync"] : {};
  if (!memory || !onAmbiguous) {
    return null;
  }
  return {
    memory,
    onAmbiguous,
    sync: {
      intervalMs: normalizePositiveInteger(
        sync["intervalMs"],
        DEFAULT_SCAN_INTERVAL_MS
      ),
      maxEventsPerCycle: normalizePositiveInteger(
        sync["maxEventsPerCycle"],
        DEFAULT_MAX_EVENTS_PER_CYCLE
      ),
    },
  };
};

const normalizePolicyConfig = (
  value: unknown,
  issues: DaemonConfigIssue[]
): DaemonPolicyConfig => {
  const record = isJsonRecord(value) ? value : {};
  return {
    allowEnvTokenFallback: normalizeBoolean(
      record["allowEnvTokenFallback"],
      false
    ),
    allowPlaintextDevAuth: normalizeBoolean(
      record["allowPlaintextDevAuth"],
      false
    ),
    requireProjectForManagedWrites: normalizeBoolean(
      record["requireProjectForManagedWrites"],
      false
    ),
    managedMemoryPrefixes: normalizeStringArray(
      record["managedMemoryPrefixes"],
      "policy.managedMemoryPrefixes",
      issues
    ),
  };
};

const normalizeStateConfig = (
  value: unknown,
  issues: DaemonConfigIssue[],
  baseDir: string
): DaemonConfigState => {
  const record = isJsonRecord(value) ? value : {};
  const rootDir =
    (record["rootDir"] === undefined
      ? DEFAULT_STATE_ROOT
      : normalizePathString(
          record["rootDir"],
          "state.rootDir",
          issues,
          baseDir
        )) ?? DEFAULT_STATE_ROOT;
  const journalDir =
    (record["journalDir"] === undefined
      ? resolve(rootDir, "journal")
      : normalizePathString(
          record["journalDir"],
          "state.journalDir",
          issues,
          baseDir
        )) ?? DEFAULT_JOURNAL_DIR;
  const checkpointDir =
    (record["checkpointDir"] === undefined
      ? resolve(rootDir, "checkpoints")
      : normalizePathString(
          record["checkpointDir"],
          "state.checkpointDir",
          issues,
          baseDir
        )) ?? DEFAULT_CHECKPOINT_DIR;
  return {
    rootDir,
    journalDir,
    checkpointDir,
    compactDeliveredAfterHours: normalizePositiveInteger(
      record["compactDeliveredAfterHours"],
      DEFAULT_COMPACT_DELIVERED_AFTER_HOURS
    ),
  };
};

const validateCrossReferences = (
  config: DaemonConfig,
  issues: DaemonConfigIssue[]
): void => {
  for (const [alias, memory] of Object.entries(config.memories)) {
    if (!config.accounts[memory.account]) {
      pushIssue(
        issues,
        `memories.${alias}.account`,
        `references unknown account '${memory.account}'.`
      );
    }
  }
  for (const [index, route] of config.routes.entries()) {
    if (!config.memories[route.memory]) {
      pushIssue(
        issues,
        `routes[${index}].memory`,
        `references unknown memory '${route.memory}'.`
      );
    }
  }
  if (!config.memories[config.defaults.memory]) {
    pushIssue(
      issues,
      "defaults.memory",
      `references unknown memory '${config.defaults.memory}'.`
    );
  }
  const seenRouteKeys = new Set<string>();
  for (const [index, route] of config.routes.entries()) {
    const routeKey = routeSortKey(route);
    if (seenRouteKeys.has(routeKey)) {
      pushIssue(
        issues,
        `routes[${index}]`,
        "duplicates another route after normalization."
      );
      continue;
    }
    seenRouteKeys.add(routeKey);
  }
  for (const managedPrefix of config.policy.managedMemoryPrefixes) {
    const found = Object.keys(config.memories).some((alias) =>
      alias.startsWith(managedPrefix)
    );
    if (!found) {
      pushIssue(
        issues,
        "policy.managedMemoryPrefixes",
        `prefix '${managedPrefix}' matches no configured memory alias.`
      );
    }
  }
  if (!config.policy.allowEnvTokenFallback) {
    for (const [alias, account] of Object.entries(config.accounts)) {
      if (account.type === "http" && account.auth.mode === "token-env") {
        pushIssue(
          issues,
          `accounts.${alias}.auth.mode`,
          "token-env requires policy.allowEnvTokenFallback=true."
        );
      }
    }
  }
};

export const canonicalizeDaemonConfig = (
  raw: unknown,
  options: { readonly configFile?: string | null } = {}
): DaemonConfig => {
  const issues: DaemonConfigIssue[] = [];
  const configBaseDir = options.configFile
    ? dirname(resolve(options.configFile))
    : process.cwd();
  if (!isJsonRecord(raw)) {
    throw new DaemonConfigError({
      code: "DAEMON_CONFIG_VALIDATION_ERROR",
      message: "Daemon config must be an object.",
      issues: [{ path: "$", message: "must be an object." }],
      configFile: options.configFile ?? null,
    });
  }
  const version = Number.parseInt(String(raw["version"] ?? ""), 10);
  if (version !== 1) {
    pushIssue(issues, "version", "must equal 1.");
  }
  const accountsInput = isJsonRecord(raw["accounts"]) ? raw["accounts"] : null;
  if (!accountsInput) {
    pushIssue(
      issues,
      "accounts",
      "must be an object with at least one account."
    );
  }
  const memoriesInput = isJsonRecord(raw["memories"]) ? raw["memories"] : null;
  if (!memoriesInput) {
    pushIssue(
      issues,
      "memories",
      "must be an object with at least one memory."
    );
  }
  const routesInput = Array.isArray(raw["routes"]) ? raw["routes"] : null;
  if (!routesInput) {
    pushIssue(issues, "routes", "must be an array with at least one route.");
  }
  const defaults = normalizeDefaultsConfig(raw["defaults"], issues);

  const accounts: Record<string, DaemonAccountConfig> = {};
  if (accountsInput) {
    for (const [key, value] of Object.entries(accountsInput).sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      const alias = normalizeAlias(key, `accounts.${key}`, issues);
      if (!alias) {
        continue;
      }
      const normalized = normalizeAccountConfig(alias, value, issues);
      if (normalized) {
        accounts[alias] = normalized;
      }
    }
  }

  const memories: Record<string, DaemonMemoryConfig> = {};
  if (memoriesInput) {
    for (const [key, value] of Object.entries(memoriesInput).sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      const alias = normalizeAlias(key, `memories.${key}`, issues);
      if (!alias) {
        continue;
      }
      const normalized = normalizeMemoryConfig(alias, value, issues);
      if (normalized) {
        memories[alias] = normalized;
      }
    }
  }

  const routes = (routesInput ?? [])
    .map((value, index) =>
      normalizeRouteConfig(value, index, issues, configBaseDir)
    )
    .filter((value): value is DaemonRouteConfig => value !== null)
    .sort((left, right) => {
      const priorityDiff = right.priority - left.priority;
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const specificityDiff =
        routeMatchSpecificity(left.match) - routeMatchSpecificity(right.match);
      if (specificityDiff !== 0) {
        return specificityDiff;
      }
      const leftPathLength = left.match.pathPrefix?.length ?? 0;
      const rightPathLength = right.match.pathPrefix?.length ?? 0;
      if (leftPathLength !== rightPathLength) {
        return rightPathLength - leftPathLength;
      }
      return routeSortKey(left).localeCompare(routeSortKey(right));
    });

  const config: DaemonConfig = {
    version: 1,
    state: normalizeStateConfig(raw["state"], issues, configBaseDir),
    accounts: stableSortObject(accounts),
    memories: stableSortObject(memories),
    sources: normalizeSourcesConfig(raw["sources"], issues, configBaseDir),
    routes,
    defaults:
      defaults ??
      ({
        memory: "",
        onAmbiguous: "review",
        sync: {
          intervalMs: DEFAULT_SCAN_INTERVAL_MS,
          maxEventsPerCycle: DEFAULT_MAX_EVENTS_PER_CYCLE,
        },
      } as DaemonDefaultsConfig),
    policy: normalizePolicyConfig(raw["policy"], issues),
  };

  validateCrossReferences(config, issues);

  if (Object.keys(config.accounts).length === 0) {
    pushIssue(issues, "accounts", "must contain at least one account.");
  }
  if (Object.keys(config.memories).length === 0) {
    pushIssue(issues, "memories", "must contain at least one memory.");
  }
  if (config.routes.length === 0) {
    pushIssue(issues, "routes", "must contain at least one route.");
  }

  if (issues.length > 0) {
    throw new DaemonConfigError({
      code: "DAEMON_CONFIG_VALIDATION_ERROR",
      message: `Daemon config validation failed with ${issues.length} issue(s).`,
      issues,
      configFile: options.configFile ?? null,
    });
  }

  return config;
};

export const formatDaemonConfigIssues = (
  issues: readonly DaemonConfigIssue[]
): string =>
  issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");

export const formatDaemonConfigError = (error: unknown): string => {
  if (isDaemonConfigErrorLike(error)) {
    if (error.issues.length === 0) {
      return error.message;
    }
    return `${error.message}\n${formatDaemonConfigIssues(error.issues)}`;
  }
  return isErrorWithMessage(error) ? error.message : String(error);
};

export const getDaemonSourceBindings = (
  config: DaemonConfig,
  source: DaemonConfigRouteSource | null = null
): readonly DaemonSourceBinding[] =>
  source
    ? config.sources.bindings.filter((binding) => binding.source === source)
    : config.sources.bindings;

export const findDaemonSourceBinding = (
  config: DaemonConfig,
  id: string
): DaemonSourceBinding | null =>
  config.sources.bindings.find((binding) => binding.id === id) ?? null;

export const resolveDaemonConfigFilePath = (
  configFile: string | null | undefined = DEFAULT_CONFIG_FILE
): string => {
  const normalized = normalizeNonEmptyString(configFile);
  return normalized ? expandHomePath(normalized) : DEFAULT_CONFIG_FILE;
};

export const readDaemonConfig = async (
  configFile: string | null | undefined = DEFAULT_CONFIG_FILE
): Promise<ReadDaemonConfigResult> => {
  const configFilePath = resolveDaemonConfigFilePath(configFile);
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => readFile(configFilePath, "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap((raw) =>
        Effect.try({
          try: () =>
            canonicalizeDaemonConfig(parseJsonc(raw), {
              configFile: configFilePath,
            }),
          catch: (cause) => cause,
        })
      ),
      Effect.map((config) => ({
        configFile: configFilePath,
        config,
      }))
    )
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (isDaemonConfigErrorLike(error)) {
    throw new DaemonConfigError(error);
  }
  if (isErrnoCause(error) && error.code === "ENOENT") {
    throw new DaemonConfigError({
      code: "DAEMON_CONFIG_PARSE_ERROR",
      message: `Daemon config file not found: ${configFilePath}`,
      issues: [],
      configFile: configFilePath,
    });
  }
  throw new DaemonConfigError({
    code: "DAEMON_CONFIG_PARSE_ERROR",
    message: `Daemon config is not valid JSONC: ${configFilePath}`,
    issues: [],
    configFile: configFilePath,
  });
};

export const explainDaemonRouteResolution = (
  config: DaemonConfig,
  input: DaemonRouteResolutionInput
): DaemonRouteResolutionResult => {
  const normalizedInput = {
    path: normalizeOptionalPath(input.path ?? null),
    repoRoot: normalizeOptionalPath(input.repoRoot ?? null),
    workspaceRoot: normalizeOptionalPath(input.workspaceRoot ?? null),
    source: input.source ?? null,
  };

  const candidates = config.routes
    .map((route, index): DaemonRouteResolutionCandidate | null => {
      const matchReasons: string[] = [];
      if (route.match.source) {
        if (normalizedInput.source !== route.match.source) {
          return null;
        }
        matchReasons.push(`source=${route.match.source}`);
      }
      if (route.match.repoRoot) {
        if (normalizedInput.repoRoot !== route.match.repoRoot) {
          return null;
        }
        matchReasons.push(`repoRoot=${route.match.repoRoot}`);
      }
      if (route.match.workspaceRoot) {
        if (normalizedInput.workspaceRoot !== route.match.workspaceRoot) {
          return null;
        }
        matchReasons.push(`workspaceRoot=${route.match.workspaceRoot}`);
      }
      if (route.match.pathPrefix) {
        if (
          !normalizedInput.path ||
          !pathStartsWithPrefix(normalizedInput.path, route.match.pathPrefix)
        ) {
          return null;
        }
        matchReasons.push(`pathPrefix=${route.match.pathPrefix}`);
      }
      return {
        index,
        memory: route.memory,
        priority: route.priority,
        specificity: routeMatchSpecificity(route.match),
        pathPrefixLength: route.match.pathPrefix?.length ?? 0,
        matchReasons,
        route,
      };
    })
    .filter(
      (candidate): candidate is DaemonRouteResolutionCandidate =>
        candidate !== null
    )
    .sort((left, right) => {
      const priorityDiff = right.priority - left.priority;
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const specificityDiff = left.specificity - right.specificity;
      if (specificityDiff !== 0) {
        return specificityDiff;
      }
      const pathPrefixLengthDiff =
        right.pathPrefixLength - left.pathPrefixLength;
      if (pathPrefixLengthDiff !== 0) {
        return pathPrefixLengthDiff;
      }
      return routeSortKey(left.route).localeCompare(routeSortKey(right.route));
    });

  const selected = candidates[0] ?? null;
  if (selected) {
    return {
      status: "matched",
      memory: selected.memory,
      routeIndex: selected.index,
      candidates,
      normalizedInput,
    };
  }

  if (config.defaults.onAmbiguous === "default") {
    return {
      status: "default",
      memory: config.defaults.memory,
      routeIndex: null,
      candidates,
      normalizedInput,
    };
  }

  return {
    status: config.defaults.onAmbiguous,
    memory: null,
    routeIndex: null,
    candidates,
    normalizedInput,
  };
};

export const serializeDaemonConfig = (config: DaemonConfig): string =>
  `${JSON.stringify(config, null, 2)}\n`;

export const writeDaemonConfig = async (
  configFile: string | null | undefined,
  raw: unknown
): Promise<ReadDaemonConfigResult> => {
  const configFilePath = resolveDaemonConfigFilePath(configFile);
  const config = canonicalizeDaemonConfig(raw, { configFile: configFilePath });
  const tempFilePath = `${configFilePath}.${process.pid}.${Date.now()}.tmp`;
  const writeExit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => mkdir(dirname(configFilePath), { recursive: true }),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap(() =>
        Effect.succeed(tempFilePath).pipe(
          Effect.tap((path) =>
            Effect.tryPromise({
              try: () => writeFile(path, serializeDaemonConfig(config), "utf8"),
              catch: (cause) => cause,
            })
          ),
          Effect.flatMap((path) =>
            Effect.tryPromise({
              try: () => rename(path, configFilePath),
              catch: (cause) => cause,
            })
          ),
          Effect.ensuring(
            Effect.ignore(
              Effect.tryPromise({
                try: () => rm(tempFilePath, { force: true }),
                catch: (cause) => cause,
              })
            )
          )
        )
      )
    )
  );
  if (Exit.isFailure(writeExit)) {
    throw Cause.squash(writeExit.cause);
  }
  return {
    configFile: configFilePath,
    config,
  };
};
