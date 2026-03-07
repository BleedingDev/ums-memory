# ADR-0010: Usage Trace Privacy, Retention, and Tenant Isolation

Date: 2026-03-06
Status: Accepted

## Context

- ADR-0009 introduced `packId` / `usageId` tracing and an advisory-first credit-assignment model. That work increases the amount of fine-grained operational metadata UMS may persist about recall packs, surfaced memory items, outcomes, and downstream actions.
- Existing governance already defines retention and residency baselines for operational metadata, memory content, and audit artifacts. The new usage-trace layer must stay inside those baselines while preserving deterministic replay, tenant isolation, and signed auditability.
- Without a dedicated decision record, downstream attribution beads risk over-collecting raw content, enabling cross-tenant joins, or retaining trace artifacts longer than required.

This ADR locks privacy, retention, and tenant-isolation constraints for downstream usage-trace work under epic `ums-memory-jny`.

## Decision

- Treat usage traces as minimum-necessary backend metadata, not as a second raw-content store.
- Require same-tenant joins only: usage trace rows may be joined only when `tenant_id` matches and the requested scope is already authorized by existing routing and authorization controls.
- Default to reference storage over content storage:
  - Persist `packId`, `usageId`, bounded memory identifiers, same-tenant routing identifiers, timestamps, decision codes, reason codes, digests, and bounded artifact/test/tool references.
  - Do not persist raw prompt text, raw memory body copies, secret-bearing tool output, or raw human identifiers in usage trace records.
- Pseudonymize external-facing identifiers before persistence:
  - external actor identifiers, chat/session identifiers, and third-party tool identifiers must be normalized and persisted as deterministic digests or internal IDs when possible.
  - email addresses, phone numbers, access tokens, and secret-like strings remain prohibited in trace payloads.
- Align retention to existing artifact classes:
  - usage trace metadata follows the operational metadata baseline: 24 months by default.
  - derived audit/security events from usage traces follow the restricted audit baseline: 36 months.
  - optional debug payload snapshots are default-off and, if temporarily enabled for incident response, must expire within 7 days.
- Keep residency aligned with tenant policy:
  - usage traces stay in the tenant’s approved residency boundary.
  - cross-region replication remains opt-in per tenant and requires documented legal basis.
- Enforce kill switches and fail-closed behavior:
  - per-space or per-tenant controls must exist for `usage_tracing`, `attribution_scoring`, and `attribution_ranking`.
  - disabling tracing must not disable mandatory security/audit events required for policy or incident review.
- Require deletion and expiry semantics:
  - expired usage traces must be deleted or compacted deterministically.
  - deletion/expiry jobs must preserve replay-safe audit summaries without retaining prohibited raw payloads.
- Protect operator access:
  - usage trace inspection is restricted to authorized backend/compliance roles.
  - exported trace artifacts must include actor identity, checksums, and signature metadata when they leave the primary storage boundary.

## In Scope

- Canonical field-level policy for what attribution and usage-trace rows may store.
- Residency, retention, expiry, and export requirements for trace artifacts.
- Tenant-isolation and same-tenant-only join rules for trace queries and scoring jobs.
- Kill-switch expectations and fail-closed behavior for tracing and downstream attribution features.
- Auditability requirements for trace-derived exports and operator access.

## Out of Scope

- Scorer implementation details or ranking algorithms.
- Frontend/operator UI for managing trace policies.
- Cross-tenant analytics or federated attribution.
- Legal contract wording beyond the repository’s existing policy baselines.

## Acceptance Criteria

1. Minimum data policy:
   Usage-trace contracts clearly distinguish allowed metadata fields from prohibited raw-content fields.
2. Retention clarity:
   Default retention windows, debug snapshot TTL, and expiry behavior are explicitly documented.
3. Tenant safety:
   Same-tenant-only joins and fail-closed controls are explicit for tracing, scoring, and ranking paths.
4. Auditability:
   Trace exports and overrides require actor identity, checksums, and signature metadata where applicable.
5. Operational controls:
   Per-space or per-tenant disable and kill-switch requirements are documented before rollout.

## Consequences

Positive:

- Keeps the attribution stack aligned with existing governance baselines instead of inventing a parallel data policy.
- Reduces privacy and compliance risk by preferring references and digests over raw content.
- Makes future tracing/scoring beads easier to implement without re-litigating tenant boundaries.

Costs:

- Adds policy enforcement and redaction work to downstream implementation beads.
- Limits some debugging convenience by disallowing raw-content trace capture by default.
- Requires explicit operational handling for short-lived debug mode and expiry jobs.

## Required Follow-ups

- Ensure context tracing emits stable identifiers without leaking raw content or cross-tenant metadata.
- Persist outcome linkage using allowed metadata and bounded references only.
- Keep attribution scoring same-tenant and compatible with pseudonymized trace identifiers.
- Expose only advisory, authorized, read-only trace summaries.
- Enforce kill-switches and fail-closed behavior for any ranking nudges backed by usage traces.
