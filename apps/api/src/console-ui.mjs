export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>UMS Memory Console</title>
    <link rel="stylesheet" href="/console.css">
  </head>
  <body>
    <main class="console-app">
      <header class="console-header">
        <h1>UMS Memory Console</h1>
        <p>Inspect memory state and execute deterministic operator workflows.</p>
      </header>

      <section class="panel">
        <h2>Request Context</h2>
        <div class="field-grid field-grid-two">
          <label>
            Store ID
            <input id="console-store" name="storeId" type="text" value="coding-agent" autocomplete="off">
          </label>
          <label>
            Profile
            <input id="console-profile" name="profile" type="text" value="operator-console" autocomplete="off">
          </label>
        </div>
      </section>

      <section class="panel">
        <h2>Inspect / Filter</h2>
        <div class="operation-grid">
          <form class="operation-card operation-form" data-operation="memory_console_search">
            <h3>memory_console_search</h3>
            <div class="field-grid">
              <label>
                Query
                <input name="query" type="text" placeholder="timeline-gap" autocomplete="off">
              </label>
              <label>
                Types (comma-separated)
                <input
                  name="types"
                  type="text"
                  placeholder="misconception,policy_decision"
                  autocomplete="off"
                >
              </label>
              <label>
                Limit
                <input name="limit" type="number" min="1" step="1" value="25">
              </label>
            </div>
            <div class="card-actions">
              <button type="submit">Run Operation</button>
              <p class="request-status" data-role="status" data-tone="idle">Idle</p>
            </div>
            <pre data-role="output">{}</pre>
          </form>

          <form class="operation-card operation-form" data-operation="memory_console_timeline">
            <h3>memory_console_timeline</h3>
            <div class="field-grid">
              <label>
                Types (comma-separated)
                <input
                  name="types"
                  type="text"
                  placeholder="policy_decision,policy_audit_event"
                  autocomplete="off"
                >
              </label>
              <label>
                Since (ISO-8601)
                <input name="since" type="text" placeholder="2026-03-01T00:00:00.000Z" autocomplete="off">
              </label>
              <label>
                Until (ISO-8601)
                <input name="until" type="text" placeholder="2026-03-01T23:59:59.999Z" autocomplete="off">
              </label>
              <label>
                Limit
                <input name="limit" type="number" min="1" step="1" value="25">
              </label>
            </div>
            <div class="card-actions">
              <button type="submit">Run Operation</button>
              <p class="request-status" data-role="status" data-tone="idle">Idle</p>
            </div>
            <pre data-role="output">{}</pre>
          </form>

          <form class="operation-card operation-form" data-operation="memory_console_provenance">
            <h3>memory_console_provenance</h3>
            <div class="field-grid">
              <label>
                Entity Refs (JSON array)
                <textarea name="entityRefs" rows="5">[
  { "entityType": "policy_decision", "entityId": "pol_example_1" }
]</textarea>
              </label>
              <label>
                Limit
                <input name="limit" type="number" min="1" step="1" value="100">
              </label>
            </div>
            <div class="card-actions">
              <button type="submit">Run Operation</button>
              <p class="request-status" data-role="status" data-tone="idle">Idle</p>
            </div>
            <pre data-role="output">{}</pre>
          </form>

          <form class="operation-card operation-form" data-operation="memory_console_policy_audit">
            <h3>memory_console_policy_audit</h3>
            <div class="field-grid">
              <label>
                Outcomes (comma-separated)
                <input name="outcomes" type="text" placeholder="deny,review" autocomplete="off">
              </label>
              <label>
                Operations (comma-separated)
                <input name="operations" type="text" placeholder="policy_decision_update" autocomplete="off">
              </label>
              <label>
                Reason Codes (comma-separated)
                <input name="reasonCodes" type="text" placeholder="safety-risk-http" autocomplete="off">
              </label>
              <label>
                Policy Key
                <input name="policyKey" type="text" placeholder="operator-safety-http" autocomplete="off">
              </label>
              <label>
                Since (ISO-8601)
                <input name="since" type="text" placeholder="2026-03-01T00:00:00.000Z" autocomplete="off">
              </label>
              <label>
                Until (ISO-8601)
                <input name="until" type="text" placeholder="2026-03-01T23:59:59.999Z" autocomplete="off">
              </label>
              <label>
                Limit
                <input name="limit" type="number" min="1" step="1" value="25">
              </label>
            </div>
            <div class="card-actions">
              <button type="submit">Run Operation</button>
              <p class="request-status" data-role="status" data-tone="idle">Idle</p>
            </div>
            <pre data-role="output">{}</pre>
          </form>

          <form class="operation-card operation-form" data-operation="memory_console_anomaly_alerts">
            <h3>memory_console_anomaly_alerts</h3>
            <div class="field-grid">
              <label>
                Since (ISO-8601)
                <input name="since" type="text" placeholder="2026-03-01T00:00:00.000Z" autocomplete="off">
              </label>
              <label>
                Until (ISO-8601)
                <input name="until" type="text" placeholder="2026-03-01T23:59:59.999Z" autocomplete="off">
              </label>
              <label>
                Window Hours
                <input name="windowHours" type="number" min="1" step="1" value="24">
              </label>
            </div>
            <div class="card-actions">
              <button type="submit">Run Operation</button>
              <p class="request-status" data-role="status" data-tone="idle">Idle</p>
            </div>
            <pre data-role="output">{}</pre>
          </form>
        </div>
      </section>

      <section class="panel">
        <h2>Manage Action</h2>
        <form class="operation-card operation-form" data-operation="manual_quarantine_override">
          <h3>manual_quarantine_override</h3>
          <div class="field-grid">
            <label>
              Action
              <select name="action">
                <option value="suppress" selected>suppress</option>
                <option value="promote">promote</option>
              </select>
            </label>
            <label>
              Actor
              <input name="actor" type="text" value="console-operator" autocomplete="off" required>
            </label>
            <label>
              Override Control ID (optional)
              <input name="overrideControlId" type="text" placeholder="movr-console-1" autocomplete="off">
            </label>
            <label>
              Reason Codes (comma-separated)
              <input name="reasonCodes" type="text" value="console_manual_override" autocomplete="off">
            </label>
            <label>
              Reason (optional)
              <input name="reason" type="text" placeholder="Operator initiated override." autocomplete="off">
            </label>
            <label>
              Target Candidate IDs (comma-separated)
              <input name="targetCandidateIds" type="text" placeholder="cand_123" autocomplete="off">
            </label>
            <label>
              Target Rule IDs (comma-separated)
              <input name="targetRuleIds" type="text" placeholder="rule_123" autocomplete="off">
            </label>
            <label>
              Evidence Event IDs (comma-separated)
              <input name="evidenceEventIds" type="text" placeholder="evt_console_evidence_1" autocomplete="off">
            </label>
            <label>
              Source Event IDs (comma-separated)
              <input name="sourceEventIds" type="text" placeholder="evt_console_source_1" autocomplete="off">
            </label>
            <label>
              Timestamp (optional ISO-8601)
              <input name="timestamp" type="text" placeholder="2026-03-02T22:00:00.000Z" autocomplete="off">
            </label>
          </div>
          <div class="card-actions">
            <button type="submit">Run Operation</button>
            <p class="request-status" data-role="status" data-tone="idle">Idle</p>
          </div>
          <pre data-role="output">{}</pre>
        </form>
      </section>
    </main>
    <script type="module" src="/console.js"></script>
  </body>
</html>
`;

export const CONSOLE_CSS = `:root {
  color-scheme: light;
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", serif;
  --bg: #f2f5f0;
  --panel: #ffffff;
  --border: #cdd8c5;
  --text: #1f2d1d;
  --muted: #4b5f4a;
  --accent: #2f6f4f;
  --danger: #b43737;
  --shadow: 0 8px 24px rgba(23, 43, 30, 0.08);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background:
    radial-gradient(circle at 20% 0%, rgba(92, 145, 110, 0.15), transparent 38%),
    radial-gradient(circle at 100% 10%, rgba(190, 220, 175, 0.2), transparent 42%),
    var(--bg);
  color: var(--text);
}

.console-app {
  margin: 0 auto;
  max-width: 1200px;
  padding: 28px 18px 40px;
}

.console-header {
  margin-bottom: 16px;
}

.console-header h1 {
  margin: 0;
  font-size: clamp(1.6rem, 2.4vw, 2.3rem);
  letter-spacing: 0.01em;
}

.console-header p {
  margin: 8px 0 0;
  color: var(--muted);
}

.panel {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel);
  box-shadow: var(--shadow);
  padding: 16px;
}

.panel h2 {
  margin: 0 0 12px;
  font-size: 1.15rem;
}

.operation-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}

.operation-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
  background: #f8fbf6;
}

.operation-card h3 {
  margin: 0 0 10px;
  font-size: 0.96rem;
  font-family: "Courier New", Courier, monospace;
}

.field-grid {
  display: grid;
  gap: 8px;
}

.field-grid-two {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

label {
  display: grid;
  gap: 4px;
  font-size: 0.85rem;
  color: var(--muted);
}

input,
select,
textarea,
button {
  font: inherit;
}

input,
select,
textarea {
  width: 100%;
  border: 1px solid #b9c7b1;
  border-radius: 8px;
  background: #fff;
  color: var(--text);
  padding: 6px 8px;
}

textarea {
  min-height: 96px;
  resize: vertical;
  font-family: "Courier New", Courier, monospace;
  line-height: 1.4;
}

button {
  border: 1px solid #245a3f;
  border-radius: 9px;
  background: linear-gradient(180deg, #397d5a, #2f6f4f);
  color: #fff;
  cursor: pointer;
  font-weight: 700;
  padding: 7px 12px;
}

button:hover {
  filter: brightness(1.04);
}

.card-actions {
  align-items: center;
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.request-status {
  margin: 0;
  font-size: 0.8rem;
  font-family: "Courier New", Courier, monospace;
}

.request-status[data-tone="idle"] {
  color: var(--muted);
}

.request-status[data-tone="running"] {
  color: #2a5780;
}

.request-status[data-tone="success"] {
  color: var(--accent);
}

.request-status[data-tone="error"] {
  color: var(--danger);
}

pre {
  margin: 10px 0 0;
  border: 1px solid #d6dfd1;
  border-radius: 8px;
  background: #fff;
  font-family: "Courier New", Courier, monospace;
  font-size: 0.76rem;
  line-height: 1.4;
  max-height: 260px;
  min-height: 64px;
  overflow: auto;
  padding: 8px;
}

@media (max-width: 720px) {
  .console-app {
    padding: 18px 12px 32px;
  }
}
`;

export const CONSOLE_JS = `const API_PREFIX = "/v1";
const DEFAULT_PROFILE = "operator-console";

const storeInput = document.querySelector("#console-store");
const profileInput = document.querySelector("#console-profile");
const forms = Array.from(document.querySelectorAll("form.operation-form"));

function getFieldValue(form, name) {
  const field = form.elements.namedItem(name);
  if (!field || typeof field.value !== "string") {
    return "";
  }
  return field.value;
}

function trimFieldValue(form, name) {
  return getFieldValue(form, name).trim();
}

function parseCsvList(raw) {
  if (!raw) {
    return [];
  }
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(values)];
}

function parsePositiveInteger(raw, label) {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(label + " must be a positive integer.");
  }
  return parsed;
}

function parseEntityRefs(raw) {
  const source = raw.trim();
  if (!source) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Entity Refs must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Entity Refs must be a JSON array.");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Entity Refs entry " + index + " must be an object.");
    }
    const entityType = typeof entry.entityType === "string" ? entry.entityType.trim() : "";
    const entityId = typeof entry.entityId === "string" ? entry.entityId.trim() : "";
    if (!entityType || !entityId) {
      throw new Error("Entity Refs entry " + index + " requires entityType and entityId.");
    }
    return { entityType, entityId };
  });
}

function addList(payload, key, raw) {
  const values = parseCsvList(raw);
  if (values.length > 0) {
    payload[key] = values;
  }
}

function addString(payload, key, raw) {
  const value = raw.trim();
  if (value) {
    payload[key] = value;
  }
}

function addInteger(payload, key, raw, label) {
  const value = parsePositiveInteger(raw, label);
  if (value !== null) {
    payload[key] = value;
  }
}

function buildBasePayload() {
  const profile = profileInput && typeof profileInput.value === "string" ? profileInput.value.trim() : "";
  return { profile: profile || DEFAULT_PROFILE };
}

function buildSearchPayload(form) {
  const payload = buildBasePayload();
  addString(payload, "query", getFieldValue(form, "query"));
  addList(payload, "types", getFieldValue(form, "types"));
  addInteger(payload, "limit", getFieldValue(form, "limit"), "Search limit");
  return payload;
}

function buildTimelinePayload(form) {
  const payload = buildBasePayload();
  addList(payload, "types", getFieldValue(form, "types"));
  addString(payload, "since", getFieldValue(form, "since"));
  addString(payload, "until", getFieldValue(form, "until"));
  addInteger(payload, "limit", getFieldValue(form, "limit"), "Timeline limit");
  return payload;
}

function buildProvenancePayload(form) {
  const payload = buildBasePayload();
  const refs = parseEntityRefs(getFieldValue(form, "entityRefs"));
  if (refs.length > 0) {
    payload.entityRefs = refs;
  }
  addInteger(payload, "limit", getFieldValue(form, "limit"), "Provenance limit");
  return payload;
}

function buildPolicyAuditPayload(form) {
  const payload = buildBasePayload();
  addList(payload, "outcomes", getFieldValue(form, "outcomes"));
  addList(payload, "operations", getFieldValue(form, "operations"));
  addList(payload, "reasonCodes", getFieldValue(form, "reasonCodes"));
  addString(payload, "policyKey", getFieldValue(form, "policyKey"));
  addString(payload, "since", getFieldValue(form, "since"));
  addString(payload, "until", getFieldValue(form, "until"));
  addInteger(payload, "limit", getFieldValue(form, "limit"), "Policy audit limit");
  return payload;
}

function buildAnomalyPayload(form) {
  const payload = buildBasePayload();
  addString(payload, "since", getFieldValue(form, "since"));
  addString(payload, "until", getFieldValue(form, "until"));
  addInteger(payload, "windowHours", getFieldValue(form, "windowHours"), "Window hours");
  return payload;
}

function buildManualOverridePayload(form) {
  const payload = buildBasePayload();
  const action = trimFieldValue(form, "action").toLowerCase();
  if (action) {
    payload.action = action;
  }
  payload.actor = trimFieldValue(form, "actor");
  if (!payload.actor) {
    throw new Error("Actor is required.");
  }
  addString(payload, "overrideControlId", getFieldValue(form, "overrideControlId"));
  const reason = trimFieldValue(form, "reason");
  if (reason) {
    payload.reason = reason;
  }
  addList(payload, "reasonCodes", getFieldValue(form, "reasonCodes"));
  addList(payload, "targetCandidateIds", getFieldValue(form, "targetCandidateIds"));
  addList(payload, "targetRuleIds", getFieldValue(form, "targetRuleIds"));
  addList(payload, "evidenceEventIds", getFieldValue(form, "evidenceEventIds"));
  addList(payload, "sourceEventIds", getFieldValue(form, "sourceEventIds"));
  addString(payload, "timestamp", getFieldValue(form, "timestamp"));

  const hasTarget =
    Array.isArray(payload.targetCandidateIds) && payload.targetCandidateIds.length > 0;
  const hasRuleTarget = Array.isArray(payload.targetRuleIds) && payload.targetRuleIds.length > 0;
  if (!hasTarget && !hasRuleTarget) {
    throw new Error("At least one targetCandidateId or targetRuleId is required.");
  }
  const hasReasonCodes = Array.isArray(payload.reasonCodes) && payload.reasonCodes.length > 0;
  if (!hasReasonCodes && !payload.reason) {
    throw new Error("Provide reasonCodes or reason.");
  }
  return payload;
}

const payloadBuilders = Object.freeze({
  memory_console_search: buildSearchPayload,
  memory_console_timeline: buildTimelinePayload,
  memory_console_provenance: buildProvenancePayload,
  memory_console_policy_audit: buildPolicyAuditPayload,
  memory_console_anomaly_alerts: buildAnomalyPayload,
  manual_quarantine_override: buildManualOverridePayload,
});

async function postOperation(operation, payload) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const storeId = storeInput && typeof storeInput.value === "string" ? storeInput.value.trim() : "";
  if (storeId) {
    headers["x-ums-store"] = storeId;
  }
  const response = await fetch(API_PREFIX + "/" + operation, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { raw };
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function setStatus(statusNode, tone, text) {
  statusNode.dataset.tone = tone;
  statusNode.textContent = text;
}

function setOutput(outputNode, value) {
  outputNode.textContent = JSON.stringify(value, null, 2);
}

async function runOperation(form) {
  const operation = form.dataset.operation;
  const statusNode = form.querySelector('[data-role="status"]');
  const outputNode = form.querySelector('[data-role="output"]');
  if (!operation || !statusNode || !outputNode) {
    return;
  }
  const buildPayload = payloadBuilders[operation];
  if (typeof buildPayload !== "function") {
    setStatus(statusNode, "error", "Unsupported operation.");
    return;
  }

  setStatus(statusNode, "running", "Running...");
  try {
    const payload = buildPayload(form);
    const response = await postOperation(operation, payload);
    setStatus(statusNode, response.ok ? "success" : "error", "HTTP " + response.status);
    setOutput(outputNode, {
      operation,
      payload,
      response: response.body,
      status: response.status,
    });
  } catch (error) {
    setStatus(statusNode, "error", "Validation error");
    setOutput(outputNode, {
      operation,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

for (const form of forms) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runOperation(form);
  });
}
`;
