import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const REQUIRED_FND_HEADINGS = Object.freeze([
  "## FND-01 Scope Matrix for Operating Modes",
  "## FND-02 Licensing and Clean-Room Decision Record",
  "## FND-03 Data Classification and Residency Policy",
  "## FND-04 Threat Model for Ingestion, Retrieval, and Optimization",
  "## FND-05 System Topology and Environment Boundaries",
  "## FND-06 Tenancy Identity Model",
  "## FND-07 Engineering Ownership and Runbook Responsibilities",
  "## FND-08 Acceptance Criteria Catalog for Major Phases",
  "## FND-09 Architecture ADR Bundle and Review Checklist",
  "## FND-10 Architecture Sign-Off Gate (Go/No-Go)",
]);

const REQUIRED_FND_IDS = Object.freeze([
  "ums-memory-0d2.1",
  "ums-memory-0d2.2",
  "ums-memory-0d2.3",
  "ums-memory-0d2.4",
  "ums-memory-0d2.5",
  "ums-memory-0d2.6",
  "ums-memory-0d2.7",
  "ums-memory-0d2.8",
  "ums-memory-0d2.9",
  "ums-memory-0d2.10",
]);

test("phase0 runbook maps all FND sections and go/no-go controls", () => {
  const runbookPath = new URL(
    "../../docs/runbooks/phase0-ums-memory-foundations.md",
    import.meta.url
  );
  const runbook = readFileSync(runbookPath, "utf8");

  for (const heading of REQUIRED_FND_HEADINGS) {
    assert.match(
      runbook,
      new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  }

  assert.match(runbook, /single-user/i);
  assert.match(runbook, /enterprise multi-tenant/i);
  assert.match(runbook, /org -> tenant -> project -> workspace -> user/i);
  assert.match(runbook, /acceptance criteria catalog/i);
  assert.match(runbook, /go\/no-go/i);
  assert.match(runbook, /Decision:\s*`GO`/i);
  assert.match(runbook, /unresolved risks and remediation owners/i);
  assert.match(
    runbook,
    /docs\/adr\/0001-phase1-phase2-baseline-constraints\.md/i
  );
  assert.match(
    runbook,
    /docs\/adr\/0007-phase0-governance-architecture-baseline\.md/i
  );
  assert.match(
    runbook,
    /release-entry criteria: deterministic test gates green/i
  );
  assert.match(
    runbook,
    /Any unresolved high-severity risk without owner and mitigation changes decision to `NO-GO`\./i
  );
  assert.match(runbook, /`ums-memory-509`/i);
});

test("ADR-0007 captures phase0 governance constraints and bead scope map", () => {
  const adrPath = new URL(
    "../../docs/adr/0007-phase0-governance-architecture-baseline.md",
    import.meta.url
  );
  const adr = readFileSync(adrPath, "utf8");

  assert.match(adr, /^# ADR-0007:/m);
  assert.match(adr, /^Date:/m);
  assert.match(adr, /^Status:\s*Accepted/m);
  assert.match(adr, /^## Context$/m);
  assert.match(adr, /^## Decision$/m);
  assert.match(adr, /^## Scope$/m);
  assert.match(adr, /^## Consequences$/m);

  assert.match(adr, /backend-only/i);
  assert.match(adr, /clean-room/i);
  assert.match(adr, /policy guardrails/i);
  assert.match(adr, /deterministic\/idempotent/i);
  assert.match(adr, /out of scope per ADR-0001/i);
  assert.match(adr, /No frontend screens or policy UIs/i);

  for (const beadId of REQUIRED_FND_IDS) {
    assert.match(adr, new RegExp(`\\b${beadId.replaceAll(".", "\\.")}\\b`));
  }
});
