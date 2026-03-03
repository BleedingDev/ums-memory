import { createServer } from "node:http";

import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./console-ui.mjs";
import {
  DEFAULT_RUNTIME_STATE_FILE,
  executeRuntimeOperation,
  listRuntimeOperations,
} from "./runtime-adapter.mjs";
import {
  createInMemoryApiTelemetry,
  PROMETHEUS_CONTENT_TYPE,
} from "./telemetry.ts";

const HOST = process.env.UMS_API_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.UMS_API_PORT ?? "8787", 10);
const ENABLE_CONSOLE_UI = parseBooleanFlag(
  process.env.UMS_API_ENABLE_CONSOLE_UI
);
const API_PREFIX = "/v1";
const CONSOLE_SECURITY_HEADERS = Object.freeze({
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
});
const CONSOLE_ROUTES = Object.freeze({
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

function parseBooleanFlag(value) {
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

function normalizeConsoleUiToggle(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return parseBooleanFlag(value);
  }
  return false;
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(
  res,
  statusCode,
  body,
  contentType = PROMETHEUS_CONTENT_TYPE,
  additionalHeaders
) {
  const payload = String(body ?? "");
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload),
    ...additionalHeaders,
  });
  res.end(payload);
}

function notFound(res) {
  return json(res, 404, {
    ok: false,
    error: { code: "NOT_FOUND", message: "Route not found." },
  });
}

function methodNotAllowed(
  res,
  message = "Only POST is supported for operation routes."
) {
  return json(res, 405, {
    ok: false,
    error: { code: "METHOD_NOT_ALLOWED", message },
  });
}

function parseOperation(pathname) {
  if (!pathname.startsWith(`${API_PREFIX}/`)) {
    return null;
  }
  const operation = pathname
    .slice(`${API_PREFIX}/`.length)
    .trim()
    .toLowerCase();
  return operation || null;
}

function parseStoreHeader(req) {
  const value = req.headers["x-ums-store"];
  if (Array.isArray(value)) {
    return (
      value.find((entry) => typeof entry === "string" && entry.trim()) ?? null
    );
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function toErrorResponse(error) {
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
  if (
    error &&
    typeof error === "object" &&
    error.code === "UNSUPPORTED_OPERATION"
  ) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: "UNSUPPORTED_OPERATION",
          message: error.message,
        },
      },
    };
  }
  if (
    error &&
    typeof error === "object" &&
    error.code === "STATE_LOCK_TIMEOUT"
  ) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        error: {
          code: "STATE_LOCK_TIMEOUT",
          message: error.message,
        },
      },
    };
  }
  if (
    error &&
    typeof error === "object" &&
    error.code === "STATE_FILE_CORRUPT"
  ) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: "STATE_FILE_CORRUPT",
          message: error.message,
        },
      },
    };
  }
  if (
    error &&
    typeof error === "object" &&
    error.code === "RUNTIME_ADAPTER_LOAD_ERROR"
  ) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: "RUNTIME_ADAPTER_LOAD_ERROR",
          message: error.message,
        },
      },
    };
  }
  if (
    error &&
    typeof error === "object" &&
    error.code === "RUNTIME_ADAPTER_CONTRACT_ERROR"
  ) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: "RUNTIME_ADAPTER_CONTRACT_ERROR",
          message: error.message,
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
        message: error instanceof Error ? error.message : "Bad request.",
      },
    },
  };
}

function resolveTelemetry(telemetry) {
  if (
    telemetry &&
    typeof telemetry.recordOperationResult === "function" &&
    typeof telemetry.renderPrometheusMetrics === "function"
  ) {
    return telemetry;
  }
  return createInMemoryApiTelemetry();
}

export function createApiServer({
  stateFile = DEFAULT_RUNTIME_STATE_FILE,
  telemetry = createInMemoryApiTelemetry(),
  enableConsoleUi = ENABLE_CONSOLE_UI,
} = {}) {
  const activeTelemetry = resolveTelemetry(telemetry);
  const consoleUiEnabled = normalizeConsoleUiToggle(enableConsoleUi);
  return createServer(async (req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    if (url.pathname === "/" && req.method === "GET") {
      try {
        const operations = await listRuntimeOperations();
        return json(res, 200, {
          ok: true,
          service: "ums-api",
          version: "v1",
          operations: operations.map(
            (operation) => `${API_PREFIX}/${operation}`
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
      } catch (error) {
        const failure = toErrorResponse(error);
        return json(res, failure.statusCode, failure.body);
      }
    }

    if (url.pathname === "/metrics") {
      if (req.method !== "GET") {
        return methodNotAllowed(res, "Only GET is supported for /metrics.");
      }
      return text(res, 200, activeTelemetry.renderPrometheusMetrics());
    }

    const consoleRoute = CONSOLE_ROUTES[url.pathname];
    if (consoleRoute) {
      if (!consoleUiEnabled) {
        return notFound(res);
      }
      if (req.method !== "GET") {
        return methodNotAllowed(res, consoleRoute.methodError);
      }
      return text(
        res,
        200,
        consoleRoute.body,
        consoleRoute.contentType,
        CONSOLE_SECURITY_HEADERS
      );
    }

    const operation = parseOperation(url.pathname);
    if (!operation) {
      return notFound(res);
    }

    const operationStart = process.hrtime.bigint();
    const recordOperationTelemetry = ({
      statusCode,
      result,
      responseData = null,
      requestBody = null,
      failureCode = null,
    }) => {
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
      return methodNotAllowed(res);
    }

    let requestBody;
    try {
      const body = await parseJsonBody(req);
      requestBody = body;
      const headerStore = parseStoreHeader(req);
      if (
        headerStore &&
        requestBody &&
        typeof requestBody === "object" &&
        !Array.isArray(requestBody) &&
        !requestBody.storeId
      ) {
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
      return json(res, 200, { ok: true, data });
    } catch (error) {
      const failure = toErrorResponse(error);
      const failureCode =
        failure.body &&
        typeof failure.body === "object" &&
        failure.body.error &&
        typeof failure.body.error === "object"
          ? failure.body.error.code
          : null;
      if (failureCode !== "UNSUPPORTED_OPERATION") {
        recordOperationTelemetry({
          statusCode: failure.statusCode,
          result: "failure",
          requestBody,
          failureCode,
        });
      }
      return json(res, failure.statusCode, failure.body);
    }
  });
}

export function startApiServer({
  host = HOST,
  port = PORT,
  stateFile = DEFAULT_RUNTIME_STATE_FILE,
  telemetry = createInMemoryApiTelemetry(),
  enableConsoleUi = ENABLE_CONSOLE_UI,
} = {}) {
  const activeTelemetry = resolveTelemetry(telemetry);
  const server = createApiServer({
    stateFile,
    telemetry: activeTelemetry,
    enableConsoleUi,
  });
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      const resolvedPort =
        address &&
        typeof address === "object" &&
        typeof address.port === "number"
          ? address.port
          : port;
      resolve({
        server,
        host,
        port: resolvedPort,
        telemetry: activeTelemetry,
      });
    });
  });
}

const isStandaloneServerInvocation = process.argv.slice(2).length === 0;
const isMainModule =
  isStandaloneServerInvocation &&
  ((typeof import.meta.main === "boolean" && import.meta.main) ||
    import.meta.url === `file://${process.argv[1]}`);

// Bun-compiled executables can be more aggressive with GC; keep a strong
// process-lifetime reference so the listener stays active.
let activeServerHandle = null;

if (isMainModule) {
  import("./service-runtime.mjs")
    .then(({ startSupervisedApiService }) =>
      startSupervisedApiService({
        host: HOST,
        port: PORT,
        stateFile: DEFAULT_RUNTIME_STATE_FILE,
      })
    )
    .then(({ service, host, port }) => {
      activeServerHandle = service;
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
    })
    .catch((error) => {
      process.stderr.write(`Failed to start API: ${error.message}\n`);
      process.exit(1);
    });
}
