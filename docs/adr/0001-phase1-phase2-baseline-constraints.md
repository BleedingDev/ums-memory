# ADR-0001: Phase 1/2 Baseline Constraints and Scope Mapping
Date: 2026-02-28
Status: Accepted

## Context
UMS Phase 1 and Phase 2 are backend platform phases. This ADR locks shared constraints so all epics implement compatible behavior across API, CLI, MCP, ingestion, recall, security, and operations.

## Decision
All Phase 1/2 epic implementations must satisfy these baseline constraints:

1. Backend-only delivery:
No frontend screens, client-side state managers, design-system tasks, or browser UX artifacts are in scope.
2. Local-first operation:
Primary persistence, replay, audit, and recall must run locally/offline-first with deterministic behavior.
3. Security defaults:
Redaction, tenant/profile isolation, provenance boundaries, and least-privilege assumptions are mandatory defaults.
4. Deterministic and replay-safe updates:
Idempotent ingestion and deterministic state transitions are required for all write paths.
5. Bounded recall:
Recall payloads must enforce max items + token/size budgets with explicit guardrail behavior.
6. Observable backend behavior:
Latency, drift, and policy outcomes must be measurable and auditable.

Constraint tags used in mappings:
- `B`: backend-only
- `L`: local-first
- `S`: security defaults
- `D`: deterministic + idempotent updates
- `R`: bounded recall + guardrails
- `O`: observability/auditability

## Phase 1 Epic Scope Map
| Epic ID | Epic | In Scope | Explicitly Out of Scope | Constraints |
| --- | --- | --- | --- | --- |
| `ums-memory-k0x` | UMS Phase 1 umbrella | Learning-loop backend delivery and interfaces | Frontend product surfaces | `B,L,S,D,R,O` |
| `ums-memory-k0x.3` | P1-00 Backend Foundation | API/CLI/shared backend foundation on template | UI shell, frontend routing | `B,L,S,D,O` |
| `ums-memory-k0x.4` | P1-01 Adaptive Controller | State update core (`z_{t+1}=Phi(z_t,x_t,delta_t)`) | Client-side orchestration logic | `B,D,L,O` |
| `ums-memory-k0x.5` | P1-02 Canonical Memory Layers | Episodic/working/procedural backend layers | Visual memory browsers | `B,L,D,S` |
| `ums-memory-k0x.6` | P1-03 Entities/Invariants | Conceptual entities + invariants enforcement | UX taxonomy work | `B,D,S,O` |
| `ums-memory-k0x.7` | P1-04 API/CLI Semantics | Stable JSON/API/CLI semantic contracts | Web SDK examples, UI SDKs | `B,D,S,R` |
| `ums-memory-k0x.8` | P1-05 Ingest/Sanitize | Connector-side ingestion sanitization and provenance | Manual frontend import tools | `B,S,D,L` |
| `ums-memory-k0x.9` | P1-06 STM + Sleep | STM buffering and consolidation scheduling | Timeline visualization UI | `B,D,L,O` |
| `ums-memory-k0x.10` | P1-07 Working Diaries | Working-memory diaries/digests services | Rich-text editor UI | `B,D,L,S` |
| `ums-memory-k0x.11` | P1-08 Reflector | Candidate extraction from episodes | Reflection dashboard UI | `B,D,S,O` |
| `ums-memory-k0x.12` | P1-09 Validator | Evidence/contradiction checks | Frontend explainability widgets | `B,D,S,R,O` |
| `ums-memory-k0x.13` | P1-10 Curator | Deterministic delta application to procedural memory | WYSIWYG playbook editors | `B,D,L,S,O` |
| `ums-memory-k0x.14` | P1-11 Decay/Tombstones | Decay, tombstones, anti-pattern inversion | Visual decay heatmaps | `B,D,L,S` |
| `ums-memory-k0x.15` | P1-12 Recall/Guardrails | Memory pack construction + LLM guardrails | Prompt playground UI | `B,R,S,D,O` |
| `ums-memory-k0x.16` | P1-13 Agent Integration | MCP + AGENTS export + feedback hooks | Frontend plugin/gallery pages | `B,D,S,R` |
| `ums-memory-k0x.17` | P1-14 Storage/Encryption | Local-first storage/index/encryption/portability | Cloud-only hosted dependency | `B,L,S,D,O` |
| `ums-memory-k0x.18` | P1-15 Health/Audit/Doctor | Drift checks, audit, doctor backend commands | Web admin panels | `B,O,S,D,L` |

## Phase 2 Epic Scope Map
| Epic ID | Epic | In Scope | Explicitly Out of Scope | Constraints |
| --- | --- | --- | --- | --- |
| `ums-memory-rkf` | UMS Phase 2 umbrella | Enterprise-source backend expansion | Enterprise frontend portal | `B,L,S,D,R,O` |
| `ums-memory-rkf.2` | P2-00 Integration Foundation | Adapter framework for enterprise connectors | UI integration marketplace | `B,D,S,L` |
| `ums-memory-rkf.3` | P2-01 Jira Connector | Jira ingestion + identity/provenance linkage | Jira-themed frontend views | `B,S,D,L,O` |
| `ums-memory-rkf.4` | P2-02 Legacy Ticket Framework | Extensible legacy connector contracts | Per-system frontend dashboards | `B,S,D,L` |
| `ums-memory-rkf.5` | P2-03 Docs Library Connector | Specs/runbooks/PDF ingestion with provenance | Document viewer frontend | `B,S,D,L,R` |
| `ums-memory-rkf.6` | P2-04 Chat Export/API Proxy | Chat export and API proxy ingestion | Chat UI replacement | `B,S,D,L` |
| `ums-memory-rkf.7` | P2-05 Identity Resolution | Cross-source identity merge logic | Visual identity graph tools | `B,S,D,O` |
| `ums-memory-rkf.8` | P2-06 Link Graph | Issue/PR/chat/fix relationship graph backend | Graph explorer UI | `B,D,S,O` |
| `ums-memory-rkf.9` | P2-07 Provenance Boundaries | Source trust boundary enforcement | Manual UI trust override flows | `B,S,D,R,O` |
| `ums-memory-rkf.10` | P2-08 Idempotent Ingestion at Scale | Replay-safe ingestion at enterprise volume | UI import wizard | `B,D,L,S,O` |
| `ums-memory-rkf.11` | P2-09 Conflict Chronology | Time-aware A-then-B conflict engine | Visual chronology timelines | `B,D,S,R,O` |
| `ums-memory-rkf.12` | P2-10 Freshness/Revalidation | Freshness scoring + revalidation cadence | Frontend freshness badges | `B,D,S,R,O` |
| `ums-memory-rkf.13` | P2-11 Recall Ranking | Enterprise multi-source recall ranking | Search UI screens | `B,R,D,S,O` |
| `ums-memory-rkf.14` | P2-12 Tenant Isolation | Isolation hardening and secure defaults | Tenant admin console UI | `B,S,D,R,O` |
| `ums-memory-rkf.15` | P2-13 Audit/Compliance Exports | Compliance-grade backend exports/logs | Compliance dashboard frontend | `B,S,D,O,L` |
| `ums-memory-rkf.16` | P2-14 Scale/Perf/Cost Controls | Latency, throughput, and cost-control guardrails | Cost analytics frontend | `B,O,D,L,R` |
| `ums-memory-rkf.17` | P2-15 Rollout/Migration/Backfill | Migration/backfill operations and rollout controls | Guided migration UI wizard | `B,L,S,D,O` |

## Consequences
- Phase planning remains backend-focused and testable with Node runtime tooling.
- Cross-epic contracts share one interpretation of local-first and security defaults.
- Guardrails and bounded recall become release blockers, not optional enhancements.
