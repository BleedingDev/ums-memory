import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { resetStore } from "../src/core.ts";
import { startApiServer } from "../src/server.ts";
import { createInMemoryApiTelemetry } from "../src/telemetry.ts";

const CLI_PATH = resolve(process.cwd(), "apps/cli/src/index.ts");

function runCli(args, stdin = "") {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

function assertConsoleSecurityHeaders(response) {
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("http server exposes prometheus metrics and deterministic structured telemetry events", async () => {
  resetStore();
  const events = [];
  const telemetry = createInMemoryApiTelemetry({
    logger(event) {
      events.push(event);
    },
  });
  const { server, host, port } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
    telemetry,
  });
  const base = `http://${host}:${port}`;

  try {
    const initialMetricsRes = await fetch(`${base}/metrics`);
    assert.equal(initialMetricsRes.status, 200);
    assert.match(
      initialMetricsRes.headers.get("content-type") ?? "",
      /^text\/plain/i
    );
    const initialMetrics = await initialMetricsRes.text();
    assert.match(initialMetrics, /# HELP ums_api_operation_requests_total/);
    assert.match(
      initialMetrics,
      /# TYPE ums_api_operation_latency_ms histogram/
    );

    const shadowRes = await fetch(`${base}/v1/shadow_write`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-telemetry",
      },
      body: JSON.stringify({
        profile: "telemetry-http",
        statement: "Structured telemetry should include trace context.",
        sourceEventIds: ["evt-telemetry-shadow-1"],
        evidenceEventIds: ["evt-telemetry-shadow-1"],
      }),
    });
    assert.equal(shadowRes.status, 200);
    const shadowBody = await shadowRes.json();
    assert.equal(shadowBody.ok, true);
    assert.equal(shadowBody.data.operation, "shadow_write");
    assert.ok(shadowBody.data.trace);
    assert.ok(shadowBody.data.trace.payload);

    const failureRes = await fetch(`${base}/v1/misconception_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-telemetry",
      },
      body: JSON.stringify({
        profile: "telemetry-http",
        misconceptionKey: "missing-evidence",
        signal: "harmful",
      }),
    });
    assert.equal(failureRes.status, 400);
    const failureBody = await failureRes.json();
    assert.equal(failureBody.ok, false);
    assert.equal(failureBody.error.code, "BAD_REQUEST");

    const unsupportedRes = await fetch(
      `${base}/v1/operation-never-implemented`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "tenant-telemetry",
        },
        body: JSON.stringify({ profile: "telemetry-http" }),
      }
    );
    assert.equal(unsupportedRes.status, 404);
    const unsupportedBody = await unsupportedRes.json();
    assert.equal(unsupportedBody.ok, false);
    assert.equal(unsupportedBody.error.code, "UNSUPPORTED_OPERATION");

    const metricsRes = await fetch(`${base}/metrics`);
    assert.equal(metricsRes.status, 200);
    assert.match(metricsRes.headers.get("content-type") ?? "", /^text\/plain/i);
    const metrics = await metricsRes.text();
    assert.match(
      metrics,
      /ums_api_operation_requests_total\{operation="misconception_update",result="failure"\} 1/
    );
    assert.match(
      metrics,
      /ums_api_operation_requests_total\{operation="shadow_write",result="success"\} 1/
    );
    assert.match(
      metrics,
      /ums_api_operation_latency_ms_count\{operation="misconception_update",result="failure"\} 1/
    );
    assert.match(
      metrics,
      /ums_api_operation_latency_ms_count\{operation="shadow_write",result="success"\} 1/
    );
    assert.doesNotMatch(
      metrics,
      /ums_api_operation_requests_total\{operation="operation-never-implemented",result="failure"\}/
    );

    assert.equal(events.length, 2);
    const shadowEvent = events.find(
      (event) => event.operation === "shadow_write"
    );
    assert.ok(shadowEvent);
    assert.equal(shadowEvent.event, "ums.api.operation.result");
    assert.equal(shadowEvent.service, "ums-api");
    assert.equal(shadowEvent.status, "success");
    assert.equal(shadowEvent.statusCode, 200);
    assert.equal(typeof shadowEvent.latencyMs, "number");
    assert.equal(shadowEvent.latencyMs >= 0, true);
    assert.equal(shadowEvent.deterministic, true);
    assert.deepEqual(shadowEvent.tracePayload, shadowBody.data.trace.payload);
    assert.equal(shadowEvent.traceId, shadowBody.data.trace.traceId);
    assert.equal(shadowEvent.spanId, shadowBody.data.trace.spanId);
    assert.equal(shadowEvent.parentSpanId, shadowBody.data.trace.parentSpanId);
    assert.equal(shadowEvent.trace_id, shadowBody.data.trace.traceId);
    assert.equal(shadowEvent.span_id, shadowBody.data.trace.spanId);
    assert.equal(
      shadowEvent.parent_span_id,
      shadowBody.data.trace.parentSpanId
    );
    assert.equal(shadowEvent.trace_flags, "01");

    const failureEvent = events.find(
      (event) => event.operation === "misconception_update"
    );
    assert.ok(failureEvent);
    assert.equal(failureEvent.event, "ums.api.operation.result");
    assert.equal(failureEvent.service, "ums-api");
    assert.equal(failureEvent.status, "failure");
    assert.equal(failureEvent.statusCode, 400);
    assert.equal(failureEvent.failureCode, "BAD_REQUEST");
    assert.equal(typeof failureEvent.latencyMs, "number");
    assert.equal(failureEvent.latencyMs >= 0, true);
    assert.equal(failureEvent.deterministic, true);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise()
      );
    });
  }
});

test("http server exposes deterministic JSON operation routes", async () => {
  resetStore();
  const { server, host, port } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    const rootBody = await rootRes.json();
    assert.equal(rootBody.ok, true);
    assert.equal(rootBody.deterministic, true);
    assert.equal(rootBody.consoleUi.enabled, false);
    assert.deepEqual(rootBody.consoleUi.routes, []);
    assert.equal(
      rootBody.operations.includes("/v1/learner_profile_update"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/identity_graph_update"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/misconception_update"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/curriculum_plan_update"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/review_schedule_update"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/policy_decision_update"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/incident_escalation_signal"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/manual_quarantine_override"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/memory_console_search"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/memory_console_timeline"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/memory_console_provenance"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/memory_console_policy_audit"),
      true
    );
    assert.equal(
      rootBody.operations.includes("/v1/memory_console_anomaly_alerts"),
      true
    );

    const ingestRes = await fetch(`${base}/v1/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "coding-agent",
      },
      body: JSON.stringify({
        profile: "api-test",
        events: [
          {
            type: "note",
            source: "test",
            content: "deterministic server response",
          },
        ],
      }),
    });
    assert.equal(ingestRes.status, 200);
    const ingestBody = await ingestRes.json();
    assert.equal(ingestBody.ok, true);
    assert.equal(ingestBody.data.operation, "ingest");
    assert.equal(ingestBody.data.storeId, "coding-agent");
    assert.equal(ingestBody.data.accepted, 1);

    const shadowRes = await fetch(`${base}/v1/shadow_write`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "coding-agent",
      },
      body: JSON.stringify({
        profile: "api-manual-override",
        statement: "Manual override should be reachable via HTTP route.",
        sourceEventIds: ["evt-api-manual-shadow-1"],
        evidenceEventIds: ["evt-api-manual-shadow-1"],
      }),
    });
    assert.equal(shadowRes.status, 200);
    const shadowBody = await shadowRes.json();
    const candidateId = shadowBody.data.applied[0].candidateId;

    const manualRequest = {
      profile: "api-manual-override",
      overrideControlId: "movr-api-route-1",
      action: "promote",
      actor: "api-oncall",
      reasonCodes: ["http_manual_restore"],
      targetCandidateIds: [candidateId],
      evidenceEventIds: ["evt-api-manual-override-1"],
      sourceEventIds: ["evt-api-manual-override-2"],
      timestamp: "2026-03-02T22:00:00.000Z",
    };
    const manualFirstRes = await fetch(
      `${base}/v1/manual_quarantine_override`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "coding-agent",
        },
        body: JSON.stringify(manualRequest),
      }
    );
    assert.equal(manualFirstRes.status, 200);
    const manualFirstBody = await manualFirstRes.json();
    assert.equal(manualFirstBody.ok, true);
    assert.equal(manualFirstBody.data.operation, "manual_quarantine_override");
    assert.equal(manualFirstBody.data.action, "created");
    assert.equal(manualFirstBody.data.override.action, "promote");
    assert.equal(manualFirstBody.data.override.changed, true);

    const manualReplayRes = await fetch(
      `${base}/v1/manual_quarantine_override`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "coding-agent",
        },
        body: JSON.stringify(manualRequest),
      }
    );
    assert.equal(manualReplayRes.status, 200);
    const manualReplayBody = await manualReplayRes.json();
    assert.equal(manualReplayBody.ok, true);
    assert.equal(manualReplayBody.data.action, "noop");
    assert.equal(manualReplayBody.data.override.changed, false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("ums-memory-yji.7 keeps console UI routes disabled by default", async () => {
  resetStore();
  const { server, host, port } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const base = `http://${host}:${port}`;

  try {
    for (const route of ["/console", "/console.js", "/console.css"]) {
      const getRes = await fetch(`${base}${route}`);
      assert.equal(getRes.status, 404);
      const getBody = await getRes.json();
      assert.equal(getBody.ok, false);
      assert.equal(getBody.error.code, "NOT_FOUND");

      const postRes = await fetch(`${base}${route}`, { method: "POST" });
      assert.equal(postRes.status, 404);
      const postBody = await postRes.json();
      assert.equal(postBody.ok, false);
      assert.equal(postBody.error.code, "NOT_FOUND");
    }
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise()
      );
    });
  }
});

test("ums-memory-yji.7 serves deterministic memory console UI and static assets when enabled", async () => {
  resetStore();
  const { server, host, port } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
    enableConsoleUi: true,
  });
  const base = `http://${host}:${port}`;

  try {
    const consoleRes = await fetch(`${base}/console`);
    assert.equal(consoleRes.status, 200);
    assert.match(consoleRes.headers.get("content-type") ?? "", /^text\/html/i);
    assertConsoleSecurityHeaders(consoleRes);
    const consoleHtml = await consoleRes.text();
    assert.match(consoleHtml, /<title>UMS Memory Console<\/title>/);
    assert.match(consoleHtml, /href="\/console\.css"/);
    assert.match(consoleHtml, /src="\/console\.js"/);
    assert.match(consoleHtml, /Profile \(fixed\)/);
    assert.match(consoleHtml, /data-operation="memory_console_search"/);
    assert.match(consoleHtml, /data-operation="memory_console_timeline"/);
    assert.match(consoleHtml, /data-operation="memory_console_provenance"/);
    assert.match(consoleHtml, /data-operation="memory_console_policy_audit"/);
    assert.match(consoleHtml, /data-operation="memory_console_anomaly_alerts"/);
    assert.match(consoleHtml, /data-operation="manual_quarantine_override"/);

    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    const rootBody = await rootRes.json();
    assert.equal(rootBody.consoleUi.enabled, true);
    assert.deepEqual(rootBody.consoleUi.routes, [
      "/console",
      "/console.js",
      "/console.css",
    ]);

    const scriptRes = await fetch(`${base}/console.js`);
    assert.equal(scriptRes.status, 200);
    assert.match(scriptRes.headers.get("content-type") ?? "", /javascript/i);
    assertConsoleSecurityHeaders(scriptRes);
    const scriptBody = await scriptRes.text();
    assert.match(scriptBody, /memory_console_search/);
    assert.match(scriptBody, /memory_console_timeline/);
    assert.match(scriptBody, /memory_console_provenance/);
    assert.match(scriptBody, /memory_console_policy_audit/);
    assert.match(scriptBody, /memory_console_anomaly_alerts/);
    assert.match(scriptBody, /manual_quarantine_override/);
    assert.doesNotMatch(scriptBody, /Number\.parseInt/);

    const styleRes = await fetch(`${base}/console.css`);
    assert.equal(styleRes.status, 200);
    assert.match(styleRes.headers.get("content-type") ?? "", /^text\/css/i);
    assertConsoleSecurityHeaders(styleRes);
    const styleBody = await styleRes.text();
    assert.match(styleBody, /\.console-app/);
    assert.match(styleBody, /\.operation-card/);

    for (const route of ["/console", "/console.js", "/console.css"]) {
      const wrongMethodRes = await fetch(`${base}${route}`, { method: "POST" });
      assert.equal(wrongMethodRes.status, 405);
      const wrongMethodBody = await wrongMethodRes.json();
      assert.equal(wrongMethodBody.ok, false);
      assert.equal(wrongMethodBody.error.code, "METHOD_NOT_ALLOWED");
    }
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise()
      );
    });
  }
});

test("ums-memory-yji.7 console UI toggle parses string config values safely", async () => {
  const runCase = async (toggle, expectedStatus) => {
    resetStore();
    const { server, host, port } = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      stateFile: null,
      enableConsoleUi: toggle,
    });
    const base = `http://${host}:${port}`;
    try {
      const consoleRes = await fetch(`${base}/console`);
      assert.equal(consoleRes.status, expectedStatus);
      const rootRes = await fetch(`${base}/`);
      assert.equal(rootRes.status, 200);
      const rootBody = await rootRes.json();
      assert.equal(rootBody.consoleUi.enabled, expectedStatus === 200);
    } finally {
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) =>
          error ? rejectPromise(error) : resolvePromise()
        );
      });
    }
  };

  await runCase("false", 404);
  await runCase("0", 404);
  await runCase("true", 200);
  await runCase("1", 200);
});

test("ums-memory-yji.6 memory_console HTTP routes expose deterministic operator contracts", async () => {
  resetStore();
  const { server, host, port } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const base = `http://${host}:${port}`;

  try {
    const profileRes = await fetch(`${base}/v1/learner_profile_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-yji6-http",
      },
      body: JSON.stringify({
        profile: "operator-yji6-http",
        learnerId: "learner-http-yji6",
        identityRefs: [
          {
            namespace: "email",
            value: "http-yji6@example.com",
            isPrimary: true,
          },
        ],
        goals: ["incident-response"],
        evidenceEventIds: ["ep-http-profile-yji6-1"],
        timestamp: "2026-03-01T10:00:00.000Z",
      }),
    });
    assert.equal(profileRes.status, 200);
    const profileBody = await profileRes.json();
    assert.equal(profileBody.ok, true);
    const profileId = profileBody.data.profileId;

    const misconceptionRes = await fetch(`${base}/v1/misconception_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-yji6-http",
      },
      body: JSON.stringify({
        profile: "operator-yji6-http",
        misconceptionKey: "timeline-gap",
        signal: "harmful",
        evidenceEventIds: ["evt-http-mis-yji6-1"],
        timestamp: "2026-03-01T11:00:00.000Z",
      }),
    });
    assert.equal(misconceptionRes.status, 200);

    const policyRes = await fetch(`${base}/v1/policy_decision_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-yji6-http",
      },
      body: JSON.stringify({
        profile: "operator-yji6-http",
        policyKey: "operator-safety-http",
        outcome: "deny",
        reasonCodes: ["safety-risk-http"],
        provenanceEventIds: ["evt-pol-http-yji6-1"],
        evidenceEventIds: ["ep-pol-http-yji6-1"],
        timestamp: "2026-03-01T12:00:00.000Z",
      }),
    });
    assert.equal(policyRes.status, 200);
    const policyBody = await policyRes.json();
    assert.equal(policyBody.ok, true);
    const decisionId = policyBody.data.decisionId;
    const policyAuditEventId = policyBody.data.policyAuditEventId;

    const searchRequest = {
      profile: "operator-yji6-http",
      query: "timeline-gap",
      type: "misconception",
      limit: 3,
    };
    const searchRes = await fetch(`${base}/v1/memory_console_search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-yji6-http",
      },
      body: JSON.stringify(searchRequest),
    });
    const searchReplayRes = await fetch(`${base}/v1/memory_console_search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-yji6-http",
      },
      body: JSON.stringify(searchRequest),
    });
    assert.equal(searchRes.status, 200);
    assert.equal(searchReplayRes.status, 200);
    const searchBody = await searchRes.json();
    const searchReplayBody = await searchReplayRes.json();
    assert.equal(searchBody.ok, true);
    assert.equal(searchBody.data.operation, "memory_console_search");
    assert.equal(searchBody.data.totalMatches, 1);
    assert.deepEqual(searchBody.data.results, searchReplayBody.data.results);

    const timelineRequest = {
      profile: "operator-yji6-http",
      types: ["policy_decision", "policy_audit_event"],
      since: "2026-03-01T00:00:00.000Z",
      until: "2026-03-01T23:59:59.999Z",
      limit: 6,
    };
    const timelineRes = await fetch(`${base}/v1/memory_console_timeline`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-yji6-http",
      },
      body: JSON.stringify(timelineRequest),
    });
    assert.equal(timelineRes.status, 200);
    const timelineBody = await timelineRes.json();
    assert.equal(timelineBody.ok, true);
    assert.equal(timelineBody.data.operation, "memory_console_timeline");
    assert.equal(
      timelineBody.data.events.every(
        (event) =>
          event.timestamp >= timelineRequest.since &&
          event.timestamp <= timelineRequest.until
      ),
      true
    );
    assert.equal(
      timelineBody.data.events.some(
        (event) => event.entityType === "policy_decision"
      ),
      true
    );

    const provenanceRes = await fetch(`${base}/v1/memory_console_provenance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-yji6-http",
      },
      body: JSON.stringify({
        profile: "operator-yji6-http",
        entityRefs: [
          { entityType: "learner_profile", entityId: profileId },
          { entityType: "policy_decision", entityId: decisionId },
          { entityType: "policy_audit_event", entityId: policyAuditEventId },
          { entityType: "policy_decision", entityId: "pol_missing_http" },
        ],
      }),
    });
    assert.equal(provenanceRes.status, 200);
    const provenanceBody = await provenanceRes.json();
    assert.equal(provenanceBody.ok, true);
    assert.equal(provenanceBody.data.operation, "memory_console_provenance");
    assert.equal(provenanceBody.data.resolution.resolved, 3);
    assert.equal(
      provenanceBody.data.entities.some(
        (entity) =>
          entity.entityType === "policy_decision" &&
          entity.entityId === decisionId &&
          entity.linkedSourceIds.includes("evt-pol-http-yji6-1")
      ),
      true
    );

    const policyAuditRequest = {
      profile: "operator-yji6-http",
      outcomes: ["deny"],
      operations: ["policy_decision_update"],
      reasonCodes: ["safety-risk-http"],
      policyKey: "operator-safety-http",
      limit: 5,
    };
    const policyAuditRes = await fetch(
      `${base}/v1/memory_console_policy_audit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "tenant-yji6-http",
        },
        body: JSON.stringify(policyAuditRequest),
      }
    );
    const policyAuditReplayRes = await fetch(
      `${base}/v1/memory_console_policy_audit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "tenant-yji6-http",
        },
        body: JSON.stringify(policyAuditRequest),
      }
    );
    assert.equal(policyAuditRes.status, 200);
    assert.equal(policyAuditReplayRes.status, 200);
    const policyAuditBody = await policyAuditRes.json();
    const policyAuditReplayBody = await policyAuditReplayRes.json();
    assert.equal(policyAuditBody.ok, true);
    assert.equal(policyAuditBody.data.operation, "memory_console_policy_audit");
    assert.equal(policyAuditBody.data.totalPolicyDecisions, 1);
    assert.equal(
      policyAuditBody.data.policyDecisions[0].decisionId,
      decisionId
    );
    assert.deepEqual(
      policyAuditBody.data.policyDecisions,
      policyAuditReplayBody.data.policyDecisions
    );

    const anomalyRequest = {
      profile: "operator-yji6-http",
      since: "2026-03-01T00:00:00.000Z",
      until: "2026-03-01T23:59:59.999Z",
      windowHours: 24,
    };
    const anomalyRes = await fetch(`${base}/v1/memory_console_anomaly_alerts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-yji6-http",
      },
      body: JSON.stringify(anomalyRequest),
    });
    const anomalyReplayRes = await fetch(
      `${base}/v1/memory_console_anomaly_alerts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "tenant-yji6-http",
        },
        body: JSON.stringify(anomalyRequest),
      }
    );
    assert.equal(anomalyRes.status, 200);
    assert.equal(anomalyReplayRes.status, 200);
    const anomalyBody = await anomalyRes.json();
    const anomalyReplayBody = await anomalyReplayRes.json();
    assert.equal(anomalyBody.ok, true);
    assert.equal(anomalyBody.data.operation, "memory_console_anomaly_alerts");
    assert.deepEqual(anomalyBody.data, anomalyReplayBody.data);
    assert.equal(Array.isArray(anomalyBody.data.alerts), true);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise()
      );
    });
  }
});

test("policy_audit_export returns SERVICE_MISCONFIGURATION when signing env is missing", async () => {
  resetStore();
  const previousSecret = process.env.UMS_POLICY_AUDIT_EXPORT_SIGNING_SECRET;
  const previousKeyId = process.env.UMS_POLICY_AUDIT_EXPORT_SIGNING_KEY_ID;
  delete process.env.UMS_POLICY_AUDIT_EXPORT_SIGNING_SECRET;
  delete process.env.UMS_POLICY_AUDIT_EXPORT_SIGNING_KEY_ID;

  const { server, host, port } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const base = `http://${host}:${port}`;

  try {
    const response = await fetch(`${base}/v1/policy_audit_export`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-policy-audit-server",
      },
      body: JSON.stringify({
        profile: "policy-audit-server",
        timestamp: "2026-03-02T20:30:00.000Z",
      }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "SERVICE_MISCONFIGURATION");
    assert.equal(
      body.error.message,
      "SERVICE_MISCONFIGURATION: policy_audit_export signing secret is not configured."
    );
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise()
      );
    });
    if (previousSecret === undefined) {
      delete process.env.UMS_POLICY_AUDIT_EXPORT_SIGNING_SECRET;
    } else {
      process.env.UMS_POLICY_AUDIT_EXPORT_SIGNING_SECRET = previousSecret;
    }
    if (previousKeyId === undefined) {
      delete process.env.UMS_POLICY_AUDIT_EXPORT_SIGNING_KEY_ID;
    } else {
      process.env.UMS_POLICY_AUDIT_EXPORT_SIGNING_KEY_ID = previousKeyId;
    }
  }
});

test("ums-memory-d6q.2.4/3.4/4.4/5.4 http routes expose deterministic P3 contract handlers", async () => {
  resetStore();
  const { server, host } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const misconceptionRes = await fetch(`${base}/v1/misconception_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-p3-http",
      },
      body: JSON.stringify({
        profile: "learner-p3-http",
        misconceptionKey: "off-by-one",
        signal: "harmful",
        evidenceEventIds: ["ep-1"],
      }),
    });
    assert.equal(misconceptionRes.status, 200);
    const misconceptionBody = await misconceptionRes.json();
    assert.equal(misconceptionBody.ok, true);
    assert.equal(misconceptionBody.data.operation, "misconception_update");
    assert.equal(misconceptionBody.data.action, "created");

    const curriculumRes = await fetch(`${base}/v1/curriculum_plan_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-p3-http",
      },
      body: JSON.stringify({
        profile: "learner-p3-http",
        objectiveId: "objective-1",
        recommendationRank: 3,
        evidenceEventIds: ["ep-2"],
        provenanceSignalIds: ["sig-1"],
      }),
    });
    assert.equal(curriculumRes.status, 200);
    const curriculumBody = await curriculumRes.json();
    assert.equal(curriculumBody.ok, true);
    assert.equal(curriculumBody.data.operation, "curriculum_plan_update");
    assert.equal(curriculumBody.data.action, "created");

    const reviewRes = await fetch(`${base}/v1/review_schedule_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-p3-http",
      },
      body: JSON.stringify({
        profile: "learner-p3-http",
        targetId: "rule-xyz",
        dueAt: "2026-03-01T12:00:00.000Z",
        sourceEventIds: ["evt-1"],
      }),
    });
    assert.equal(reviewRes.status, 200);
    const reviewBody = await reviewRes.json();
    assert.equal(reviewBody.ok, true);
    assert.equal(reviewBody.data.operation, "review_schedule_update");
    assert.equal(reviewBody.data.action, "created");

    const policyRes = await fetch(`${base}/v1/policy_decision_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-p3-http",
      },
      body: JSON.stringify({
        profile: "learner-p3-http",
        policyKey: "safe-guidance",
        outcome: "deny",
        reasonCodes: ["safety-risk"],
        provenanceEventIds: ["evt-pol-1"],
      }),
    });
    assert.equal(policyRes.status, 200);
    const policyBody = await policyRes.json();
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.operation, "policy_decision_update");
    assert.equal(policyBody.data.action, "created");
    assert.equal(policyBody.data.observability.denied, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("ums-memory-d6q.1.4 http routes learner profile + identity graph updates via dynamic operations", async () => {
  resetStore();
  const { server, host } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const profileRes = await fetch(`${base}/v1/learner_profile_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http",
      },
      body: JSON.stringify({
        profile: "learner-http",
        learnerId: "learner-77",
        identityRefs: [
          {
            namespace: "email",
            value: "learner77@example.com",
            isPrimary: true,
          },
        ],
        goals: ["graph", "dp"],
        evidenceEventIds: ["ep-profile-http-1"],
      }),
    });
    assert.equal(profileRes.status, 200);
    const profileBody = await profileRes.json();
    assert.equal(profileBody.ok, true);
    assert.equal(profileBody.data.action, "created");
    assert.equal(profileBody.data.operation, "learner_profile_update");
    assert.ok(profileBody.data.profileId.startsWith("lp_"));

    const profileReplayRes = await fetch(`${base}/v1/learner_profile_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http",
      },
      body: JSON.stringify({
        profile: "learner-http",
        learnerId: "learner-77",
        identityRefs: [
          {
            namespace: "email",
            value: "learner77@example.com",
            isPrimary: true,
          },
        ],
        goals: ["dp", "graph"],
        evidenceEventIds: ["ep-profile-http-1"],
      }),
    });
    assert.equal(profileReplayRes.status, 200);
    const profileReplayBody = await profileReplayRes.json();
    assert.equal(profileReplayBody.ok, true);
    assert.equal(profileReplayBody.data.action, "noop");
    assert.equal(profileReplayBody.data.profileId, profileBody.data.profileId);

    const edgeRes = await fetch(`${base}/v1/identity_graph_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http",
      },
      body: JSON.stringify({
        profile: "learner-http",
        profileId: profileBody.data.profileId,
        relation: "misconception_of",
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-77" },
        evidenceEventIds: ["ep-2", "ep-1", "ep-1"],
      }),
    });
    assert.equal(edgeRes.status, 200);
    const edgeBody = await edgeRes.json();
    assert.equal(edgeBody.ok, true);
    assert.equal(edgeBody.data.action, "created");
    assert.equal(edgeBody.data.operation, "identity_graph_update");
    assert.ok(edgeBody.data.edgeId.startsWith("edge_"));

    const edgeReplayRes = await fetch(`${base}/v1/identity_graph_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http",
      },
      body: JSON.stringify({
        profile: "learner-http",
        profileId: profileBody.data.profileId,
        relation: "misconception_of",
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-77" },
        evidenceEventIds: ["ep-1", "ep-2"],
      }),
    });
    assert.equal(edgeReplayRes.status, 200);
    const edgeReplayBody = await edgeReplayRes.json();
    assert.equal(edgeReplayBody.ok, true);
    assert.equal(edgeReplayBody.data.action, "noop");
    assert.equal(edgeReplayBody.data.edgeId, edgeBody.data.edgeId);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("http server rejects non-object JSON payloads", async () => {
  resetStore();
  const { server, host } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const response = await fetch(`${base}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "BAD_REQUEST");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("ums-memory-d6q.1.11/ums-memory-d6q.1.9 http routes reject missing evidence pointers and expose policy exception observability", async () => {
  resetStore();
  const { server, host } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const rejectedRes = await fetch(`${base}/v1/misconception_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-guardrail",
      },
      body: JSON.stringify({
        profile: "learner-http-guardrail",
        misconceptionKey: "missing-evidence-pointer",
        signal: "harmful",
      }),
    });
    assert.equal(rejectedRes.status, 400);
    const rejectedBody = await rejectedRes.json();
    assert.equal(rejectedBody.ok, false);
    assert.equal(rejectedBody.error.code, "BAD_REQUEST");
    assert.match(rejectedBody.error.message, /evidenceeventid/i);

    const policyRes = await fetch(`${base}/v1/policy_decision_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-guardrail",
      },
      body: JSON.stringify({
        profile: "learner-http-guardrail",
        policyKey: "evidence-pointer-contract",
        outcome: "review",
        reasonCodes: ["policy-exception-evidence-pointer-waiver"],
        provenanceEventIds: ["evt-policy-waiver-http-1"],
        metadata: {
          exceptionKind: "evidence-pointer-waiver",
          ticketId: "waiver-http-1",
        },
      }),
    });
    assert.equal(policyRes.status, 200);
    const policyBody = await policyRes.json();
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.operation, "policy_decision_update");
    assert.equal(policyBody.data.decision.outcome, "review");
    assert.equal(policyBody.data.observability.denied, false);
    assert.equal(policyBody.data.observability.reasonCodeCount, 1);
    assert.equal(policyBody.data.observability.provenanceCount, 1);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("ums-memory-d6q.2.6/ums-memory-d6q.3.6/ums-memory-d6q.4.6/ums-memory-d6q.5.6 http guardrails reject invalid domain payloads", async () => {
  resetStore();
  const { server, host } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  const guardrailCases = [
    {
      operation: "misconception_update",
      payload: {
        profile: "learner-http-guardrails",
        misconceptionKey: "missing-evidence",
        signal: "harmful",
      },
      messagePattern: /evidenceeventid/i,
    },
    {
      operation: "curriculum_plan_update",
      payload: {
        profile: "learner-http-guardrails",
        objectiveId: "objective-no-evidence",
        recommendationRank: 1,
      },
      messagePattern: /evidenceeventid/i,
    },
    {
      operation: "review_schedule_update",
      payload: {
        profile: "learner-http-guardrails",
        targetId: "rule-missing-source-events",
        dueAt: "2026-03-11T00:00:00.000Z",
      },
      messagePattern: /sourceeventid/i,
    },
    {
      operation: "policy_decision_update",
      payload: {
        profile: "learner-http-guardrails",
        policyKey: "deny-without-reasons",
        outcome: "deny",
        provenanceEventIds: ["evt-pol-guardrail-1"],
      },
      messagePattern: /reasoncodes/i,
    },
  ];

  try {
    for (const entry of guardrailCases) {
      const response = await fetch(`${base}/v1/${entry.operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "tenant-http-guardrails",
        },
        body: JSON.stringify(entry.payload),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "BAD_REQUEST");
      assert.match(body.error.message, entry.messagePattern);
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("ums-memory-d6q.2.7/ums-memory-d6q.2.9/ums-memory-d6q.3.7/ums-memory-d6q.3.9/ums-memory-d6q.4.7/ums-memory-d6q.4.9/ums-memory-d6q.5.7/ums-memory-d6q.5.9 http domain operations return positive observability payloads", async () => {
  resetStore();
  const { server, host } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const misconceptionRes = await fetch(`${base}/v1/misconception_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-positive",
      },
      body: JSON.stringify({
        profile: "learner-http-positive",
        misconceptionKey: "boundary-check",
        signal: "harmful",
        signalId: "sig-http-1",
        evidenceEventIds: ["evt-http-m-1", "evt-http-m-2"],
      }),
    });
    assert.equal(misconceptionRes.status, 200);
    const misconceptionBody = await misconceptionRes.json();
    assert.equal(misconceptionBody.ok, true);
    assert.equal(misconceptionBody.data.action, "created");
    assert.equal(misconceptionBody.data.observability.evidenceCount, 2);
    assert.equal(misconceptionBody.data.observability.signalCount, 1);
    assert.equal(misconceptionBody.data.deterministic, true);
    assert.ok(misconceptionBody.data.requestDigest.length > 10);

    const curriculumRes = await fetch(`${base}/v1/curriculum_plan_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-positive",
      },
      body: JSON.stringify({
        profile: "learner-http-positive",
        objectiveId: "objective-http-positive",
        recommendationRank: 2,
        evidenceEventIds: ["evt-http-c-1"],
        provenanceSignalIds: ["sig-http-1", "sig-http-2"],
      }),
    });
    assert.equal(curriculumRes.status, 200);
    const curriculumBody = await curriculumRes.json();
    assert.equal(curriculumBody.ok, true);
    assert.equal(curriculumBody.data.action, "created");
    assert.equal(curriculumBody.data.observability.evidenceCount, 1);
    assert.equal(curriculumBody.data.observability.provenanceCount, 2);
    assert.equal(
      curriculumBody.data.observability.boundedRecommendationRank,
      2
    );
    assert.equal(curriculumBody.data.deterministic, true);
    assert.ok(curriculumBody.data.requestDigest.length > 10);

    const reviewRes = await fetch(`${base}/v1/review_schedule_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-positive",
      },
      body: JSON.stringify({
        profile: "learner-http-positive",
        targetId: "rule-http-positive",
        dueAt: "2026-03-12T00:00:00.000Z",
        sourceEventIds: ["evt-http-r-1", "evt-http-r-2"],
      }),
    });
    assert.equal(reviewRes.status, 200);
    const reviewBody = await reviewRes.json();
    assert.equal(reviewBody.ok, true);
    assert.equal(reviewBody.data.action, "created");
    assert.equal(
      reviewBody.data.observability.dueAt,
      "2026-03-12T00:00:00.000Z"
    );
    assert.equal(reviewBody.data.observability.sourceEventCount, 2);
    assert.equal(reviewBody.data.observability.storeIsolationEnforced, true);
    assert.equal(reviewBody.data.deterministic, true);
    assert.ok(reviewBody.data.requestDigest.length > 10);

    const policyRes = await fetch(`${base}/v1/policy_decision_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-positive",
      },
      body: JSON.stringify({
        profile: "learner-http-positive",
        policyKey: "policy-http-positive",
        outcome: "deny",
        reasonCodes: ["safety-risk"],
        provenanceEventIds: ["evt-http-p-1"],
      }),
    });
    assert.equal(policyRes.status, 200);
    const policyBody = await policyRes.json();
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.action, "created");
    assert.equal(policyBody.data.observability.denied, true);
    assert.equal(policyBody.data.observability.reasonCodeCount, 1);
    assert.equal(policyBody.data.observability.provenanceCount, 1);
    assert.equal(policyBody.data.deterministic, true);
    assert.ok(policyBody.data.requestDigest.length > 10);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("ums-memory-d6q.3.11/ums-memory-d6q.4.11/ums-memory-d6q.4.12/ums-memory-d6q.5.11/ums-memory-d6q.5.12/ums-memory-d6q.5.13/ums-memory-d6q.5.14 http routes preserve explanation, scheduler, and security payload paths", async () => {
  resetStore();
  const { server, host } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const curriculumRes = await fetch(`${base}/v1/curriculum_plan_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-features",
      },
      body: JSON.stringify({
        profile: "learner-http-features",
        objectiveId: "objective-http-explainable",
        recommendationRank: 2,
        evidenceEventIds: ["evt-http-cur-2", "evt-http-cur-1"],
        provenanceSignalIds: ["sig-http-cur-2", "sig-http-cur-1"],
        metadata: {
          explanation: {
            summary:
              "Deterministic recommendation with evidence-backed rationale.",
            rationaleSteps: ["normalize pointers", "rank by urgency"],
          },
        },
      }),
    });
    assert.equal(curriculumRes.status, 200);
    const curriculumBody = await curriculumRes.json();
    assert.equal(curriculumBody.ok, true);
    assert.equal(curriculumBody.data.action, "created");
    assert.equal(
      curriculumBody.data.planItem.metadata.explanation.summary,
      "Deterministic recommendation with evidence-backed rationale."
    );

    const curriculumReplayRes = await fetch(
      `${base}/v1/curriculum_plan_update`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "tenant-http-features",
        },
        body: JSON.stringify({
          profile: "learner-http-features",
          objectiveId: "objective-http-explainable",
          recommendationRank: 2,
          evidenceEventIds: ["evt-http-cur-1", "evt-http-cur-2"],
          provenanceSignalIds: ["sig-http-cur-1", "sig-http-cur-2"],
          metadata: {
            explanation: {
              summary:
                "Deterministic recommendation with evidence-backed rationale.",
              rationaleSteps: ["normalize pointers", "rank by urgency"],
            },
          },
        }),
      }
    );
    assert.equal(curriculumReplayRes.status, 200);
    const curriculumReplayBody = await curriculumReplayRes.json();
    assert.equal(curriculumReplayBody.ok, true);
    assert.equal(curriculumReplayBody.data.action, "noop");
    assert.equal(
      curriculumReplayBody.data.observability.boundedRecommendationRank,
      2
    );

    const reviewRes = await fetch(`${base}/v1/review_schedule_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-features",
      },
      body: JSON.stringify({
        profile: "learner-http-features",
        targetId: "rule-http-clocks",
        dueAt: "2026-03-25T00:00:00.000Z",
        sourceEventIds: ["evt-http-srs-2", "evt-http-srs-1"],
        metadata: {
          interactionClock: {
            tick: 7,
            lastInteractionAt: "2026-03-24T23:40:00.000Z",
          },
          sleepClock: {
            window: "nightly",
            nextConsolidationAt: "2026-03-25T03:30:00.000Z",
          },
          archive: { tier: "warm", tiers: ["hot", "warm", "cold"] },
        },
      }),
    });
    assert.equal(reviewRes.status, 200);
    const reviewBody = await reviewRes.json();
    assert.equal(reviewBody.ok, true);
    assert.equal(reviewBody.data.action, "created");
    assert.equal(
      reviewBody.data.scheduleEntry.metadata.interactionClock.tick,
      7
    );
    assert.equal(reviewBody.data.scheduleEntry.metadata.archive.tier, "warm");

    const reviewReplayRes = await fetch(`${base}/v1/review_schedule_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-features",
      },
      body: JSON.stringify({
        profile: "learner-http-features",
        targetId: "rule-http-clocks",
        dueAt: "2026-03-25T00:00:00.000Z",
        sourceEventIds: ["evt-http-srs-1", "evt-http-srs-2"],
        metadata: {
          interactionClock: {
            tick: 7,
            lastInteractionAt: "2026-03-24T23:40:00.000Z",
          },
          sleepClock: {
            window: "nightly",
            nextConsolidationAt: "2026-03-25T03:30:00.000Z",
          },
          archive: { tier: "warm", tiers: ["hot", "warm", "cold"] },
        },
      }),
    });
    assert.equal(reviewReplayRes.status, 200);
    const reviewReplayBody = await reviewReplayRes.json();
    assert.equal(reviewReplayBody.ok, true);
    assert.equal(reviewReplayBody.data.action, "noop");
    assert.equal(reviewReplayBody.data.observability.sourceEventCount, 2);

    const policyRes = await fetch(`${base}/v1/policy_decision_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-features",
      },
      body: JSON.stringify({
        profile: "learner-http-features",
        policyKey: "policy-http-security",
        outcome: "deny",
        reasonCodes: ["allowlist-denied", "prompt-injection-detected"],
        provenanceEventIds: ["evt-http-pol-2", "evt-http-pol-1"],
        metadata: {
          security: { promptInjectionDetected: true, quarantined: true },
          allowlist: {
            requestedSpace: "space-b",
            allowedSpaces: ["space-a"],
            authorized: false,
          },
          degraded: {
            enabled: true,
            reason: "llm_unavailable",
            capabilities: { llm: false, index: false },
          },
          audit: {
            decisionTraceId: "trace-http-pol-1",
            checklist: ["incident-response", "rollback"],
          },
        },
      }),
    });
    assert.equal(policyRes.status, 200);
    const policyBody = await policyRes.json();
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.action, "created");
    assert.equal(policyBody.data.observability.denied, true);
    assert.equal(policyBody.data.decision.metadata.security.quarantined, true);
    assert.equal(policyBody.data.decision.metadata.allowlist.authorized, false);
    assert.equal(policyBody.data.decision.metadata.degraded.enabled, true);
    assert.deepEqual(policyBody.data.decision.metadata.audit.checklist, [
      "incident-response",
      "rollback",
    ]);

    const policyReplayRes = await fetch(`${base}/v1/policy_decision_update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-features",
      },
      body: JSON.stringify({
        profile: "learner-http-features",
        policyKey: "policy-http-security",
        outcome: "deny",
        reasonCodes: ["prompt-injection-detected", "allowlist-denied"],
        provenanceEventIds: ["evt-http-pol-1", "evt-http-pol-2"],
        metadata: {
          security: { promptInjectionDetected: true, quarantined: true },
          allowlist: {
            requestedSpace: "space-b",
            allowedSpaces: ["space-a"],
            authorized: false,
          },
          degraded: {
            enabled: true,
            reason: "llm_unavailable",
            capabilities: { llm: false, index: false },
          },
          audit: {
            decisionTraceId: "trace-http-pol-1",
            checklist: ["incident-response", "rollback"],
          },
        },
      }),
    });
    assert.equal(policyReplayRes.status, 200);
    const policyReplayBody = await policyReplayRes.json();
    assert.equal(policyReplayBody.ok, true);
    assert.equal(policyReplayBody.data.action, "noop");
    assert.equal(policyReplayBody.data.observability.reasonCodeCount, 2);
    assert.equal(policyReplayBody.data.observability.provenanceCount, 2);

    const auditRes = await fetch(`${base}/v1/audit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-http-features",
      },
      body: JSON.stringify({ profile: "learner-http-features" }),
    });
    assert.equal(auditRes.status, 200);
    const auditBody = await auditRes.json();
    assert.equal(auditBody.ok, true);
    assert.equal(auditBody.data.operation, "audit");
    assert.ok(
      auditBody.data.checks.some((check) => check.name === "duplicate_rules")
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("api and cli share persisted state file across restart boundaries", async () => {
  resetStore();
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-shared-state-"));
  const stateFile = resolve(tempDir, "ums-state.json");

  try {
    const cliIngest = await runCli([
      "ingest",
      "--state-file",
      stateFile,
      "--store-id",
      "coding-agent",
      "--input",
      JSON.stringify({
        profile: "shared-profile",
        events: [{ type: "note", source: "cli", content: "event-from-cli" }],
      }),
    ]);
    assert.equal(cliIngest.code, 0);

    const firstServer = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      stateFile,
    });
    const firstAddress = firstServer.server.address();
    assert.ok(firstAddress && typeof firstAddress === "object");
    const firstBase = `http://${firstServer.host}:${firstAddress.port}`;

    try {
      const contextRes = await fetch(`${firstBase}/v1/context`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "coding-agent",
        },
        body: JSON.stringify({
          profile: "shared-profile",
          query: "event-from-cli",
        }),
      });
      assert.equal(contextRes.status, 200);
      const contextBody = await contextRes.json();
      assert.equal(contextBody.ok, true);
      assert.equal(contextBody.data.matches.length, 1);

      const apiIngestRes = await fetch(`${firstBase}/v1/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "coding-agent",
        },
        body: JSON.stringify({
          profile: "shared-profile",
          events: [{ type: "note", source: "api", content: "event-from-api" }],
        }),
      });
      assert.equal(apiIngestRes.status, 200);
      const apiIngestBody = await apiIngestRes.json();
      assert.equal(apiIngestBody.ok, true);
      assert.equal(apiIngestBody.data.accepted, 1);
    } finally {
      await new Promise((resolvePromise, rejectPromise) => {
        firstServer.server.close((error) =>
          error ? rejectPromise(error) : resolvePromise()
        );
      });
    }

    const secondServer = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      stateFile,
    });
    const secondAddress = secondServer.server.address();
    assert.ok(secondAddress && typeof secondAddress === "object");
    const secondBase = `http://${secondServer.host}:${secondAddress.port}`;
    try {
      const contextAfterRestart = await fetch(`${secondBase}/v1/context`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "coding-agent",
        },
        body: JSON.stringify({
          profile: "shared-profile",
          query: "event-from-api",
        }),
      });
      assert.equal(contextAfterRestart.status, 200);
      const restartBody = await contextAfterRestart.json();
      assert.equal(restartBody.ok, true);
      assert.equal(restartBody.data.matches.length, 1);
    } finally {
      await new Promise((resolvePromise, rejectPromise) => {
        secondServer.server.close((error) =>
          error ? rejectPromise(error) : resolvePromise()
        );
      });
    }

    const cliContext = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--store-id",
      "coding-agent",
      "--input",
      JSON.stringify({
        profile: "shared-profile",
        query: "event-from-api",
      }),
    ]);
    assert.equal(cliContext.code, 0);
    const cliContextBody = JSON.parse(cliContext.stdout);
    assert.equal(cliContextBody.ok, true);
    assert.equal(cliContextBody.data.matches.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
