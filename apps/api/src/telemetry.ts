const DEFAULT_LATENCY_BUCKETS_MS = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
]) as readonly number[];

export const PROMETHEUS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8";

type TelemetryResult = "success" | "failure";
type TracePayload = Record<string, unknown>;

interface TelemetryEventSource {
  trace?: unknown;
  observability?: unknown;
  storeId?: unknown;
  requestDigest?: unknown;
}

interface RequestBodySource {
  storeId?: unknown;
}

interface TraceSource {
  traceId?: unknown;
  spanId?: unknown;
  parentSpanId?: unknown;
  payload?: unknown;
}

interface ObservabilitySource {
  tracePayload?: unknown;
}

interface ExtractedTraceContext {
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  tracePayload: TracePayload | null;
}

export interface BuildOperationTelemetryEventOptions {
  operation?: unknown;
  result?: unknown;
  statusCode?: unknown;
  latencyMs?: unknown;
  responseData?: unknown;
  requestBody?: unknown;
  failureCode?: unknown;
}

export interface OperationTelemetryEvent {
  event: "ums.api.operation.result";
  service: "ums-api";
  operation: string;
  status: TelemetryResult;
  statusCode: number;
  latencyMs: number;
  failureCode?: string;
  storeId?: string;
  requestDigest?: string;
  tracePayload?: TracePayload;
  traceId?: string;
  trace_id?: string;
  spanId?: string;
  span_id?: string;
  parentSpanId?: string;
  parent_span_id?: string;
  trace_flags?: "01";
  deterministic: true;
}

export type OperationTelemetryLogger = (event: OperationTelemetryEvent) => void;

export interface CreateInMemoryApiTelemetryOptions {
  logger?: OperationTelemetryLogger;
  latencyBucketsMs?: readonly number[];
}

export interface InMemoryApiTelemetry {
  recordOperationResult: (
    input?: BuildOperationTelemetryEventOptions
  ) => OperationTelemetryEvent;
  renderPrometheusMetrics: () => string;
}

interface TelemetrySeries {
  operation: string;
  result: TelemetryResult;
  count: number;
  latencySumMs: number;
  latencyBucketCounts: number[];
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObject<T extends object>(value: unknown): T | null {
  return isPlainObject(value) ? (value as T) : null;
}

function normalizeOperation(operation: unknown): string {
  return asNonEmptyString(operation) ?? "unknown";
}

function normalizeResult(result: unknown): TelemetryResult {
  return result === "success" ? "success" : "failure";
}

function normalizeStatusCode(statusCode: unknown): number {
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) {
    return 0;
  }
  return Math.max(0, Math.trunc(statusCode));
}

function roundNumber(value: number, precision = 6): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function normalizeLatencyMs(latencyMs: unknown): number {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return 0;
  }
  return roundNumber(Math.max(0, latencyMs), 6);
}

function makeSeriesKey(operation: string, result: TelemetryResult): string {
  return `${operation}|${result}`;
}

function escapeLabelValue(value: string | number): string {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function formatLabels(
  labels: Readonly<Record<string, string | number>>
): string {
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

function formatMetricNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return String(roundNumber(value, 6));
}

function extractTraceContext(responseData: unknown): ExtractedTraceContext {
  const typedResponse = asObject<TelemetryEventSource>(responseData);
  const trace = asObject<TraceSource>(typedResponse?.trace);
  const observability = asObject<ObservabilitySource>(
    typedResponse?.observability
  );
  const tracePayload =
    asObject<TracePayload>(trace?.payload) ??
    asObject<TracePayload>(observability?.tracePayload);

  return {
    traceId: asNonEmptyString(trace?.traceId),
    spanId: asNonEmptyString(trace?.spanId),
    parentSpanId: asNonEmptyString(trace?.parentSpanId),
    tracePayload: tracePayload ?? null,
  };
}

function resolveStoreId(
  responseData: unknown,
  requestBody: unknown
): string | null {
  const typedResponse = asObject<TelemetryEventSource>(responseData);
  const typedRequest = asObject<RequestBodySource>(requestBody);
  return (
    asNonEmptyString(typedResponse?.storeId) ??
    asNonEmptyString(typedRequest?.storeId)
  );
}

function resolveRequestDigest(
  responseData: unknown,
  tracePayload: TracePayload | null
): string | null {
  const typedResponse = asObject<TelemetryEventSource>(responseData);
  const digestFromTracePayload =
    tracePayload !== null
      ? asNonEmptyString(tracePayload["requestDigest"])
      : null;
  return (
    asNonEmptyString(typedResponse?.requestDigest) ?? digestFromTracePayload
  );
}

function normalizeLatencyBuckets(
  latencyBucketsMs: readonly number[] | undefined
): readonly number[] {
  const normalized =
    latencyBucketsMs?.length !== undefined
      ? [...latencyBucketsMs]
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > 0)
          .sort((left, right) => left - right)
      : [];
  const deduped: number[] = [];
  for (const value of normalized) {
    const lastValue = deduped.at(-1);
    if (lastValue !== value) {
      deduped.push(value);
    }
  }
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
}: BuildOperationTelemetryEventOptions = {}): OperationTelemetryEvent {
  const normalizedOperation = normalizeOperation(operation);
  const normalizedResult = normalizeResult(result);
  const normalizedStatusCode = normalizeStatusCode(statusCode);
  const normalizedLatencyMs = normalizeLatencyMs(latencyMs);
  const normalizedFailureCode = asNonEmptyString(failureCode);
  const { traceId, spanId, parentSpanId, tracePayload } =
    extractTraceContext(responseData);
  const storeId = resolveStoreId(responseData, requestBody);
  const requestDigest = resolveRequestDigest(responseData, tracePayload);

  const event: OperationTelemetryEvent = {
    event: "ums.api.operation.result",
    service: "ums-api",
    operation: normalizedOperation,
    status: normalizedResult,
    statusCode: normalizedStatusCode,
    latencyMs: normalizedLatencyMs,
    deterministic: true,
  };

  if (normalizedFailureCode !== null) {
    event.failureCode = normalizedFailureCode;
  }
  if (storeId !== null) {
    event.storeId = storeId;
  }
  if (requestDigest !== null) {
    event.requestDigest = requestDigest;
  }
  if (tracePayload !== null) {
    event.tracePayload = tracePayload;
  }
  if (traceId !== null) {
    event.traceId = traceId;
    event.trace_id = traceId;
  }
  if (spanId !== null) {
    event.spanId = spanId;
    event.span_id = spanId;
  }
  if (parentSpanId !== null) {
    event.parentSpanId = parentSpanId;
    event.parent_span_id = parentSpanId;
  }
  if (traceId !== null || spanId !== null) {
    event.trace_flags = "01";
  }
  return event;
}

export function defaultTelemetryLogger(event: OperationTelemetryEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function createInMemoryApiTelemetry({
  logger = defaultTelemetryLogger,
  latencyBucketsMs = DEFAULT_LATENCY_BUCKETS_MS,
}: CreateInMemoryApiTelemetryOptions = {}): InMemoryApiTelemetry {
  const buckets = normalizeLatencyBuckets(latencyBucketsMs);
  const seriesByKey = new Map<string, TelemetrySeries>();

  function getOrCreateSeries({
    operation,
    result,
  }: {
    operation: string;
    result: TelemetryResult;
  }): TelemetrySeries {
    const key = makeSeriesKey(operation, result);
    const existing = seriesByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: TelemetrySeries = {
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
    }: BuildOperationTelemetryEventOptions = {}): OperationTelemetryEvent {
      const normalizedOperation = normalizeOperation(operation);
      const normalizedResult = normalizeResult(result);
      const normalizedLatencyMs = normalizeLatencyMs(latencyMs);
      const series = getOrCreateSeries({
        operation: normalizedOperation,
        result: normalizedResult,
      });

      series.count += 1;
      series.latencySumMs = roundNumber(
        series.latencySumMs + normalizedLatencyMs,
        6
      );
      for (const [index, bucket] of buckets.entries()) {
        if (normalizedLatencyMs <= bucket) {
          const bucketCount = series.latencyBucketCounts[index] ?? 0;
          series.latencyBucketCounts[index] = bucketCount + 1;
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
    renderPrometheusMetrics(): string {
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
          })} ${entry.count}`
        );
      }

      lines.push(
        "# HELP ums_api_operation_latency_ms API operation request latency in milliseconds.",
        "# TYPE ums_api_operation_latency_ms histogram"
      );

      for (const entry of series) {
        const baseLabels = {
          operation: entry.operation,
          result: entry.result,
        };
        for (const [index, bucket] of buckets.entries()) {
          lines.push(
            `ums_api_operation_latency_ms_bucket${formatLabels({
              ...baseLabels,
              le: bucket,
            })} ${entry.latencyBucketCounts[index] ?? 0}`
          );
        }
        lines.push(
          `ums_api_operation_latency_ms_bucket${formatLabels({
            ...baseLabels,
            le: "+Inf",
          })} ${entry.count}`,
          `ums_api_operation_latency_ms_sum${formatLabels(baseLabels)} ${formatMetricNumber(entry.latencySumMs)}`,
          `ums_api_operation_latency_ms_count${formatLabels(baseLabels)} ${entry.count}`
        );
      }

      return `${lines.join("\n")}\n`;
    },
  };
}
