# Cross-Repo Memory Federation Model (bead `ums-memory-dd2.4`)

## Purpose

Define a controlled federation model for sharing actionable memory across repositories and teams while preserving tenant isolation, policy enforcement, deterministic retrieval behavior, and strict TypeScript + Effect boundaries.

## Scope

In scope:

- Federation model for shared read access across repositories in one tenant boundary.
- Multi-level memory behavior across common, project, job_role, and user scopes.
- Explicit policy enforcement and audit controls for federation reads.
- Operational design for service deployment, storage, and monitoring.

Out of scope:

- Cross-tenant memory federation.
- Automatic write-through from target repositories back into source repositories.
- Mandatory Kubernetes deployment requirements.

## Baseline Constraints (Must Hold)

- Existing retrieval scope semantics remain canonical: common, project, job_role, user.
- Existing policy and authorization decisions remain deny-by-default.
- Better Auth remains the identity control-plane boundary for login and SSO.
- Federation does not bypass existing policy decision checks.
- SQLite remains a supported default storage backend; Postgres remains optional scale-up path.

## Federation Topology

Federation is modeled per tenant as explicit share contracts between spaces:

- `source_space`: space that owns memory artifacts.
- `target_space`: space that can consume federated memory.
- `share_scope`: one of `common|project|job_role|user`.
- `selector`: optional scope selectors (project id, role id, user id).
- `access_mode`: one of:
  - `reference_only` (can cite, cannot promote)
  - `retrieval` (can retrieve and cite)
  - `retrieval_with_candidate_promotion` (can create promotion candidates only)

No implicit federation is allowed. Every federation path must be backed by an explicit share contract.

## Policy Enforcement Model

Federation requests must evaluate policy in this order:

1. Authenticate actor through Better Auth and resolve tenant routing.
2. Authorize actor action in target space (`memory.read` plus federation extension action).
3. Evaluate share contract allowlist between `source_space` and `target_space`.
4. Enforce selector compatibility with common/project/job_role/user request context.
5. Apply deny-by-default fallback on any missing or invalid policy input.

Required denial audit event:

- `federation.share.denied`

Mandatory denial reasons:

- tenant mismatch
- missing share contract
- selector mismatch
- policy deny

## Deterministic Retrieval and Conflict Rules

Federated retrieval merges local and remote candidates deterministically:

1. local space results (highest precedence)
2. federated project scope
3. federated job_role scope
4. federated common scope

Federated user scope is only included when source and target user identity mapping is explicit and policy-approved.

Deterministic ranking requirements:

- use stable weighted scoring profile per request
- tie-break by:
  - `score` descending
  - `updatedAtMillis` descending
  - `memoryId` ascending
- deduplicate by canonical memory digest before final ranking:
  - highest-precedence scope candidate wins (`local > project > job_role > common`)
  - if precedence is equal, keep higher score
  - if still equal, keep newer `updatedAtMillis`, then lower `memoryId`
- attach provenance for each federated hit (`source_space`, `share_id`, `policy_decision_id`)

## Data and Service Contracts

Required logical entities (can be mapped to SQLite or Postgres):

- `federation_shares`
- `federation_share_selectors`
- `federation_access_audit`
- `federation_sync_state` (optional)

Recommended Effect service boundaries:

- `FederationPolicyService`
- `FederationShareRepository`
- `FederatedRetrievalService`
- `FederationAuditService`

All boundaries must expose schema-validated contracts and tagged error channels.

## Operations, Deployment, and Monitoring

Deployment target for initial rollout is compose-first service operation:

- one shared UMS service per environment
- SQLite default for low-friction rollout
- optional Postgres adapter for larger datasets and throughput
- no mandatory Kubernetes dependency

Minimum monitoring surface:

- federation request count and deny rate
- federated retrieval p95 latency delta <= 20% versus non-federated baseline
- share configuration drift alerts
- policy decision cache ttl <= 60s
- cross-tenant leak incidents == 0

## Rollout Plan

| Phase                       | Goal                                                     | Exit criteria                                     |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| 0. Contract lock            | Freeze federation schema and policy contract             | runbook approved and linked from standards        |
| 1. Read-only shadow         | evaluate federation candidates without serving results   | zero policy mismatch against control checks       |
| 2. Controlled read canary   | enable federated retrieval for allowlisted spaces        | latency and deny-rate gates remain within targets |
| 3. Broader read rollout     | expand to more spaces with audit hardening               | stable metrics for 14 days                        |
| 4. Candidate promotion mode | allow promotion-candidate writes when explicitly enabled | policy and audit checks remain green              |

## Go/No-Go Metrics

- cross-tenant leak incidents == 0
- unauthorized federated reads == 0
- federated retrieval p95 latency delta <= 20%
- federation policy decision mismatch rate <= 0.1%
- federation.share.denied events contain reason codes in 100% of denials

## Explicit Non-Goals

- No direct cross-tenant sharing of memory.
- No bypass of Better Auth identity verification.
- No automatic promotion of federated content into active procedural memory.
- No implicit share grants based on repository naming conventions.
