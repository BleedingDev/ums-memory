import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./console-ui.ts";
import {
  DEFAULT_RUNTIME_STATE_FILE,
  executeRuntimeOperation,
  listRuntimeOperations,
} from "./runtime-adapter.ts";
import {
  createInMemoryApiTelemetry,
  type BuildOperationTelemetryEventOptions,
  PROMETHEUS_CONTENT_TYPE,
} from "./telemetry.ts";

interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

interface ApiTelemetry {
  recordOperationResult(event: BuildOperationTelemetryEventOptions): void;
  renderPrometheusMetrics(): string;
}

interface RecordOperationTelemetryInput {
  statusCode: number;
  result: "success" | "failure";
  responseData?: unknown;
  requestBody?: unknown;
  failureCode?: string | null;
}

interface StartApiServerOptions {
  host?: string;
  port?: number;
  stateFile?: string | null;
  telemetry?: ApiTelemetry;
  enableConsoleUi?: boolean | string;
}

interface StartedApiServer {
  server: Server;
  host: string;
  port: number;
  telemetry: ApiTelemetry;
}

interface ConsoleRoute {
  body: string;
  contentType: string;
  methodError: string;
}

interface SupervisionSnapshot {
  phase: string;
  lastError?: string | null;
}

interface SupervisedApiService {
  status(): SupervisionSnapshot;
}

interface StartSupervisedApiServiceResult {
  service: SupervisedApiService;
  host: string;
  port: number;
}

const HOST = process.env["UMS_API_HOST"] ?? "127.0.0.1";
const PORT = Number.parseInt(process.env["UMS_API_PORT"] ?? "8787", 10);
const ENABLE_CONSOLE_UI = parseBooleanFlag(
  process.env["UMS_API_ENABLE_CONSOLE_UI"]
);
const API_PREFIX = "/v1";
const CONSOLE_SECURITY_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    "content-security-policy":
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  });
const CONSOLE_ROUTES: Readonly<Record<string, ConsoleRoute>> = Object.freeze({
  "/console": {
    body: CONSOLE_HTML,
    contentType: "text/html; charset=utf-8",
    methodError: "Only GET is supported for /console.",
  },
  "/console.js": {
    body: CONSOLE_JS,
    contentType: "text/javascript; charset=utf-8",
    methodError: "Only GET is supported for /console.js.",
  },
  "/console.css": {
    body: CONSOLE_CSS,
    contentType: "text/css; charset=utf-8",
    methodError: "Only GET is supported for /console.css.",
  },
});

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function normalizeConsoleUiToggle(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return parseBooleanFlag(value);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAddressInfo(
  address: string | AddressInfo | null
): address is AddressInfo {
  return (
    typeof address === "object" &&
    address !== null &&
    typeof address.port === "number"
  );
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error["name"] === "AbortError";
}

function hasErrorCode(
  error: unknown,
  code: string
): error is { code: string; message?: unknown } {
  return (
    isRecord(error) &&
    typeof error["code"] === "string" &&
    error["code"] === code
  );
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error["message"] === "string") {
    return error["message"];
  }
  return fallback;
}

function json(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  body: unknown,
  contentType: string = PROMETHEUS_CONTENT_TYPE,
  additionalHeaders?: Readonly<Record<string, string>>
): void {
  const payload = String(body ?? "");
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload),
    ...additionalHeaders,
  });
  res.end(payload);
}

function notFound(res: ServerResponse<IncomingMessage>): void {
  json(res, 404, {
    ok: false,
    error: { code: "NOT_FOUND", message: "Route not found." },
  });
}

function methodNotAllowed(
  res: ServerResponse<IncomingMessage>,
  message = "Only POST is supported for operation routes."
): void {
  json(res, 405, {
    ok: false,
    error: { code: "METHOD_NOT_ALLOWED", message },
  });
}

function parseOperation(pathname: string): string | null {
  if (!pathname.startsWith(`${API_PREFIX}/`)) {
    return null;
  }
  const operation = pathname
    .slice(`${API_PREFIX}/`.length)
    .trim()
    .toLowerCase();
  return operation || null;
}

function parseStoreHeader(req: IncomingMessage): string | null {
  const value = req.headers["x-ums-store"];
  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .find(Boolean);
    return normalized ?? null;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

function toErrorResponse(error: unknown): {
  statusCode: number;
  body: ApiErrorBody;
} {
  if (error instanceof SyntaxError) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: "INVALID_JSON",
          message: "Request body must be valid JSON.",
        },
      },
    };
  }
  if (hasErrorCode(error, "UNSUPPORTED_OPERATION")) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: "UNSUPPORTED_OPERATION",
          message: toErrorMessage(error, "Operation is not supported."),
        },
      },
    };
  }
  if (hasErrorCode(error, "STATE_LOCK_TIMEOUT")) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        error: {
          code: "STATE_LOCK_TIMEOUT",
          message: toErrorMessage(error, "State lock timed out."),
        },
      },
    };
  }
  if (hasErrorCode(error, "STATE_FILE_CORRUPT")) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: "STATE_FILE_CORRUPT",
          message: toErrorMessage(error, "State file is corrupt."),
        },
      },
    };
  }
  if (hasErrorCode(error, "RUNTIME_ADAPTER_LOAD_ERROR")) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: "RUNTIME_ADAPTER_LOAD_ERROR",
          message: toErrorMessage(error, "Runtime adapter load failed."),
        },
      },
    };
  }
  if (hasErrorCode(error, "RUNTIME_ADAPTER_CONTRACT_ERROR")) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: "RUNTIME_ADAPTER_CONTRACT_ERROR",
          message: toErrorMessage(
            error,
            "Runtime adapter contract is invalid."
          ),
        },
      },
    };
  }
  if (
    error instanceof Error &&
    error.message.startsWith("SERVICE_MISCONFIGURATION:")
  ) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: "SERVICE_MISCONFIGURATION",
          message: error.message,
        },
      },
    };
  }
  return {
    statusCode: 400,
    body: {
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: toErrorMessage(error, "Bad request."),
      },
    },
  };
}

function resolveTelemetry(telemetry: unknown): ApiTelemetry {
  if (
    isRecord(telemetry) &&
    typeof telemetry["recordOperationResult"] === "function" &&
    typeof telemetry["renderPrometheusMetrics"] === "function"
  ) {
    return {
      recordOperationResult: telemetry[
        "recordOperationResult"
      ] as ApiTelemetry["recordOperationResult"],
      renderPrometheusMetrics: telemetry[
        "renderPrometheusMetrics"
      ] as ApiTelemetry["renderPrometheusMetrics"],
    };
  }
  return createInMemoryApiTelemetry() as ApiTelemetry;
}

export function createApiServer({
  stateFile = DEFAULT_RUNTIME_STATE_FILE,
  telemetry = createInMemoryApiTelemetry() as ApiTelemetry,
  enableConsoleUi = ENABLE_CONSOLE_UI,
}: Omit<StartApiServerOptions, "host" | "port"> = {}): Server {
  const activeTelemetry = resolveTelemetry(telemetry);
  const consoleUiEnabled = normalizeConsoleUiToggle(enableConsoleUi);
  return createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`
      );
    } catch {
      json(res, 400, {
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request URL.",
        },
      });
      return;
    }
    if (url.pathname === "/" && req.method === "GET") {
      try {
        const operations = await listRuntimeOperations();
        json(res, 200, {
          ok: true,
          service: "ums-api",
          version: "v1",
          operations: operations.map(
            (operation: string) => `${API_PREFIX}/${operation}`
          ),
          deterministic: true,
          storeSelection: {
            bodyField: "storeId",
            header: "x-ums-store",
            defaultStore: "coding-agent",
          },
          consoleUi: {
            enabled: consoleUiEnabled,
            routes: consoleUiEnabled ? Object.keys(CONSOLE_ROUTES) : [],
          },
        });
        return;
      } catch (error) {
        const failure = toErrorResponse(error);
        json(res, failure.statusCode, failure.body);
        return;
      }
    }

    if (url.pathname === "/metrics") {
      if (req.method !== "GET") {
        methodNotAllowed(res, "Only GET is supported for /metrics.");
        return;
      }
      text(res, 200, activeTelemetry.renderPrometheusMetrics());
      return;
    }

    const consoleRoute =
      CONSOLE_ROUTES[url.pathname as keyof typeof CONSOLE_ROUTES];
    if (consoleRoute) {
      if (!consoleUiEnabled) {
        notFound(res);
        return;
      }
      if (req.method !== "GET") {
        methodNotAllowed(res, consoleRoute.methodError);
        return;
      }
      text(
        res,
        200,
        consoleRoute.body,
        consoleRoute.contentType,
        CONSOLE_SECURITY_HEADERS
      );
      return;
    }

    const operation = parseOperation(url.pathname);
    if (!operation) {
      notFound(res);
      return;
    }

    const operationStart = process.hrtime.bigint();
    const recordOperationTelemetry = ({
      statusCode,
      result,
      responseData = null,
      requestBody = null,
      failureCode = null,
    }: RecordOperationTelemetryInput): void => {
      const latencyMs =
        Number(process.hrtime.bigint() - operationStart) / 1_000_000;
      try {
        activeTelemetry.recordOperationResult({
          operation,
          result,
          statusCode,
          latencyMs,
          responseData,
          requestBody,
          failureCode,
        });
      } catch {
        // Telemetry failures must not alter API responses.
      }
    };

    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    let requestBody: unknown;
    try {
      requestBody = await parseJsonBody(req);
      const headerStore = parseStoreHeader(req);
      if (headerStore && isRecord(requestBody) && !requestBody["storeId"]) {
        requestBody = { ...requestBody, storeId: headerStore };
      }
      const data = await executeRuntimeOperation({
        operation,
        requestBody,
        stateFile,
      });
      recordOperationTelemetry({
        statusCode: 200,
        result: "success",
        responseData: data,
        requestBody,
      });
      json(res, 200, { ok: true, data });
    } catch (error) {
      const failure = toErrorResponse(error);
      const failureCode = failure.body.error.code;
      if (failureCode !== "UNSUPPORTED_OPERATION") {
        recordOperationTelemetry({
          statusCode: failure.statusCode,
          result: "failure",
          requestBody,
          failureCode,
        });
      }
      json(res, failure.statusCode, failure.body);
    }
  });
}

export async function startApiServer({
  host = HOST,
  port = PORT,
  stateFile = DEFAULT_RUNTIME_STATE_FILE,
  telemetry = createInMemoryApiTelemetry() as ApiTelemetry,
  enableConsoleUi = ENABLE_CONSOLE_UI,
}: StartApiServerOptions = {}): Promise<StartedApiServer> {
  const activeTelemetry = resolveTelemetry(telemetry);
  const server = createApiServer({
    stateFile,
    telemetry: activeTelemetry,
    enableConsoleUi,
  });
  const startupAbortController = new AbortController();
  const waitForListening = async (): Promise<Error | null> => {
    try {
      await once(server, "listening", {
        signal: startupAbortController.signal,
      });
      return null;
    } catch (error) {
      if (isAbortError(error)) {
        return null;
      }
      return error instanceof Error
        ? error
        : new Error(toErrorMessage(error, "Failed to start API server."));
    }
  };
  const waitForError = async (): Promise<Error | null> => {
    try {
      const [error] = await once(server, "error", {
        signal: startupAbortController.signal,
      });
      return error instanceof Error
        ? error
        : new Error(toErrorMessage(error, "Failed to start API server."));
    } catch (error) {
      if (isAbortError(error)) {
        return null;
      }
      return error instanceof Error
        ? error
        : new Error(toErrorMessage(error, "Failed to start API server."));
    }
  };

  try {
    server.listen(port, host);
    const startupFailure = await Promise.race([
      waitForListening(),
      waitForError(),
    ]);
    if (startupFailure instanceof Error) {
      throw startupFailure;
    }
  } finally {
    startupAbortController.abort();
  }

  const address = server.address();
  const resolvedPort = isAddressInfo(address) ? address.port : port;
  return {
    server,
    host,
    port: resolvedPort,
    telemetry: activeTelemetry,
  };
}

const importMeta = import.meta as ImportMeta & { main?: boolean };
const isStandaloneServerInvocation = process.argv.slice(2).length === 0;
const isMainModule =
  isStandaloneServerInvocation &&
  ((typeof importMeta.main === "boolean" && importMeta.main) ||
    importMeta.url === `file://${process.argv[1]}`);

// Bun-compiled executables can be more aggressive with GC; keep a strong
// process-lifetime reference so the listener stays active.
const globalServerState = globalThis as typeof globalThis & {
  __umsApiActiveServerHandle__?: SupervisedApiService;
};

async function runStandaloneServer(): Promise<void> {
  const serviceRuntimeModulePath = "./service-runtime.ts";
  const module = await import(serviceRuntimeModulePath);
  const startSupervisedApiService = (module as Record<string, unknown>)[
    "startSupervisedApiService"
  ];
  if (typeof startSupervisedApiService !== "function") {
    throw new Error(
      "Failed to start API: service-runtime is missing startSupervisedApiService."
    );
  }

  const { service, host, port } = await (
    startSupervisedApiService as (options: {
      host?: string;
      port?: number;
      stateFile?: string | null;
    }) => Promise<StartSupervisedApiServiceResult>
  )({
    host: HOST,
    port: PORT,
    stateFile: DEFAULT_RUNTIME_STATE_FILE,
  });

  globalServerState.__umsApiActiveServerHandle__ = service;
  process.stdout.write(`UMS API listening on http://${host}:${port}\n`);
  const supervisionWatcher = setInterval(() => {
    const snapshot = service.status();
    if (snapshot.phase === "failed") {
      clearInterval(supervisionWatcher);
      process.stderr.write(
        `UMS API supervision failed: ${snapshot.lastError ?? "unknown failure"}\n`
      );
      process.exit(1);
      return;
    }
    if (snapshot.phase === "stopped") {
      clearInterval(supervisionWatcher);
    }
  }, 250);
  if (typeof supervisionWatcher.unref === "function") {
    supervisionWatcher.unref();
  }
}

if (isMainModule) {
  void (async (): Promise<void> => {
    try {
      await runStandaloneServer();
    } catch (error) {
      process.stderr.write(
        `Failed to start API: ${toErrorMessage(error, "unknown error")}\n`
      );
      process.exit(1);
    }
  })();
}
