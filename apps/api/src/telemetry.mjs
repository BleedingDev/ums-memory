const DEFAULT_LATENCY_BUCKETS_MS = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
]);

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

function asNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOperation(operation) {
  return asNonEmptyString(operation) ?? "unknown";
}

function normalizeResult(result) {
  return result === "success" ? "success" : "failure";
}

function normalizeStatusCode(statusCode) {
  return Number.isFinite(statusCode) ? Math.max(0, Math.trunc(statusCode)) : 0;
}

function roundNumber(value, precision = 6) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function normalizeLatencyMs(latencyMs) {
  if (!Number.isFinite(latencyMs)) {
    return 0;
  }
  return roundNumber(Math.max(0, latencyMs), 6);
}

function makeSeriesKey(operation, result) {
  return `${operation}|${result}`;
}

function escapeLabelValue(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function formatLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }
  const serialized = entries
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");
  return `{${serialized}}`;
}

function formatMetricNumber(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const rounded = roundNumber(value, 6);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function extractTraceContext(responseData) {
  const typedResponse = isPlainObject(responseData) ? responseData : null;
  const trace = isPlainObject(typedResponse?.trace) ? typedResponse.trace : null;
  const observability = isPlainObject(typedResponse?.observability)
    ? typedResponse.observability
    : null;
  const tracePayload =
    (isPlainObject(trace?.payload) && trace.payload) ||
    (isPlainObject(observability?.tracePayload) && observability.tracePayload) ||
    null;

  return {
    traceId: asNonEmptyString(trace?.traceId),
    spanId: asNonEmptyString(trace?.spanId),
    parentSpanId: asNonEmptyString(trace?.parentSpanId),
    tracePayload,
  };
}

function resolveStoreId(responseData, requestBody) {
  const typedResponse = isPlainObject(responseData) ? responseData : null;
  const typedRequest = isPlainObject(requestBody) ? requestBody : null;
  return asNonEmptyString(typedResponse?.storeId) ?? asNonEmptyString(typedRequest?.storeId);
}

function resolveRequestDigest(responseData, tracePayload) {
  const typedResponse = isPlainObject(responseData) ? responseData : null;
  return (
    asNonEmptyString(typedResponse?.requestDigest) ??
    asNonEmptyString(tracePayload?.requestDigest) ??
    null
  );
}

function normalizeLatencyBuckets(latencyBucketsMs) {
  const normalized = Array.isArray(latencyBucketsMs)
    ? latencyBucketsMs
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((left, right) => left - right)
    : [];
  const deduped = normalized.filter(
    (value, index) => index === 0 || value !== normalized[index - 1],
  );
  return deduped.length > 0 ? deduped : DEFAULT_LATENCY_BUCKETS_MS;
}

export function buildOperationTelemetryEvent({
  operation,
  result,
  statusCode,
  latencyMs,
  responseData = null,
  requestBody = null,
  failureCode = null,
} = {}) {
  const normalizedOperation = normalizeOperation(operation);
  const normalizedResult = normalizeResult(result);
  const normalizedStatusCode = normalizeStatusCode(statusCode);
  const normalizedLatencyMs = normalizeLatencyMs(latencyMs);
  const normalizedFailureCode = asNonEmptyString(failureCode);
  const { traceId, spanId, parentSpanId, tracePayload } = extractTraceContext(responseData);
  const storeId = resolveStoreId(responseData, requestBody);
  const requestDigest = resolveRequestDigest(responseData, tracePayload);

  const event = {
    event: "ums.api.operation.result",
    service: "ums-api",
    operation: normalizedOperation,
    status: normalizedResult,
    statusCode: normalizedStatusCode,
    latencyMs: normalizedLatencyMs,
  };

  if (normalizedFailureCode) {
    event.failureCode = normalizedFailureCode;
  }
  if (storeId) {
    event.storeId = storeId;
  }
  if (requestDigest) {
    event.requestDigest = requestDigest;
  }
  if (tracePayload) {
    event.tracePayload = tracePayload;
  }
  if (traceId) {
    event.traceId = traceId;
    event.trace_id = traceId;
  }
  if (spanId) {
    event.spanId = spanId;
    event.span_id = spanId;
  }
  if (parentSpanId) {
    event.parentSpanId = parentSpanId;
    event.parent_span_id = parentSpanId;
  }
  if (traceId || spanId) {
    event.trace_flags = "01";
  }
  event.deterministic = true;
  return event;
}

export function defaultTelemetryLogger(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function createInMemoryApiTelemetry({
  logger = defaultTelemetryLogger,
  latencyBucketsMs = DEFAULT_LATENCY_BUCKETS_MS,
} = {}) {
  const buckets = normalizeLatencyBuckets(latencyBucketsMs);
  const seriesByKey = new Map();

  function getOrCreateSeries({ operation, result }) {
    const key = makeSeriesKey(operation, result);
    const existing = seriesByKey.get(key);
    if (existing) {
      return existing;
    }
    const created = {
      operation,
      result,
      count: 0,
      latencySumMs: 0,
      latencyBucketCounts: buckets.map(() => 0),
    };
    seriesByKey.set(key, created);
    return created;
  }

  return {
    recordOperationResult({
      operation,
      result,
      statusCode,
      latencyMs,
      responseData = null,
      requestBody = null,
      failureCode = null,
    } = {}) {
      const normalizedOperation = normalizeOperation(operation);
      const normalizedResult = normalizeResult(result);
      const normalizedLatencyMs = normalizeLatencyMs(latencyMs);
      const series = getOrCreateSeries({
        operation: normalizedOperation,
        result: normalizedResult,
      });

      series.count += 1;
      series.latencySumMs = roundNumber(series.latencySumMs + normalizedLatencyMs, 6);
      for (let index = 0; index < buckets.length; index += 1) {
        if (normalizedLatencyMs <= buckets[index]) {
          series.latencyBucketCounts[index] += 1;
        }
      }

      const event = buildOperationTelemetryEvent({
        operation: normalizedOperation,
        result: normalizedResult,
        statusCode,
        latencyMs: normalizedLatencyMs,
        responseData,
        requestBody,
        failureCode,
      });

      try {
        logger(event);
      } catch {
        // Telemetry logging must never fail request handling.
      }

      return event;
    },
    renderPrometheusMetrics() {
      const series = [...seriesByKey.values()].sort((left, right) => {
        const operationDiff = left.operation.localeCompare(right.operation);
        if (operationDiff !== 0) {
          return operationDiff;
        }
        return left.result.localeCompare(right.result);
      });

      const lines = [
        "# HELP ums_api_operation_requests_total Total number of API operation requests.",
        "# TYPE ums_api_operation_requests_total counter",
      ];

      for (const entry of series) {
        lines.push(
          `ums_api_operation_requests_total${formatLabels({
            operation: entry.operation,
            result: entry.result,
          })} ${entry.count}`,
        );
      }

      lines.push(
        "# HELP ums_api_operation_latency_ms API operation request latency in milliseconds.",
        "# TYPE ums_api_operation_latency_ms histogram",
      );

      for (const entry of series) {
        const baseLabels = {
          operation: entry.operation,
          result: entry.result,
        };
        for (let index = 0; index < buckets.length; index += 1) {
          lines.push(
            `ums_api_operation_latency_ms_bucket${formatLabels({
              ...baseLabels,
              le: buckets[index],
            })} ${entry.latencyBucketCounts[index]}`,
          );
        }
        lines.push(
          `ums_api_operation_latency_ms_bucket${formatLabels({
            ...baseLabels,
            le: "+Inf",
          })} ${entry.count}`,
          `ums_api_operation_latency_ms_sum${formatLabels(baseLabels)} ${formatMetricNumber(entry.latencySumMs)}`,
          `ums_api_operation_latency_ms_count${formatLabels(baseLabels)} ${entry.count}`,
        );
      }

      return `${lines.join("\n")}\n`;
    },
  };
}
