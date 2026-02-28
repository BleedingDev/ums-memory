export const METRIC_NAMES = Object.freeze({
  INGEST_EVENTS_TOTAL: "ums.ingest.events_total",
  STATE_TRANSITIONS_TOTAL: "ums.state.transitions_total",
  RECALL_REQUESTS_TOTAL: "ums.recall.requests_total",
  RECALL_PACK_BYTES: "ums.recall.pack_bytes",
  VALIDATION_FAILURES_TOTAL: "ums.validation.failures_total",
  GUARDRAIL_PAYLOAD_REJECTIONS_TOTAL: "ums.guardrail.payload_rejections_total",
  GUARDRAIL_ISOLATION_VIOLATIONS_TOTAL: "ums.guardrail.isolation_violations_total",
  PROCEDURAL_RULES_ACTIVE_GAUGE: "ums.procedural.rules_active",
  PROCEDURAL_RULES_TOMBSTONED_GAUGE: "ums.procedural.rules_tombstoned",
  PROCEDURAL_ANTI_PATTERNS_GAUGE: "ums.procedural.anti_patterns",
  EPISODIC_EVENTS_GAUGE: "ums.episodic.events",
  WORKING_ENTRIES_GAUGE: "ums.working.entries",
});

export const METRIC_LABEL_KEYS = Object.freeze({
  SPACE_ID: "space_id",
  SOURCE: "source",
  EVENT_TYPE: "event_type",
  RESULT: "result",
  REASON: "reason",
});

export function initMetricCounters() {
  return Object.fromEntries(Object.values(METRIC_NAMES).map((metricName) => [metricName, 0]));
}
