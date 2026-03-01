# ADR-0002: Phase P3 Learner Profile / Identity Graph Scope
Date: 2026-02-28
Status: Proposed

## Context
- Phase P3 of PLAN.md is dedicated to personalization/tutoring work (Learner profiles, misconception tracking, memory-driven curriculum planning). Bead `ums-memory-d6q.1.1` owns the backend services that will make this Phase real.
- ADR-0001 already locked in the shared constraints for Phase 1/2 (backend-only, local-first, deterministic/idempotent updates, security defaults, bounded recall, observability). This new ADR must stay within the same **B/L/S/D** footprint and surface any Phase P3-specific boundaries so downstream stories can inherit the constraints explicitly.

## Decision
- Limit P3 scope to backend services that build a learner profile + identity graph substrate without introducing new frontend surfaces or client-side state.
- The learner profile service will consolidate multi-agent observations, misconception signals, and spaced repetition metadata into deterministic, replay-safe deltas that feed the identity graph.
- The identity graph is a backend-only relation set that links learner profiles to agent-party identifiers, evidence episodes, and correction histories. It serves curriculum planning by surfacing relevant episodes, rules, and misconceptions for each learner profile.
- The scope mapping described below ties PLAN.md’s Phase P3 bullets to concrete backend responsibilities while reaffirming ADR-0001’s constraints.

## In Scope
- Learner profile ingestion APIs that accept sanitized, provenance-tagged signals from agents, outcomes, and feedback loops. This includes capturing misconception alerts and spaced-repetition metadata per profile.
- Backend identity graph construction that deterministically merges identifiers (agent handle, profile namespace, tenant) while recording evidence pointers and correction signatures.
- Curriculum planning hooks that assemble candidate recommendations (rules, anti-patterns, episodes) for a profile based on the identity graph and stored misconceptions.
- Local-first persistence layers (episode store, profile cache, graph indices) with deterministic delta application, audit logging, and encryption keyed per profile/tenant.
- Contract artifacts for other backend beads that need learner profile data (e.g., recall, curator, validation) so they know how to consume identity graph outputs strictly through APIs or CLI.

## Out of Scope
- Any UI product surfaces (web, CLI, agent plug-ins) that surface learner profile data—those are explicitly handled by FE agents and are out of scope per ADR-0001’s backend-only constraint.
- Client-side bundling, caching, or offline sync logic; all compute must remain in backend services (B only).
- Any non-deterministic or non-idempotent state transitions (e.g., heuristics or ML updates without deterministic deltas) that would violate the deterministic/local-first requirement.

## Acceptance Criteria
1. Learner profile and identity graph services expose APIs that intake agent feedback, map it deterministically to profiles, and emit identity graph deltas; all writes obey the deterministic/idempotent contracts from ADR-0001.
2. Stored data stays local-first, encrypted, and tagged with provenance/tenant scope so that no cross-tenant leakage occurs, meeting ADR-0001’s security defaults.
3. Curriculum planning queries consume the identity graph to surface the latest misconceptions and supporting evidence without requiring frontend compute; the response payload is bounded (R) and audited (O).  
4. Downstream beads receive backend contract documentation describing profile identifiers, identity graph edges, and delta versioning so they can integrate without introducing UI work.

## Backend Boundaries
- Services live in the backend domain (no UI clients). Public entry points are CLI/API endpoints defined in backend contracts (ingest, reflect, recall, and curriculum query gates).
- Data storage remains local-first (on-device or in protected tenant storage) and is deterministic: every profile/graph update is a replay-safe delta with explicit tombstone tagging for corrections.
- Security defaults apply: redaction, profile/tenant isolation, least-privilege credentials for services manipulating profiles, and audit logging for every identity graph mutation (per ADR-0001, tags B/L/S/D remain enforced).
- Identity graph consumers must interact only through the sanctioned backend APIs; direct DB access from other agents or frontends is prohibited.
