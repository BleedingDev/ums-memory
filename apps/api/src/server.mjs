import { createServer } from "node:http";
import { executeOperation, listOperations } from "./core.mjs";

const HOST = process.env.UMS_API_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.UMS_API_PORT ?? "8787", 10);
const API_PREFIX = "/v1";

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function notFound(res) {
  return json(res, 404, {
    ok: false,
    error: { code: "NOT_FOUND", message: "Route not found." }
  });
}

function methodNotAllowed(res) {
  return json(res, 405, {
    ok: false,
    error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported for operation routes." }
  });
}

function parseOperation(pathname) {
  if (!pathname.startsWith(`${API_PREFIX}/`)) {
    return null;
  }
  const operation = pathname.slice(`${API_PREFIX}/`.length).trim().toLowerCase();
  return operation || null;
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
          message: "Request body must be valid JSON."
        }
      }
    };
  }
  if (error && typeof error === "object" && error.code === "UNSUPPORTED_OPERATION") {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: "UNSUPPORTED_OPERATION",
          message: error.message
        }
      }
    };
  }
  return {
    statusCode: 400,
    body: {
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "Bad request."
      }
    }
  };
}

export function createApiServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        service: "ums-api",
        version: "v1",
        operations: listOperations().map((operation) => `${API_PREFIX}/${operation}`),
        deterministic: true
      });
    }

    const operation = parseOperation(url.pathname);
    if (!operation) {
      return notFound(res);
    }
    if (req.method !== "POST") {
      return methodNotAllowed(res);
    }

    try {
      const body = await parseJsonBody(req);
      const data = executeOperation(operation, body);
      return json(res, 200, { ok: true, data });
    } catch (error) {
      const failure = toErrorResponse(error);
      return json(res, failure.statusCode, failure.body);
    }
  });
}

export function startApiServer({
  host = HOST,
  port = PORT
} = {}) {
  const server = createApiServer();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        host,
        port
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startApiServer()
    .then(({ host, port }) => {
      process.stdout.write(`UMS API listening on http://${host}:${port}\n`);
    })
    .catch((error) => {
      process.stderr.write(`Failed to start API: ${error.message}\n`);
      process.exit(1);
    });
}

