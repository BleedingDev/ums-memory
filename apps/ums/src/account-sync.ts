import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_ACCOUNT_SESSION_FILE =
  process.env["UMS_ACCOUNT_SESSION_FILE"] ??
  resolve(homedir(), ".ums", "account-session.json");
const DEFAULT_SYNC_INTERVAL_MS = parsePositiveInteger(
  process.env["UMS_SYNC_INTERVAL_MS"],
  60_000
);
const DEFAULT_SYNC_MAX_EVENTS = parsePositiveInteger(
  process.env["UMS_SYNC_MAX_EVENTS"],
  400
);
const DEFAULT_PROFILE = "__store_default__";
const DEFAULT_STORE_ID = "coding-agent";
const MAX_EVENT_CONTENT_LENGTH = 3_000;
const MAX_TEXT_SEGMENTS = 8;
const MAX_JSONL_FILES_PER_SOURCE = 2_000;
const REMOTE_REQUEST_TIMEOUT_MS = 12_000;
const SOURCE_NAME_SET = new Set(["codex", "claude", "plan"]);
const DEFAULT_ENABLED_SOURCES = ["codex", "claude", "plan"] as const;
const TEXT_KEY_HINT =
  /(content|text|message|prompt|response|summary|note|query|analysis|output|title|body)/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passphrase|authorization)\b\s*[:=]\s*["']?[^\s"',]{6,}/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const COMMON_SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g;

export type SyncSourceName = "codex" | "claude" | "plan";

interface SourceCursorRecord {
  cursor: number;
  digest: string | null;
  updatedAt: string;
}

interface AccountLoginRecord {
  apiBaseUrl: string;
  token: string;
  tokenFingerprint: string;
  accountId: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}

interface AccountConnectionRecord {
  storeId: string;
  profile: string;
  enabledSources: SyncSourceName[];
  autoStartDaemon: boolean;
  connectedAt: string;
  updatedAt: string;
}

interface AccountSyncRecord {
  intervalMs: number;
  maxEventsPerCycle: number;
  sourceCursors: Record<string, SourceCursorRecord>;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  daemonPid: number | null;
  daemonStartedAt: string | null;
}

interface AccountSessionRecord {
  schemaVersion: 1;
  updatedAt: string;
  login: AccountLoginRecord | null;
  connection: AccountConnectionRecord | null;
  sync: AccountSyncRecord;
}

interface PublicLoginRecord {
  apiBaseUrl: string;
  tokenFingerprint: string;
  accountId: string | null;
  userId: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

interface PublicConnectionRecord {
  storeId: string;
  profile: string;
  enabledSources: SyncSourceName[];
  autoStartDaemon: boolean;
  updatedAt: string;
}

interface PublicSyncRecord {
  intervalMs: number;
  maxEventsPerCycle: number;
  trackedSourceFiles: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  daemonPid: number | null;
  daemonStartedAt: string | null;
}

export interface AccountSessionPublicView {
  accountFile: string;
  updatedAt: string;
  login: PublicLoginRecord | null;
  connection: PublicConnectionRecord | null;
  sync: PublicSyncRecord;
}

export interface LoginAccountInput {
  accountFile?: string | null;
  apiBaseUrl: string;
  token: string;
  accountId?: string | null;
  userId?: string | null;
  verify?: boolean;
  verifyStoreId?: string | null;
}

export interface ConnectAccountInput {
  accountFile?: string | null;
  storeId: string;
  profile?: string | null;
  enabledSources?: readonly SyncSourceName[] | null;
  intervalMs?: number | null;
  maxEventsPerCycle?: number | null;
  autoStartDaemon?: boolean | null;
}

interface IngestEvent {
  id: string;
  type: "note";
  source: string;
  content: string;
}

interface SourceCollectionResult {
  events: IngestEvent[];
  cursorUpdates: Record<string, SourceCursorRecord>;
  sourceStats: Array<{
    source: SyncSourceName;
    filesScanned: number;
    linesScanned: number;
    eventsPrepared: number;
  }>;
}

export interface SyncCycleSummary {
  operation: "sync";
  accountFile: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  apiBaseUrl: string;
  storeId: string;
  profile: string;
  preparedEvents: number;
  postedChunks: number;
  accepted: number;
  duplicates: number;
  sourceStats: Array<{
    source: SyncSourceName;
    filesScanned: number;
    linesScanned: number;
    eventsPrepared: number;
  }>;
}

export interface RunSyncDaemonOptions {
  accountFile?: string | null;
  intervalMs?: number | null;
  maxCycles?: number | null;
  onCycle?: (result: SyncCycleSummary | null, error: Error | null) => void;
}

type JsonRecord = Record<string, unknown>;

function parsePositiveInteger(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withCode(error: Error, code: string): Error & { code: string } {
  return Object.assign(error, { code });
}

function ignoreCleanupError(_error: unknown): void {
  void _error;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEnabledSources(
  value: readonly SyncSourceName[] | null | undefined
): SyncSourceName[] {
  const resolved =
    value && value.length > 0 ? [...value] : [...DEFAULT_ENABLED_SOURCES];
  const deduped = new Set<SyncSourceName>();
  for (const source of resolved) {
    if (!SOURCE_NAME_SET.has(source)) {
      throw withCode(
        new Error(`Unsupported source '${String(source)}'.`),
        "SYNC_SOURCE_UNSUPPORTED"
      );
    }
    deduped.add(source);
  }
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function createEmptySession(): AccountSessionRecord {
  return {
    schemaVersion: 1,
    updatedAt: toIsoNow(),
    login: null,
    connection: null,
    sync: {
      intervalMs: DEFAULT_SYNC_INTERVAL_MS,
      maxEventsPerCycle: DEFAULT_SYNC_MAX_EVENTS,
      sourceCursors: {},
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      daemonPid: null,
      daemonStartedAt: null,
    },
  };
}

function normalizeSourceCursorRecord(value: unknown): SourceCursorRecord {
  const record = isJsonRecord(value) ? value : {};
  const cursorRaw = Number.parseInt(String(record["cursor"] ?? ""), 10);
  return {
    cursor: Number.isFinite(cursorRaw) && cursorRaw >= 0 ? cursorRaw : 0,
    digest: asNonEmptyString(record["digest"]),
    updatedAt: asNonEmptyString(record["updatedAt"]) ?? toIsoNow(),
  };
}

function normalizeSession(raw: unknown): AccountSessionRecord {
  if (!isJsonRecord(raw)) {
    return createEmptySession();
  }

  const session = createEmptySession();
  const login = isJsonRecord(raw["login"]) ? raw["login"] : null;
  if (login) {
    const apiBaseUrl = asNonEmptyString(login["apiBaseUrl"]);
    const token = asNonEmptyString(login["token"]);
    if (apiBaseUrl && token) {
      const updatedAt = asNonEmptyString(login["updatedAt"]) ?? toIsoNow();
      session.login = {
        apiBaseUrl,
        token,
        tokenFingerprint:
          asNonEmptyString(login["tokenFingerprint"]) ??
          hashValue(token).slice(0, 12),
        accountId: asNonEmptyString(login["accountId"]),
        userId: asNonEmptyString(login["userId"]),
        createdAt: asNonEmptyString(login["createdAt"]) ?? updatedAt,
        updatedAt,
        verifiedAt: asNonEmptyString(login["verifiedAt"]),
      };
    }
  }

  const connection = isJsonRecord(raw["connection"]) ? raw["connection"] : null;
  if (connection) {
    const storeId = asNonEmptyString(connection["storeId"]);
    if (storeId) {
      const profile =
        asNonEmptyString(connection["profile"]) ?? DEFAULT_PROFILE;
      const enabledSourcesRaw = Array.isArray(connection["enabledSources"])
        ? (connection["enabledSources"] as unknown[])
            .map((entry) => asNonEmptyString(entry))
            .filter((entry): entry is SyncSourceName =>
              Boolean(entry && SOURCE_NAME_SET.has(entry))
            )
        : [...DEFAULT_ENABLED_SOURCES];
      const enabledSources =
        enabledSourcesRaw.length > 0
          ? normalizeEnabledSources(enabledSourcesRaw)
          : [...DEFAULT_ENABLED_SOURCES];
      const updatedAt =
        asNonEmptyString(connection["updatedAt"]) ??
        asNonEmptyString(connection["connectedAt"]) ??
        toIsoNow();
      session.connection = {
        storeId,
        profile,
        enabledSources,
        autoStartDaemon:
          typeof connection["autoStartDaemon"] === "boolean"
            ? connection["autoStartDaemon"]
            : true,
        connectedAt:
          asNonEmptyString(connection["connectedAt"]) ??
          asNonEmptyString(connection["updatedAt"]) ??
          updatedAt,
        updatedAt,
      };
    }
  }

  const sync = isJsonRecord(raw["sync"]) ? raw["sync"] : {};
  session.sync.intervalMs = parsePositiveInteger(
    sync["intervalMs"],
    DEFAULT_SYNC_INTERVAL_MS
  );
  session.sync.maxEventsPerCycle = parsePositiveInteger(
    sync["maxEventsPerCycle"],
    DEFAULT_SYNC_MAX_EVENTS
  );
  session.sync.lastRunAt = asNonEmptyString(sync["lastRunAt"]);
  session.sync.lastSuccessAt = asNonEmptyString(sync["lastSuccessAt"]);
  session.sync.lastError = asNonEmptyString(sync["lastError"]);
  const daemonPid = Number.parseInt(String(sync["daemonPid"] ?? ""), 10);
  session.sync.daemonPid =
    Number.isFinite(daemonPid) && daemonPid > 0 ? daemonPid : null;
  session.sync.daemonStartedAt = asNonEmptyString(sync["daemonStartedAt"]);

  if (isJsonRecord(sync["sourceCursors"])) {
    const sourceCursors = sync["sourceCursors"] as JsonRecord;
    const normalized: Record<string, SourceCursorRecord> = {};
    for (const key of Object.keys(sourceCursors).sort((left, right) =>
      left.localeCompare(right)
    )) {
      normalized[key] = normalizeSourceCursorRecord(sourceCursors[key]);
    }
    session.sync.sourceCursors = normalized;
  }

  session.updatedAt = asNonEmptyString(raw["updatedAt"]) ?? toIsoNow();
  return session;
}

function sanitizeApiBaseUrl(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw withCode(
      new Error("apiBaseUrl must be a non-empty string."),
      "LOGIN_CONTRACT_VIOLATION"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw withCode(
      new Error(
        `apiBaseUrl must be a valid absolute URL: ${
          error instanceof Error ? error.message : String(error)
        }`
      ),
      "LOGIN_CONTRACT_VIOLATION"
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw withCode(
      new Error("apiBaseUrl must use http or https protocol."),
      "LOGIN_CONTRACT_VIOLATION"
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function resolveCursorUpdatedAt(value: string | null): string {
  return value ?? toIsoNow();
}

function toPublicView(
  accountFile: string,
  session: AccountSessionRecord
): AccountSessionPublicView {
  return {
    accountFile,
    updatedAt: session.updatedAt,
    login: session.login
      ? {
          apiBaseUrl: session.login.apiBaseUrl,
          tokenFingerprint: session.login.tokenFingerprint,
          accountId: session.login.accountId,
          userId: session.login.userId,
          verifiedAt: session.login.verifiedAt,
          updatedAt: session.login.updatedAt,
        }
      : null,
    connection: session.connection
      ? {
          storeId: session.connection.storeId,
          profile: session.connection.profile,
          enabledSources: [...session.connection.enabledSources],
          autoStartDaemon: session.connection.autoStartDaemon,
          updatedAt: session.connection.updatedAt,
        }
      : null,
    sync: {
      intervalMs: session.sync.intervalMs,
      maxEventsPerCycle: session.sync.maxEventsPerCycle,
      trackedSourceFiles: Object.keys(session.sync.sourceCursors).length,
      lastRunAt: session.sync.lastRunAt,
      lastSuccessAt: session.sync.lastSuccessAt,
      lastError: session.sync.lastError,
      daemonPid: session.sync.daemonPid,
      daemonStartedAt: session.sync.daemonStartedAt,
    },
  };
}

export function resolveAccountSessionFilePath(
  accountFile: string | null | undefined = DEFAULT_ACCOUNT_SESSION_FILE
): string {
  const normalized = asNonEmptyString(accountFile);
  if (!normalized) {
    return resolve(DEFAULT_ACCOUNT_SESSION_FILE);
  }
  return resolve(normalized);
}

async function writeSessionFile(
  sessionFilePath: string,
  session: AccountSessionRecord
): Promise<void> {
  await mkdir(dirname(sessionFilePath), { recursive: true });
  const tempFilePath = `${sessionFilePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(session, null, 2)}\n`;
  try {
    await writeFile(tempFilePath, payload, "utf8");
    await rename(tempFilePath, sessionFilePath);
  } finally {
    await rm(tempFilePath, { force: true }).catch(ignoreCleanupError);
  }
}

export async function readAccountSession(
  accountFile: string | null | undefined = DEFAULT_ACCOUNT_SESSION_FILE
): Promise<{ accountFile: string; session: AccountSessionRecord }> {
  const accountFilePath = resolveAccountSessionFilePath(accountFile);
  try {
    const raw = await readFile(accountFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return {
      accountFile: accountFilePath,
      session: normalizeSession(parsed),
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return {
        accountFile: accountFilePath,
        session: createEmptySession(),
      };
    }
    if (error instanceof SyntaxError) {
      throw withCode(
        new Error(`Account session file is not valid JSON: ${accountFilePath}`),
        "ACCOUNT_SESSION_CORRUPT"
      );
    }
    throw error;
  }
}

export async function getAccountSessionPublicView(
  accountFile: string | null | undefined = DEFAULT_ACCOUNT_SESSION_FILE
): Promise<AccountSessionPublicView> {
  const { accountFile: accountFilePath, session } =
    await readAccountSession(accountFile);
  return toPublicView(accountFilePath, session);
}

async function verifyRemoteAccess({
  apiBaseUrl,
  token,
  storeId,
}: {
  apiBaseUrl: string;
  token: string;
  storeId: string;
}): Promise<void> {
  const endpoint = new URL("/v1/doctor", apiBaseUrl);
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, REMOTE_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-ums-api-key": token,
        "x-ums-store": storeId,
      },
      body: JSON.stringify({}),
      signal: abortController.signal,
    });
    if (response.ok) {
      return;
    }
    const body = await response.text();
    throw withCode(
      new Error(
        `Remote verification failed (${response.status} ${response.statusText}): ${body.slice(0, 240)}`
      ),
      "ACCOUNT_VERIFY_FAILED"
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "name" in error &&
      error.name === "AbortError"
    ) {
      throw withCode(
        new Error(
          `Remote verification timed out after ${REMOTE_REQUEST_TIMEOUT_MS}ms.`
        ),
        "ACCOUNT_VERIFY_TIMEOUT"
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loginAccount(
  input: LoginAccountInput
): Promise<AccountSessionPublicView> {
  const apiBaseUrl = sanitizeApiBaseUrl(input.apiBaseUrl);
  const token = asNonEmptyString(input.token);
  if (!token) {
    throw withCode(
      new Error("token must be provided for login."),
      "LOGIN_CONTRACT_VIOLATION"
    );
  }

  const accountId = asNonEmptyString(input.accountId);
  const userId = asNonEmptyString(input.userId);
  const verify = input.verify ?? true;
  const verifyStoreId =
    asNonEmptyString(input.verifyStoreId) ?? DEFAULT_STORE_ID;

  if (verify) {
    await verifyRemoteAccess({ apiBaseUrl, token, storeId: verifyStoreId });
  }

  const { accountFile, session } = await readAccountSession(input.accountFile);
  const now = toIsoNow();
  const createdAt = session.login?.createdAt ?? now;
  session.login = {
    apiBaseUrl,
    token,
    tokenFingerprint: hashValue(token).slice(0, 12),
    accountId,
    userId,
    createdAt,
    updatedAt: now,
    verifiedAt: verify ? now : null,
  };
  session.updatedAt = now;
  await writeSessionFile(accountFile, session);
  return toPublicView(accountFile, session);
}

export async function connectAccount(
  input: ConnectAccountInput
): Promise<AccountSessionPublicView> {
  const storeId = asNonEmptyString(input.storeId);
  if (!storeId) {
    throw withCode(
      new Error("storeId is required for connect."),
      "CONNECT_CONTRACT_VIOLATION"
    );
  }

  const { accountFile, session } = await readAccountSession(input.accountFile);
  if (!session.login) {
    throw withCode(
      new Error(
        "No account login found. Run `ums login --api-url <url> --token <token>` first."
      ),
      "ACCOUNT_NOT_LOGGED_IN"
    );
  }

  const profile = asNonEmptyString(input.profile) ?? DEFAULT_PROFILE;
  const enabledSources = normalizeEnabledSources(input.enabledSources ?? null);
  const intervalMs = parsePositiveInteger(
    input.intervalMs,
    session.sync.intervalMs
  );
  const maxEventsPerCycle = parsePositiveInteger(
    input.maxEventsPerCycle,
    session.sync.maxEventsPerCycle
  );
  const autoStartDaemon =
    typeof input.autoStartDaemon === "boolean"
      ? input.autoStartDaemon
      : (session.connection?.autoStartDaemon ?? true);

  const now = toIsoNow();
  session.connection = {
    storeId,
    profile,
    enabledSources,
    autoStartDaemon,
    connectedAt: session.connection?.connectedAt ?? now,
    updatedAt: now,
  };
  session.sync.intervalMs = intervalMs;
  session.sync.maxEventsPerCycle = maxEventsPerCycle;
  session.sync.lastError = null;
  session.updatedAt = now;
  await writeSessionFile(accountFile, session);
  return toPublicView(accountFile, session);
}

export async function updateDaemonStatus({
  accountFile,
  daemonPid,
  daemonStartedAt,
}: {
  accountFile?: string | null;
  daemonPid: number | null;
  daemonStartedAt?: string | null;
}): Promise<AccountSessionPublicView> {
  const { accountFile: accountFilePath, session } =
    await readAccountSession(accountFile);
  const now = toIsoNow();
  session.sync.daemonPid = daemonPid;
  session.sync.daemonStartedAt =
    daemonPid === null
      ? null
      : (asNonEmptyString(daemonStartedAt) ??
        session.sync.daemonStartedAt ??
        now);
  session.updatedAt = now;
  await writeSessionFile(accountFilePath, session);
  return toPublicView(accountFilePath, session);
}

export function parseSyncSources(raw: string): SyncSourceName[] {
  const allTokens = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const invalid = allTokens.filter(
    (entry) => !SOURCE_NAME_SET.has(entry as SyncSourceName)
  );
  if (invalid.length > 0) {
    throw withCode(
      new Error(`Unsupported sync source(s): ${invalid.join(", ")}`),
      "SYNC_SOURCE_UNSUPPORTED"
    );
  }
  const tokens = allTokens as SyncSourceName[];
  return normalizeEnabledSources(tokens);
}

function sourceRootsFor(source: SyncSourceName): string[] {
  if (source === "codex") {
    return [
      resolve(homedir(), ".codex", "archived_sessions"),
      resolve(homedir(), ".codex", "sessions"),
      resolve(homedir(), ".codex"),
    ];
  }
  if (source === "claude") {
    return [
      resolve(homedir(), ".claude", "transcripts"),
      resolve(homedir(), ".claude", "projects"),
    ];
  }
  return [];
}

async function listJsonlFiles(rootPath: string): Promise<string[]> {
  const discovered: string[] = [];
  const stack = [rootPath];
  while (stack.length > 0 && discovered.length < MAX_JSONL_FILES_PER_SOURCE) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (
        isErrnoException(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        continue;
      }
      throw error;
    }
    const sorted = [...entries].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of sorted) {
      const absolutePath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        discovered.push(absolutePath);
      }
      if (discovered.length >= MAX_JSONL_FILES_PER_SOURCE) {
        break;
      }
    }
  }
  return discovered.sort((left, right) => left.localeCompare(right));
}

function stripControlChars(value: string): string {
  let normalized = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) {
      normalized += " ";
      continue;
    }
    normalized += char;
  }
  return normalized;
}

function sanitizeKnowledgeContent(value: string): string {
  const collapsed = stripControlChars(value)
    .replace(SECRET_ASSIGNMENT_PATTERN, "[REDACTED_SECRET]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED_SECRET]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(COMMON_SECRET_TOKEN_PATTERN, "[REDACTED_SECRET]")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) {
    return "";
  }
  if (collapsed.length > MAX_EVENT_CONTENT_LENGTH) {
    return collapsed.slice(0, MAX_EVENT_CONTENT_LENGTH);
  }
  return collapsed;
}

function collectInterestingText(
  value: unknown,
  target: string[],
  depth = 0,
  keyHint = ""
): void {
  if (target.length >= MAX_TEXT_SEGMENTS || depth > 5) {
    return;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    if (keyHint && !TEXT_KEY_HINT.test(keyHint) && depth > 1) {
      return;
    }
    target.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) {
      collectInterestingText(entry, target, depth + 1, keyHint);
      if (target.length >= MAX_TEXT_SEGMENTS) {
        return;
      }
    }
    return;
  }
  if (!isJsonRecord(value)) {
    return;
  }
  for (const key of Object.keys(value).sort((left, right) =>
    left.localeCompare(right)
  )) {
    collectInterestingText(value[key], target, depth + 1, key);
    if (target.length >= MAX_TEXT_SEGMENTS) {
      return;
    }
  }
}

function extractKnowledgeTextFromJsonLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  const collected: string[] = [];
  collectInterestingText(parsed, collected);
  if (collected.length === 0) {
    return line;
  }
  return collected.join(" | ");
}

function buildIngestEvent({
  source,
  filePath,
  lineIndex,
  content,
}: {
  source: SyncSourceName;
  filePath: string;
  lineIndex: number;
  content: string;
}): IngestEvent {
  const sourceName =
    source === "codex"
      ? "codex-cli"
      : source === "claude"
        ? "claude-code"
        : "plan";
  const eventId = `evt_${hashValue(
    `${source}|${filePath}|${lineIndex}|${content}`
  ).slice(0, 24)}`;
  return {
    id: eventId,
    type: "note",
    source: sourceName,
    content,
  };
}

async function tailJsonlFile({
  source,
  filePath,
  startCursor,
  maxEvents,
}: {
  source: SyncSourceName;
  filePath: string;
  startCursor: number;
  maxEvents: number;
}): Promise<{
  events: IngestEvent[];
  nextCursor: number;
  scannedLines: number;
}> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { events: [], nextCursor: 0, scannedLines: 0 };
    }
    throw error;
  }
  const lines = raw.split(/\r?\n/);
  const safeCursor =
    Number.isFinite(startCursor) &&
    startCursor >= 0 &&
    startCursor <= lines.length
      ? startCursor
      : 0;
  const events: IngestEvent[] = [];
  let scannedLines = 0;

  for (let lineIndex = safeCursor; lineIndex < lines.length; lineIndex += 1) {
    if (events.length >= maxEvents) {
      return {
        events,
        nextCursor: lineIndex,
        scannedLines,
      };
    }
    scannedLines += 1;
    const rawLine = lines[lineIndex]?.trim() ?? "";
    if (!rawLine) {
      continue;
    }
    const extracted = extractKnowledgeTextFromJsonLine(rawLine);
    const sanitized = sanitizeKnowledgeContent(extracted);
    if (!sanitized) {
      continue;
    }
    const content = sanitizeKnowledgeContent(
      `${basename(filePath)}:${lineIndex + 1} ${sanitized}`
    );
    if (!content) {
      continue;
    }
    events.push(
      buildIngestEvent({
        source,
        filePath,
        lineIndex,
        content,
      })
    );
  }

  return {
    events,
    nextCursor: lines.length,
    scannedLines,
  };
}

async function collectPlanEvent({
  planPath,
  cursor,
}: {
  planPath: string;
  cursor: SourceCursorRecord | undefined;
}): Promise<{
  events: IngestEvent[];
  cursorUpdate: SourceCursorRecord | null;
  scannedLines: number;
}> {
  try {
    await access(planPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { events: [], cursorUpdate: null, scannedLines: 0 };
    }
    throw error;
  }
  const raw = await readFile(planPath, "utf8");
  const sanitized = sanitizeKnowledgeContent(raw);
  if (!sanitized) {
    return {
      events: [],
      cursorUpdate: {
        cursor: 0,
        digest: hashValue(raw),
        updatedAt: toIsoNow(),
      },
      scannedLines: 0,
    };
  }

  const digest = hashValue(sanitized);
  if (cursor?.digest === digest) {
    return {
      events: [],
      cursorUpdate: {
        cursor: 0,
        digest,
        updatedAt: resolveCursorUpdatedAt(cursor.updatedAt),
      },
      scannedLines: raw.split(/\r?\n/).length,
    };
  }

  const content = sanitizeKnowledgeContent(
    `PLAN.md snapshot ${sanitized.slice(0, MAX_EVENT_CONTENT_LENGTH)}`
  );
  if (!content) {
    return { events: [], cursorUpdate: null, scannedLines: 0 };
  }
  return {
    events: [
      buildIngestEvent({
        source: "plan",
        filePath: planPath,
        lineIndex: 0,
        content,
      }),
    ],
    cursorUpdate: {
      cursor: 0,
      digest,
      updatedAt: toIsoNow(),
    },
    scannedLines: raw.split(/\r?\n/).length,
  };
}

function chunkEvents<T>(items: readonly T[], chunkSize = 100): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function sumStats(
  sourceStats: SourceCollectionResult["sourceStats"],
  source: SyncSourceName,
  patch: {
    filesScanned?: number;
    linesScanned?: number;
    eventsPrepared?: number;
  }
): void {
  const existing = sourceStats.find((entry) => entry.source === source);
  if (!existing) {
    sourceStats.push({
      source,
      filesScanned: patch.filesScanned ?? 0,
      linesScanned: patch.linesScanned ?? 0,
      eventsPrepared: patch.eventsPrepared ?? 0,
    });
    return;
  }
  existing.filesScanned += patch.filesScanned ?? 0;
  existing.linesScanned += patch.linesScanned ?? 0;
  existing.eventsPrepared += patch.eventsPrepared ?? 0;
}

async function collectSourceEvents({
  session,
}: {
  session: AccountSessionRecord;
}): Promise<SourceCollectionResult> {
  const connection = session.connection;
  if (!connection) {
    return {
      events: [],
      cursorUpdates: {},
      sourceStats: [],
    };
  }

  const maxEventsPerCycle = session.sync.maxEventsPerCycle;
  const events: IngestEvent[] = [];
  const cursorUpdates: Record<string, SourceCursorRecord> = {};
  const sourceStats: SourceCollectionResult["sourceStats"] = [];
  const now = toIsoNow();

  for (const source of connection.enabledSources) {
    if (events.length >= maxEventsPerCycle) {
      break;
    }
    if (source === "plan") {
      const planPath = resolve(process.cwd(), "PLAN.md");
      const cursor = session.sync.sourceCursors[planPath];
      const plan = await collectPlanEvent({ planPath, cursor });
      sumStats(sourceStats, source, {
        filesScanned: 1,
        linesScanned: plan.scannedLines,
        eventsPrepared: plan.events.length,
      });
      if (plan.cursorUpdate) {
        cursorUpdates[planPath] = {
          ...plan.cursorUpdate,
          updatedAt: now,
        };
      }
      events.push(
        ...plan.events.slice(0, Math.max(0, maxEventsPerCycle - events.length))
      );
      continue;
    }

    const roots = sourceRootsFor(source);
    const discoveredFiles = new Set<string>();
    for (const root of roots) {
      const files = await listJsonlFiles(root);
      for (const filePath of files) {
        discoveredFiles.add(filePath);
      }
    }
    const filePaths = [...discoveredFiles].sort((left, right) =>
      left.localeCompare(right)
    );
    for (const filePath of filePaths) {
      if (events.length >= maxEventsPerCycle) {
        break;
      }
      const cursor = session.sync.sourceCursors[filePath];
      const remaining = Math.max(0, maxEventsPerCycle - events.length);
      const tail = await tailJsonlFile({
        source,
        filePath,
        startCursor: cursor?.cursor ?? 0,
        maxEvents: remaining,
      });
      sumStats(sourceStats, source, {
        filesScanned: 1,
        linesScanned: tail.scannedLines,
        eventsPrepared: tail.events.length,
      });
      cursorUpdates[filePath] = {
        cursor: tail.nextCursor,
        digest: null,
        updatedAt: now,
      };
      events.push(...tail.events);
    }
  }

  return {
    events,
    cursorUpdates,
    sourceStats: sourceStats.sort((left, right) =>
      left.source.localeCompare(right.source)
    ),
  };
}

async function postIngestionChunk({
  apiBaseUrl,
  token,
  storeId,
  profile,
  events,
}: {
  apiBaseUrl: string;
  token: string;
  storeId: string;
  profile: string;
  events: IngestEvent[];
}): Promise<{ accepted: number; duplicates: number }> {
  const endpoint = new URL("/v1/ingest", apiBaseUrl);
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, REMOTE_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-ums-api-key": token,
        "x-ums-store": storeId,
      },
      body: JSON.stringify({
        storeId,
        profile,
        events,
      }),
      signal: abortController.signal,
    });

    const bodyText = await response.text();
    let bodyJson: unknown = null;
    if (bodyText.trim()) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = null;
      }
    }

    if (!response.ok) {
      throw withCode(
        new Error(
          `Remote ingestion failed (${response.status} ${response.statusText}): ${bodyText.slice(0, 240)}`
        ),
        "REMOTE_INGEST_FAILED"
      );
    }

    if (!isJsonRecord(bodyJson) || bodyJson["ok"] !== true) {
      throw withCode(
        new Error(
          `Remote ingestion returned invalid response: ${bodyText.slice(0, 240)}`
        ),
        "REMOTE_INGEST_RESPONSE_INVALID"
      );
    }
    const data = isJsonRecord(bodyJson["data"]) ? bodyJson["data"] : {};
    const acceptedRaw = Number.parseInt(String(data["accepted"] ?? ""), 10);
    const duplicatesRaw = Number.parseInt(String(data["duplicates"] ?? ""), 10);
    return {
      accepted:
        Number.isFinite(acceptedRaw) && acceptedRaw >= 0
          ? acceptedRaw
          : events.length,
      duplicates:
        Number.isFinite(duplicatesRaw) && duplicatesRaw >= 0
          ? duplicatesRaw
          : 0,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "name" in error &&
      error.name === "AbortError"
    ) {
      throw withCode(
        new Error(
          `Remote ingestion timed out after ${REMOTE_REQUEST_TIMEOUT_MS}ms.`
        ),
        "REMOTE_INGEST_TIMEOUT"
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSyncCycle(
  accountFile: string | null | undefined = DEFAULT_ACCOUNT_SESSION_FILE
): Promise<SyncCycleSummary> {
  const startedAt = toIsoNow();
  const startedMs = Date.now();
  const { accountFile: accountFilePath, session } =
    await readAccountSession(accountFile);
  if (!session.login) {
    throw withCode(
      new Error(
        "No account login found. Run `ums login --api-url <url> --token <token>` first."
      ),
      "ACCOUNT_NOT_LOGGED_IN"
    );
  }
  if (!session.connection) {
    throw withCode(
      new Error(
        "No store connection found. Run `ums connect --store-id <store>` first."
      ),
      "ACCOUNT_NOT_CONNECTED"
    );
  }

  const { events, cursorUpdates, sourceStats } = await collectSourceEvents({
    session,
  });
  const chunks = chunkEvents(events, 100);
  let accepted = 0;
  let duplicates = 0;
  let postedChunks = 0;

  try {
    for (const chunk of chunks) {
      const posted = await postIngestionChunk({
        apiBaseUrl: session.login.apiBaseUrl,
        token: session.login.token,
        storeId: session.connection.storeId,
        profile: session.connection.profile,
        events: chunk,
      });
      accepted += posted.accepted;
      duplicates += posted.duplicates;
      postedChunks += 1;
    }
  } catch (error) {
    session.sync.lastRunAt = startedAt;
    session.sync.lastError =
      error instanceof Error ? error.message : String(error);
    session.updatedAt = toIsoNow();
    await writeSessionFile(accountFilePath, session);
    throw error;
  }

  session.sync.sourceCursors = {
    ...session.sync.sourceCursors,
    ...cursorUpdates,
  };
  session.sync.lastRunAt = startedAt;
  session.sync.lastSuccessAt = toIsoNow();
  session.sync.lastError = null;
  session.updatedAt = toIsoNow();
  await writeSessionFile(accountFilePath, session);

  return {
    operation: "sync",
    accountFile: accountFilePath,
    startedAt,
    completedAt: toIsoNow(),
    durationMs: Date.now() - startedMs,
    apiBaseUrl: session.login.apiBaseUrl,
    storeId: session.connection.storeId,
    profile: session.connection.profile,
    preparedEvents: events.length,
    postedChunks,
    accepted,
    duplicates,
    sourceStats,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function clearStaleDaemonPid(
  accountFile: string | null | undefined = DEFAULT_ACCOUNT_SESSION_FILE
): Promise<AccountSessionPublicView> {
  const { accountFile: accountFilePath, session } =
    await readAccountSession(accountFile);
  const daemonPid = session.sync.daemonPid;
  if (daemonPid && !isProcessAlive(daemonPid)) {
    session.sync.daemonPid = null;
    session.sync.daemonStartedAt = null;
    session.updatedAt = toIsoNow();
    await writeSessionFile(accountFilePath, session);
  }
  return toPublicView(accountFilePath, session);
}

export async function runSyncDaemon(
  options: RunSyncDaemonOptions = {}
): Promise<{ cycles: number; lastSummary: SyncCycleSummary | null }> {
  const accountFilePath = resolveAccountSessionFilePath(options.accountFile);
  const { session } = await readAccountSession(accountFilePath);
  const intervalMs = parsePositiveInteger(
    options.intervalMs,
    session.sync.intervalMs
  );
  const maxCycles =
    options.maxCycles && options.maxCycles > 0 ? options.maxCycles : null;

  let cycles = 0;
  let lastSummary: SyncCycleSummary | null = null;
  while (true) {
    if (maxCycles !== null && cycles >= maxCycles) {
      break;
    }
    try {
      const summary = await runSyncCycle(accountFilePath);
      lastSummary = summary;
      options.onCycle?.(summary, null);
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      options.onCycle?.(null, wrapped);
    }
    cycles += 1;
    if (maxCycles !== null && cycles >= maxCycles) {
      break;
    }
    await delay(intervalMs);
  }

  return { cycles, lastSummary };
}
