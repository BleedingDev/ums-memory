# Phase P3 Personalization Operational & Observability Checklist

This runbook captures the minimum documentation and telemetry expectations tied to the Phase P3 ADRs so that backend teams can satisfy the acceptance criteria referenced by the `ums-memory-d6q` beads. It leans on the baseline constraints from `ADR-0001` (backend-only/local-first/security/determinism/bounded recall/observability) and lists the concrete operational touchpoints for the highlighted beads.

See also:
- `docs/adr/0002-p3-learner-profile-identity-graph-scope.md`
- `docs/adr/0003-p3-misconception-tracking-scope.md`
- `docs/adr/0004-p3-curriculum-planner-scope.md`
- `docs/adr/0005-p3-spaced-repetition-scope.md`
- `docs/adr/0006-p3-personalization-safety-scope.md`
- `mcp_agent_mail/docs/observability.md` (log shipping + Loki/Prometheus guidance)

## Learner profile + identity graph hardening (`ums-memory-d6q.1.10/.1.11/.1.12/.1.13/.1.9`)

- **`ums-memory-d6q.1.10` – Learner-profile runbook hardening backlog completion notes**
  - Checklist:
    - [ ] Closure notes explicitly reference completed dependency beads (`.1.7/.1.8/.1.9/.1.11/.1.12/.1.13`) and the validation evidence used to close each item.
    - [ ] Remaining hardening gaps are captured as discrete backlog entries with owner, severity, due milestone, and rollback impact.
    - [ ] Runbook callouts for replay determinism, evidence-pointer enforcement, chronology/timeline behavior, and normalization drift are verified as current.
  - Expected artifacts:
    - [ ] Hardening backlog snapshot (`owner`, `risk`, `status`, `next bead`) exported as Markdown/CSV and attached to the bead timeline.
    - [ ] Closure comment linking this runbook section plus the latest test/observability evidence bundle.
    - [ ] Follow-up bead IDs for any open hardening items (no unresolved TODO text without a tracking ID).

- **`ums-memory-d6q.1.11` – Evidence-pointer contract for `learner_profile_update`**
  - Rule: every mutation must include at least one evidence pointer (`evidenceEventIds[]` or `evidenceEpisodeIds[]`) or an explicit `metadata.policyException`.
  - Reject missing evidence + missing exception with deterministic error semantics (`400`, `BAD_REQUEST`, stable message).
  - Contract examples for API/CLI/MCP must include success, policy-exception, and rejection cases.

### `learner_profile_update` contract examples (`ums-memory-d6q.1.11`)

Evidence-backed mutation:
```json
{
  "storeId": "tenant-a",
  "profile": "learner-alpha",
  "learnerId": "learner-42",
  "identityRefs": [
    { "namespace": "agent", "value": "codex:session-981", "isPrimary": true },
    { "namespace": "email", "value": "learner@example.com", "verified": true }
  ],
  "goals": ["dynamic-programming", "graph-traversal"],
  "evidenceEventIds": ["evt-2026-03-01-001"],
  "metadata": {
    "evidencePointers": [
      {
        "eventId": "evt-2026-03-01-001",
        "storeId": "tenant-a",
        "profile": "learner-alpha",
        "kind": "agent-feedback"
      }
    ],
    "sourceProgram": "codex-cli"
  }
}
```

Policy exception (no evidence pointer available yet):
```json
{
  "storeId": "tenant-a",
  "profile": "learner-alpha",
  "learnerId": "learner-42",
  "identityRefs": [{ "namespace": "agent", "value": "claude:session-444", "isPrimary": true }],
  "goals": ["graph-traversal"],
  "metadata": {
    "policyException": {
      "policyKey": "profile_evidence_required",
      "reasonCode": "bootstrap_import",
      "approvedByDecisionId": "pol_8f7c1a2dbe90",
      "ticket": "ums-memory-d6q.1.11",
      "expiresAt": "2026-03-31T00:00:00.000Z",
      "note": "Historical profile import; evidence backfill scheduled."
    }
  }
}
```

Deterministic rejection envelope (missing both evidence and exception):
```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "learner_profile_update requires evidenceEventIds[] or metadata.policyException."
  }
}
```

- **`ums-memory-d6q.1.12` – Chronological truth versioning and timeline view**
  - Support both `view=current` (latest truth only) and `view=timeline` (full A-then-B lineage) in recall/read paths.
  - Timeline rows should include `version`, `validFrom`, `validTo`, `supersededByVersion`, and source digest fields so audits can replay exact change order.
  - Conflict handling must be deterministic: resolve in fixed order (`updatedAt`, `createdAt`, `requestDigest`), keep loser state in history, and mark conflicts explicitly instead of dropping records.

### Timeline view guidance and conflict notes (`ums-memory-d6q.1.12`)

- Use `view=current` for serving recommendations and policy checks.
- Use `view=timeline` for audit/replay and conflict debugging.
- For conflicts on the same attribute or identity edge, apply one deterministic winner, then:
  - keep the overwritten value in timeline history;
  - tag the history row with `conflict=true` and `resolvedBy=<winnerVersion>`;
  - preserve sorted unique evidence IDs in both winner and loser rows.

- **`ums-memory-d6q.1.13` – Codex/Claude normalization for transfer-safe profile signals**
  - Normalize source-specific fields into one canonical profile/identity mutation shape before persistence.
  - Keep normalization replay-safe and idempotent (trim, sort/dedupe lists, lowercase role/program labels, deterministic fallback IDs).
  - Maintain integration tests for at least two source formats (Codex-style and Claude-style payloads).

### Codex/Claude normalization field mapping summary (`ums-memory-d6q.1.13`)

| Canonical field | Codex-style input | Claude-style input | Normalization rule |
| --- | --- | --- | --- |
| `storeId` | `store`, `memoryStore`, `namespace` | `storeId` | Trim; fallback to default store. |
| `profile/space` | `project`, `channel` | `profile`, `space` | Trim; fallback to default profile/space. |
| `metadata.platform` | `platform=codex-cli` | `platform=claude-code` | Keep lowercase canonical program token. |
| `metadata.role` | `speaker` or `authorRole` | `role` | Lowercase; fallback `unknown`. |
| `id` | `messageId` or `id` | `id` | Fallback `<conversationId>-msg-<index>`. |
| `timestamp` | `time`, `ts`, `timestamp` | `createdAt`, `timestamp` | Normalize to ISO string when possible. |
| `content` | `message`, `text`, `body`, `payload` | `content`, `text`, `message` | Flatten object payloads to stable text. |
| `identityRefs[].value` | `codex:<agent-or-session>` | `claude:<agent-or-session>` | Store under `namespace=agent`, keep deterministic primary ref. |

- **`ums-memory-d6q.1.9` – Observability and SLOs for learner profile + identity graph**
  - Emit structured logs and metrics for both `learner_profile_update` and `identity_graph_update`.
  - Include drift/quality signals (missing evidence pointers, policy exceptions used, normalization rewrites, conflict resolutions).
  - Publish alert thresholds and on-call actions for replay/determinism regressions.

### Observability/SLO checklist (`ums-memory-d6q.1.9`)

- [ ] Structured logs include: `operation`, `storeId`, `profile`, `action`, `requestDigest`, `profileId/edgeId`, `profileDigest/edgeDigest`, `evidenceCount`, `policyExceptionUsed`, `conflictResolved`.
- [ ] Metrics include: `learner_profile_update_requests_total{action}`, `identity_graph_update_requests_total{action}`, `learner_profile_update_latency_ms`, `identity_graph_update_latency_ms`, `profile_evidence_missing_total`, `profile_policy_exception_total`, `profile_conflict_resolutions_total`, `profile_normalization_rewrites_total`.
- [ ] Replay determinism monitor: same request digest must never produce divergent profile/edge digests (`replay_digest_mismatch_total == 0`).
- [ ] SLO targets: 30-day success rate `>= 99.9%`, p95 mutation latency `<= 250ms`, evidence or policy-exception coverage `= 100%`, unresolved conflict count `= 0`.
- [ ] Alerts are wired through the Loki/Prometheus pipeline described in `mcp_agent_mail/docs/observability.md`.

## Other P3 bead-level expectations

- **`ums-memory-d6q.1.4` – Identity graph contracts (ADR-0002, acceptance #4)**
  - Deliverables: downstream P3 beads must always reference the published profile/identity graph contract (identifier shapes, edge semantics, delta versioning) rather than inferring fields from code. A contract change must be recorded in a shared document or changelog so that ingestion, curriculum, scheduling, and safety services remain aligned.
  - Operational note: version the contract asset and emit an audit-friendly snapshot on release (e.g., `identity_graph_contract_vXX` log entry). Operations teams should confirm the artifact is published under a tracked repo path and annotated in the release notes referenced by the bead.

- **`ums-memory-d6q.2.3` – Misconception retrieval with metadata (ADR-0003, acceptance #3)**
  - Acceptance requires bounded, evidence-backed retrievals that surface freshness/conflict metadata. Observe the guarding telemetry described in `ADR-0001` by measuring payload size (`misconception_retrieval_payload_bytes`), token counts, and freshness age counters (e.g., `misconception_retrieval_freshness_ms`).
  - Operational expectation: log each retrieval with a pointer to the evidence episode IDs and any conflict flag so that audits can replay the output. Ship these logs through the Loki/Prometheus pipeline from `docs/observability.md` and alert when guardrail violations (payload size, stale timestamps) exceed configured thresholds.

- **`ums-memory-d6q.2.13` – Anti-pattern inversion + accelerated decay for harmful misconception signals**
  - Deterministic harm thresholds: harmful signal counts at `2`, `3`, and `5` emit anti-pattern inversion artifacts, with deterministic IDs tied to (`misconceptionId`, `threshold`) and stable ordering by (`activatedAt`, `antiPatternId`).
  - Decay acceleration contract: harmful confidence decay stages are fixed by harmful count bands (`1 -> -0.18`, `2 -> -0.24`, `3-4 -> -0.32`, `5+ -> -0.42`) plus a severity penalty (`severity * 0.08`), clamped to a confidence floor of `0.05`.
  - Evidence linkage invariant: anti-pattern payloads must include merged/sorted `evidenceEventIds` and `sourceSignalIds` so downstream replay/audit can prove exactly which harmful signals triggered inversion.
  - Validation expectation: tests must assert deterministic stage assignment, decay deltas, anti-pattern evidence preservation, and replay-safe no-op behavior for duplicate signal IDs.

- **`ums-memory-d6q.2.10` – Misconception tracking runbook + hardening backlog closure**
  - Runbook checklist:
    - [ ] Signal ingestion semantics are documented for explicit pain and implicit failure paths, including evidence contract requirements.
    - [ ] Chronology output behavior is documented for recall consumers (`misconceptionChronology.limit`, relevance prioritization, deterministic formatting).
    - [ ] Anti-pattern inversion and decay acceleration thresholds are documented with replay-safe expectations.
  - Hardening backlog (tracked follow-ups):
    - `ums-memory-d6q.2.10.1` Misconception chronology conflict compression for high-churn learners.
    - `ums-memory-d6q.2.10.2` Severity-calibration sweeps for implicit failure mappings.
    - `ums-memory-d6q.2.10.3` Alert tuning for anti-pattern trigger rate anomalies.

- **`ums-memory-d6q.3.3` – Curriculum planner persistence & audit (ADR-0004, acceptance #3)**
  - Persistence must remain local-first, encrypted, isolated, and auditable. Emit metrics for persistence health (e.g., `curriculum_persistence_write_latency`, `curriculum_persistence_encryption_status`) and log ingestion/recommendation events with tenant/profile tags and audit IDs.
  - Operational expectation: include a retention check that ensures audit logs survive long enough to prove deterministic replays; export a daily digest of enrollment/recommendation actions (record counts, profile IDs) to cross-check the planner engine.

- **`ums-memory-d6q.3.10` – Curriculum planner runbook and hardening backlog closure**
  - Runbook checklist:
    - [ ] Freshness/decay warning thresholds and ranking-weight defaults are documented with override examples.
    - [ ] Conflict chronology behavior (`A -> B` ordering, bounded output, deterministic formatting) is documented for API/CLI readers.
    - [ ] Token/recall budget bounding behavior is documented with expected degradation semantics when budget is exhausted.
  - Hardening backlog (tracked follow-ups):
    - `ums-memory-d6q.3.10.1` Drift-detection dashboard for recommendation weight skew over rolling windows.
    - `ums-memory-d6q.3.10.2` Regression suite for stale-recommendation suppression under bursty write patterns.
    - `ums-memory-d6q.3.10.3` Load-test profile pack for mixed-interest and mastery-gap cohorts.

- **`ums-memory-d6q.4.3` – Review scheduling provenance (ADR-0005, acceptance #3)**
  - Every schedule mutation must store provenance and emit audit records. This runs through the same observability stack: add structured log entries for `schedule_mutation` events containing source event IDs, learner profile key, tenant scope, and operation result. Use the `tool_metrics_snapshot` pattern from `docs/observability.md` to ensure these logs are preserved.
  - Operational expectation: configure alerts when a mutation event lacks provenance fields or when audit events stop arriving for a given tenant window. Periodically compare replay data with the audit log to confirm determinism.

- **`ums-memory-d6q.4.14` – Constant-latency scheduling benchmark gate**
  - Benchmark gate contract:
    - [ ] Measure scheduling operation latency (`review_schedule_update`, `review_schedule_clock`, `review_set_rebalance`) across increasing review-set volumes.
    - [ ] Fail CI/local benchmark run when p95 regression exceeds configured thresholds or when p95 volume ratio breaches near-constant guardrail.
    - [ ] Emit both versioned and latest benchmark reports (`docs/performance/phase3-review-scheduling-latency-gate.*.{json,md}`).
  - Alerting threshold defaults:
    - Near-constant ratio gate: `max(p95_volume) / min(p95_volume) <= 4.0`
    - Peak-volume p95 gates: update `<= 0.8ms`, clock `<= 2.2ms`, rebalance `<= 2.8ms`

- **`ums-memory-d6q.4.10` – Scheduling runbook + hardening backlog closure**
  - Runbook checklist:
    - [ ] Interaction/sleep clock semantics, fatigue thresholds, and novelty-write triggers are documented with deterministic consolidation causes.
    - [ ] Active-set/archival tier rebalance policies are documented with bounded limits and replay expectations.
    - [ ] Scheduling benchmark gate usage is documented (`npm run bench`, report paths, threshold overrides via env vars).
  - Hardening backlog (tracked follow-ups):
    - `ums-memory-d6q.4.10.1` Adaptive active-limit policy experiments for large stores.
    - `ums-memory-d6q.4.10.2` Deterministic archival compaction for long-lived review histories.
    - `ums-memory-d6q.4.10.3` Scheduler jitter dashboard with per-volume regression deltas.

- **`ums-memory-d6q.5.3` – Personalization safety guardrails (ADR-0006, acceptance #3)**
  - Recommendations must pass anti-overfitting checks and respect bounded-recall limits before emission. Track guardrail signals such as `recommendation_guardrail_failures_total`, `recommendation_recall_sampling_rate`, and `recommendation_evidence_count` so ops can tell when a response is suppressed or trimmed.
  - Operational expectation: when a guardrail blocks a recommendation, emit an audit record with the failure reason, cite the relevant ADR acceptance (anti-overfitting/freshness), and surface these records in dashboards derived from the `docs/observability.md` pipeline. Guardrail failure rates higher than 0.5% over a rolling window should trigger a post-mortem.

### Personalization policy audit export + incident checklist (`ums-memory-d6q.5.14`)

- Checklist:
  - [ ] Scheduled audit export includes one row/event per policy decision with `decisionId`, `requestDigest`, `policyVersion`, `reasonCode`, `allow|deny`, `storeId`, `profile`, `evidencePointers`, and timestamp.
  - [ ] Export includes explicit incident review fields: `rollbackRequired`, `rollbackDecisionId`, `incidentId`, `degradedMode`, and `reviewedBy`.
  - [ ] Incident checklist is run for every Sev2+ or policy-regression event: detection time, containment action, rollback/mitigation action, deterministic replay verification, and post-incident owner.
  - [ ] Runbook references and command examples are published in docs and linked from the bead closure notes.
- Expected artifacts:
  - [ ] Audit export file for the review window (NDJSON/CSV) with immutable checksum and retention location.
  - [ ] Completed incident checklist record (ticket or runbook artifact) containing decision trace and rollback evidence.
  - [ ] One reproducible replay transcript proving policy decisions before/after mitigation are deterministic.

### Policy-pack plugin architecture boundaries (`ums-memory-d6q.5.15`)

- **Extension interface boundaries**
  - Policy-pack extensions are backend-only hooks and must execute within the same trust boundary as core policy operations (`ADR-0001` tags `B/S/D/R/O`).
  - Extension payloads are read-only views over policy decisions (`decisionId`, `requestDigest`, `policyVersion`, `reasonCodes`, evidence pointers, policy trace); extensions cannot directly mutate learner profiles, misconception state, curriculum plans, or schedules.
  - Extension-specific data must remain under a namespaced `extension` object with explicit versioning (`extension.apiVersion`) to avoid contract drift.
- **Backward-compatibility and safety constraints**
  - Existing policy contract fields are mandatory and stable; unknown extension versions fail closed with deterministic deny semantics (`403 PERSONALIZATION_POLICY_DENY`, reason `extension_unavailable`).
  - Extension failures cannot bypass or downgrade policy outcomes; deny-by-default remains the invariant for unavailable, invalid, or contradictory extension responses.
  - Every extension call path must emit deterministic audit fields (`extensionName`, `extensionVersion`, `invocationDigest`, `invokedAt`, `completedAt`, `outcome`) and include evidence coverage checks (`evidenceCount` or policy exception reference).
- **Enumerated follow-up implementation beads**
  - `ums-memory-d6q.5.15.1` Policy extension contract artifact + versioning matrix.
  - `ums-memory-d6q.5.15.2` Compatibility/replay validation suite for extension versions and fail-closed behavior.
  - `ums-memory-d6q.5.15.3` Extension observability + alerting integration for error/deny rates and latency budgets.

### Policy controls runbook + hardening backlog (`ums-memory-d6q.5.10`)

- Runbook closure checklist:
  - [ ] Prompt-injection quarantine, cross-space allowlist, degraded-mode, and policy-audit export workflows are documented end-to-end with deterministic replay steps.
  - [ ] Incident response templates include deterministic rollback verification fields (`decisionId`, `requestDigest`, `reasonCodes`, `policyVersion`).
  - [ ] Safety operations include explicit fail-closed expectations and on-call escalation thresholds.
- Hardening backlog (tracked follow-ups):
  - `ums-memory-d6q.5.10.1` Policy contradiction detector for conflicting allow/review/deny outcomes.
  - `ums-memory-d6q.5.10.2` Cross-space abuse-rate throttling and adaptive deny escalation.
  - `ums-memory-d6q.5.10.3` Degraded-mode recovery validator for deterministic switchback behavior.

### Security and degraded-mode operational notes (`ums-memory-d6q.5.11/.5.12/.5.13`)

- **`ums-memory-d6q.5.11` prompt-injection resistant curation**
  - Operational checklist: quarantine untrusted instruction patterns by default; require validation evidence before procedural-memory promotion; log `reasonCode` for each block/quarantine path.
  - Expected artifacts: injection-test report covering malicious payload variants + sample quarantine audit entries with decision trace IDs.
- **`ums-memory-d6q.5.12` cross-space allowlist enforcement**
  - Operational checklist: require allowlist authorization for all cross-space recall attempts; return deterministic deny semantics for unauthorized access; alert on repeated unauthorized attempts per actor/tenant.
  - Expected artifacts: allowlist snapshot/version used in production window + integration test output showing authorized and denied cross-space recalls.
- **`ums-memory-d6q.5.13` degraded-mode tutoring behavior**
  - Operational checklist: fail over to deterministic fallback responses when LLM/index dependencies are unavailable; expose capability flags/warnings in output; record degraded entry/exit timestamps.
  - Expected artifacts: outage drill log with fallback transcript samples + deterministic replay evidence for degraded responses.

## Domain SLO + rejection checklist (`ums-memory-d6q.2.9/.3.9/.4.9/.5.9`)

Use this table as the operational minimum for observability/SLO beads (`.x.9`). For each domain, validation beads (`.2.6/.3.6/.4.6/.5.6`) must provide explicit tests for these rejection paths and emitted telemetry.

- **Misconception operations (`ums-memory-d6q.2.9`, validation `ums-memory-d6q.2.6`)**
  - SLO/metrics checklist: [ ] 30-day success `>= 99.9%` and p95 write/read latency `<= 250ms`; [ ] emit `misconception_signal_requests_total{action}`, `misconception_signal_latency_ms`, `misconception_guardrail_reject_total{reason}`, `misconception_replay_mismatch_total`; [ ] monitor drift/freshness with `misconception_decay_applied_total` and `misconception_retrieval_freshness_ms`.
  - Guardrail rejection semantics: `400 MISCONCEPTION_SIGNAL_INVALID` (schema/provenance invalid), `403 MISCONCEPTION_TRUST_BOUNDARY_DENY` (tenant/profile isolation), `422 MISCONCEPTION_EVIDENCE_REQUIRED` (missing evidence pointer).
  - Validation expectation (`.2.6`): deterministic replay returns identical reject code/reason; tests cover malformed payload, trust-boundary deny, and per-rejection metric/log emission.

- **Curriculum operations (`ums-memory-d6q.3.9`, validation `ums-memory-d6q.3.6`)**
  - SLO/metrics checklist: [ ] 30-day success `>= 99.9%` and p95 planner latency `<= 300ms`; [ ] emit `curriculum_plan_requests_total{action}`, `curriculum_plan_latency_ms`, `curriculum_guardrail_reject_total{reason}`, `curriculum_replay_mismatch_total`; [ ] track quality drift via `curriculum_recommendation_drift_total` and evidence/freshness counters.
  - Guardrail rejection semantics: `400 CURRICULUM_INPUT_INVALID` (invalid signal shape), `403 CURRICULUM_TRUST_BOUNDARY_DENY` (isolation/policy violation), `422 CURRICULUM_MIN_EVIDENCE_UNMET` (insufficient or stale evidence).
  - Validation expectation (`.3.6`): tests prove deterministic deny behavior for low-evidence/stale windows, plus rejection observability parity across API/CLI/MCP paths.

- **Review-schedule operations (`ums-memory-d6q.4.9`, validation `ums-memory-d6q.4.6`)**
  - SLO/metrics checklist: [ ] 30-day success `>= 99.9%` and p95 schedule mutation latency `<= 250ms`; [ ] emit `review_schedule_mutation_requests_total{action}`, `review_schedule_mutation_latency_ms`, `review_schedule_guardrail_reject_total{reason}`, `review_schedule_replay_mismatch_total`; [ ] alert on provenance gaps via `review_schedule_provenance_missing_total`.
  - Guardrail rejection semantics: `400 REVIEW_SCHEDULE_INPUT_INVALID` (window/interval malformed), `403 REVIEW_SCHEDULE_TRUST_BOUNDARY_DENY` (tenant/profile mismatch), `422 REVIEW_SCHEDULE_PROVENANCE_REQUIRED` (missing source evidence/provenance).
  - Validation expectation (`.4.6`): tests cover provenance-required rejects, cross-tenant denies, and idempotent replay of failed schedule mutations.

- **Policy operations (`ums-memory-d6q.5.9`, validation `ums-memory-d6q.5.6`)**
  - SLO/metrics checklist: [ ] 30-day success `>= 99.95%` and p95 policy-eval latency `<= 150ms`; [ ] emit `personalization_policy_requests_total{decision}`, `personalization_policy_eval_latency_ms`, `personalization_policy_reject_total{reason}`, `personalization_policy_replay_mismatch_total`; [ ] monitor safety drift via `personalization_allowlist_deny_total` and `personalization_overfit_block_total`.
  - Guardrail rejection semantics: `403 PERSONALIZATION_POLICY_DENY` (allowlist/trust boundary fail), `422 PERSONALIZATION_POLICY_MIN_EVIDENCE_UNMET` (anti-overfitting minimum not met), `409 PERSONALIZATION_POLICY_CONTRADICTION` (conflicting policy outcomes).
  - Validation expectation (`.5.6`): tests prove deterministic deny codes, policy trace fields (`decisionId`, `reasonCode`, `requestDigest`), and observable reject counters for every deny path.

## Operational cross-checks

1. **Contract visibility** – Link each release note / changelog entry to the relevant ADR so downstream beads can audit the contract version (satisfies `.1.4`, `.1.11`, `.1.13`).
2. **Evidence discipline** – `learner_profile_update` payloads must prove evidence grounding or carry an auditable policy exception (satisfies `.1.11`).
3. **Chronology discipline** – Current vs timeline views and conflict resolution behavior must be documented and testable (satisfies `.1.12`).
4. **Telemetry coverage** – Any guardrail, audit, chronology, or bounded-recall signal mentioned above must be emitted as structured JSON, shipped via Loki, and fed into Prometheus alerting rules per `docs/observability.md` (satisfies `.1.9`, `.2.3`, `.2.9`, `.3.3`, `.3.9`, `.4.3`, `.4.9`, `.5.3`, `.5.9`).
5. **Audit logs** – Every state-changing path should record provenance before and after the change (per `ADR-0001` observability tag). Ops should have a documented replay procedure for each P3 service so audits and post-mortems are proof-positive.
6. **Validation gates** – Guardrail rejection codes and trust-boundary checks must be backed by deterministic validation/replay tests and failure-path docs (satisfies `.2.6`, `.3.6`, `.4.6`, `.5.6`).

If additional operational expectations emerge (e.g., CME compliance or tenant-scope monitoring), extend this runbook with focused sections rather than edits to the ADRs themselves.
