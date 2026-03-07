# Phase 0 UMS Governance and Architecture Foundations

Date: 2026-03-04
Owner: UMS backend platform
Scope: `ums-memory-0d2.1` through `ums-memory-0d2.10`

## FND-01 Scope Matrix for Operating Modes

| Mode                    | Primary deployment target | Isolation boundary                                     | Supported memory domains                                 | Success criteria                                                    |
| ----------------------- | ------------------------- | ------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Single-user local       | Developer laptop          | Local profile/store boundary                           | Personal coding memory                                   | Deterministic replay, no tenant crossover, local-first operation    |
| Team shared workspace   | Internal environment      | Workspace and project boundary                         | Team coding memory + controlled shared memory            | Cross-user access is policy-gated and auditable                     |
| Enterprise multi-tenant | Production backend        | Org -> tenant -> project -> workspace -> user boundary | Multi-source enterprise memory (coding, ticketing, docs) | Zero cross-tenant leaks, signed audit trail, policy-enforced recall |

Control notes:

- All modes keep backend-only delivery and no frontend policy UI in scope for this phase.
- Enterprise mode requires deny-by-default cross-space access unless explicitly allowlisted.
- Promotion/demotion paths must remain deterministic and replay-safe in every mode.

## FND-02 Licensing and Clean-Room Decision Record

Decision:

- UMS is implemented as an independent TypeScript + Effect codebase.
- External projects can be used for behavior study and architecture inspiration only.
- No direct code copying, no structural mirroring from licensed reference internals, and no transitive snippet carry-over.

Guardrails:

- Architecture references must be captured as ADR rationale, not code imports.
- New modules require provenance comments in PR/commit narratives when influenced by external behavior study.
- Review checklist must include explicit clean-room confirmation before merge.

Enforcement:

- Backend-only code paths remain in this repository and run through deterministic test gates.
- Legal/compliance review is required before any reference-derived behavior reaches production policy paths.

## FND-03 Data Classification and Residency Policy

| Artifact class                | Examples                                                 | Classification | Residency policy                             | Retention baseline                             |
| ----------------------------- | -------------------------------------------------------- | -------------- | -------------------------------------------- | ---------------------------------------------- |
| Operational metadata          | IDs, timestamps, digests, deterministic request keys     | Internal       | Region aligned with tenant residency         | 24 months                                      |
| Memory content                | Episodic entries, working summaries, procedural guidance | Confidential   | Tenant region only, encrypted at rest        | Configured by tenant policy, default 12 months |
| Security and audit artifacts  | Policy decisions, auth outcomes, anomaly alerts          | Restricted     | Tenant region only, append-only audit ledger | 36 months                                      |
| Exported compliance artifacts | Signed audit exports, snapshot bundles                   | Restricted     | Tenant region + approved compliance archive  | Per legal contract                             |

Policy requirements:

- Cross-region replication is opt-in per tenant and requires documented legal basis.
- Redaction is mandatory before persistence for secret-like payloads.
- Export controls require actor identity and signature metadata.

## FND-04 Threat Model for Ingestion, Retrieval, and Optimization

| Pipeline stage | Threat                                                  | Impact                                  | Primary mitigations                                                               | Detection signals                                               |
| -------------- | ------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Ingest         | Prompt injection, secret poisoning, replay abuse        | Corrupted memory and unsafe outputs     | Strict payload validation, secret redaction, idempotency keys                     | Rejection metrics, anomaly alerts, policy deny audits           |
| Retrieval      | Cross-tenant exfiltration, unauthorized scope traversal | Data leak, compliance breach            | Tenant routing checks, authorization service fail-closed behavior, bounded recall | Denied authorization telemetry, scope mismatch errors           |
| Optimization   | Harmful rule promotion, unsafe decay/reinforcement      | Quality regressions and unsafe guidance | Replay-gated promotion, signed policy audit export, manual quarantine controls    | Net-value regression, harmful feedback spikes, rollback signals |

Abuse scenarios tracked:

- Tenant breakout attempts through explicit scope selectors.
- Poisoned ingest content attempting to bypass redaction filters.
- Unauthorized policy override attempts in operational workflows.

## FND-05 System Topology and Environment Boundaries

Topology baseline:

- CLI/API/worker services use shared contracts from `libs/shared`.
- Persistence, tenancy routing, authorization, and policy enforcement stay server-side.
- External connectors are adapter-based and isolated behind contract boundaries.

Environment boundaries:
| Environment | Allowed data | Network boundary | Required controls |
| --- | --- | --- | --- |
| Local | Synthetic + local user memory | Localhost only | Deterministic tests, local encryption keys |
| Staging | Sanitized tenant-like data | Internal network segment | Auth parity with production, audit export verification |
| Production | Tenant-owned live data | Restricted private network | Strict auth, signed exports, incident response runbooks |

## FND-06 Tenancy Identity Model

Canonical hierarchy:
`org -> tenant -> project -> workspace -> user -> agent_session`

Rules:

- Every persisted memory and audit artifact carries tenant and actor context.
- Project and workspace scopes are nested inside tenant boundaries.
- User and agent sessions cannot write outside the resolved tenant route.
- Cross-space retrieval requires explicit allowlist + policy approval.

Identity semantics:

- Tenant resolution is deterministic from identity claims and issuer bindings.
- Conflicting tenant claims fail closed.
- Provisioning and lifecycle events are recorded in audit telemetry.

## FND-07 Engineering Ownership and Runbook Responsibilities

| Domain                               | Primary owner       | Backup owner            | Runbook                                                  |
| ------------------------------------ | ------------------- | ----------------------- | -------------------------------------------------------- |
| Adapter contracts + source ingestion | Backend platform    | Integration engineering | `docs/runbooks/multi-store-source-ingestion.md`          |
| Retrieval ranking + bounded recall   | Backend platform    | Search/relevance        | `docs/runbooks/vector-retrieval-extension-evaluation.md` |
| Policy enforcement + audit export    | Security/platform   | Compliance engineering  | `docs/runbooks/phase3-personalization-operational.md`    |
| Tenancy + identity routing           | Identity/platform   | Security operations     | `docs/runbooks/enterprise-identity-rollout-runbook.md`   |
| Deployment + operations              | Platform operations | On-call engineering     | `docs/runbooks/deploy-operations-compose-first.md`       |

Responsibility model:

- Primary owner approves changes in their domain.
- Backup owner signs off incident remediation when primary is unavailable.
- Each runbook must define escalation path and rollback criteria.

## FND-08 Acceptance Criteria Catalog for Major Phases

| Phase                        | Exit criteria                                                                 | Evidence artifact                              |
| ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Phase 0 foundations          | Governance baseline accepted, ADR bundle approved, go/no-go decision recorded | This runbook + ADR-0007 + sign-off table       |
| Phase 1 core engine          | Deterministic memory layers and contracts validated                           | Unit/integration test pass evidence            |
| Phase 2 enterprise ingestion | Multi-source adapters + isolation + provenance validated                      | Integration contract and policy audit evidence |
| Phase 3 personalization      | Safety guardrails and observability coverage validated                        | SLO and policy operational reports             |
| Phase 4 retrieval hardening  | Ranking, conflict chronology, explainability validated                        | Retrieval validation reports and tests         |
| Phase 5 operations           | Disaster recovery and incident procedures validated                           | Runbook drills and audit trails                |
| Phase 6 rollout              | Controlled promotion, KPI targets, rollback readiness validated               | Pilot KPI + production SLO evaluations         |

Catalog guardrails:

- Each phase must define measurable pass/fail criteria.
- No phase closes without replay-safe test evidence.
- Security or tenancy regressions block promotion by default.

## FND-09 Architecture ADR Bundle and Review Checklist

ADR bundle for Phase 0:

- `docs/adr/0001-phase1-phase2-baseline-constraints.md`
- `docs/adr/0007-phase0-governance-architecture-baseline.md`

Review checklist:

- Problem statement and constraints are explicit.
- Backend-only scope boundary is explicit.
- Security defaults and tenant isolation requirements are explicit.
- Deterministic and replay-safe requirements are explicit.
- Out-of-scope items are explicit.
- Bead IDs mapped to decisions are explicit.

## FND-10 Architecture Sign-Off Gate (Go/No-Go)

Sign-off decision:

- Decision: `GO` for Phase 1 implementation under mandatory guardrails from FND-01 through FND-09.
- Decision timestamp: 2026-03-04T17:00:00Z
- Release-entry criteria: deterministic test gates green, tenant isolation checks green, policy audit export checks green.

Unresolved risks and remediation owners:
| Risk | Severity | Owner | Remediation |
| --- | --- | --- | --- |
| Non-deterministic local ingestion report artifacts | Medium | Backend platform | Implement deterministic check mode and CI-safe workflow (`ums-memory-509`) |
| Future connector onboarding without policy parity | Medium | Integration engineering | Enforce adapter contract review + policy gating template |
| Tenant claim misconfiguration in new environments | High | Identity/platform | Add preflight tenant-route checks to deployment rollout checklist |

Go/no-go protocol:

- Any unresolved high-severity risk without owner and mitigation changes decision to `NO-GO`.
- Any failing deterministic quality gate changes decision to `NO-GO`.
- Any cross-tenant leak signal changes decision to `NO-GO`.
