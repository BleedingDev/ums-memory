const P1_CAPABILITIES = [
  {
    id: "P1-00",
    beadId: "ums-memory-k0x.3",
    phase: "P1",
    title: "Backend Foundation on zcp-template (API/CLI/Shared)",
    intent: "Stand up backend-first project architecture and shared domain contracts.",
  },
  {
    id: "P1-01",
    beadId: "ums-memory-k0x.4",
    phase: "P1",
    title: "Adaptive Memory Controller and State Update Core",
    intent: "Implement deterministic z_(t+1)=Phi(z_t,x_t,delta_t) state transitions.",
  },
  {
    id: "P1-02",
    beadId: "ums-memory-k0x.5",
    phase: "P1",
    title: "Canonical Memory Layers (Episodic/Working/Procedural)",
    intent: "Provide explicit memory layer models and transitions across layers.",
  },
  {
    id: "P1-03",
    beadId: "ums-memory-k0x.6",
    phase: "P1",
    title: "Conceptual Entities and Invariants",
    intent: "Define entities, invariants, and error semantics for memory safety.",
  },
  {
    id: "P1-04",
    beadId: "ums-memory-k0x.7",
    phase: "P1",
    title: "API and CLI Semantic Contracts",
    intent: "Establish stable command and JSON contracts for tool integrations.",
  },
  {
    id: "P1-05",
    beadId: "ums-memory-k0x.8",
    phase: "P1",
    title: "Ingest and Sanitize Pipeline",
    intent: "Support trusted, replay-safe ingestion with sanitization boundaries.",
  },
  {
    id: "P1-06",
    beadId: "ums-memory-k0x.9",
    phase: "P1",
    title: "STM Buffer and Sleep Consolidation Engine",
    intent: "Support short-term buffering and deterministic consolidation into long-term memory.",
  },
  {
    id: "P1-07",
    beadId: "ums-memory-k0x.10",
    phase: "P1",
    title: "Working Memory Diaries and Digests",
    intent: "Generate structured, traceable working-memory digests from episodes.",
  },
  {
    id: "P1-08",
    beadId: "ums-memory-k0x.11",
    phase: "P1",
    title: "Reflector Candidate Extraction",
    intent: "Extract candidate learnings and deltas from episodic evidence.",
  },
  {
    id: "P1-09",
    beadId: "ums-memory-k0x.12",
    phase: "P1",
    title: "Validator Evidence and Contradiction Checks",
    intent: "Require evidence and contradiction checks prior to curation.",
  },
  {
    id: "P1-10",
    beadId: "ums-memory-k0x.13",
    phase: "P1",
    title: "Curator Delta Application and Procedural Updates",
    intent: "Apply procedural memory deltas deterministically and incrementally.",
  },
  {
    id: "P1-11",
    beadId: "ums-memory-k0x.14",
    phase: "P1",
    title: "Decay, Tombstones, and Anti-pattern Inversion",
    intent: "Support confidence decay, tombstones, and harmful guidance inversion.",
  },
  {
    id: "P1-12",
    beadId: "ums-memory-k0x.15",
    phase: "P1",
    title: "Recall Memory Pack and LLM Guardrails",
    intent: "Return bounded recall packs with evidence, freshness, and conflict notes.",
  },
  {
    id: "P1-13",
    beadId: "ums-memory-k0x.16",
    phase: "P1",
    title: "Agent Integration (MCP, AGENTS export, Feedback Hooks)",
    intent: "Expose backend memory loops to coding agents and UI toolchains.",
  },
  {
    id: "P1-14",
    beadId: "ums-memory-k0x.17",
    phase: "P1",
    title: "Storage, Indexing, Encryption, and Portability",
    intent: "Provide resilient storage/index abstractions for local-first portability.",
  },
  {
    id: "P1-15",
    beadId: "ums-memory-k0x.18",
    phase: "P1",
    title: "Health Checks, Audit, Drift Detection, and Doctor",
    intent: "Instrument health, audit, and drift signals for continuous reliability.",
  },
];

const P2_CAPABILITIES = [
  {
    id: "P2-00",
    beadId: "ums-memory-rkf.2",
    phase: "P2",
    title: "Enterprise Integration Foundation on zcp-template Adapters",
    intent: "Provide enterprise adapter contracts for source-specific integrations.",
  },
  {
    id: "P2-01",
    beadId: "ums-memory-rkf.3",
    phase: "P2",
    title: "Jira Connector",
    intent: "Ingest and reconcile Jira issues with strong provenance and replay safety.",
  },
  {
    id: "P2-02",
    beadId: "ums-memory-rkf.4",
    phase: "P2",
    title: "Legacy Ticket Connector Framework",
    intent: "Provide connector scaffolding for heterogeneous ticketing systems.",
  },
  {
    id: "P2-03",
    beadId: "ums-memory-rkf.5",
    phase: "P2",
    title: "Docs Library Connector (Specs, Runbooks, PDFs)",
    intent: "Integrate document sources with pointer-based evidence retrieval.",
  },
  {
    id: "P2-04",
    beadId: "ums-memory-rkf.6",
    phase: "P2",
    title: "Chat Export and API Proxy Connectors",
    intent: "Ingest chat transcripts and proxy event streams across chat providers.",
  },
  {
    id: "P2-05",
    beadId: "ums-memory-rkf.7",
    phase: "P2",
    title: "Cross-source Identity Resolution",
    intent: "Resolve entity identities across source systems and sessions.",
  },
  {
    id: "P2-06",
    beadId: "ums-memory-rkf.8",
    phase: "P2",
    title: "Cross-source Link Graph (Issue-PR-Chat-Fix)",
    intent: "Link evidence across artifacts to explain causality and history.",
  },
  {
    id: "P2-07",
    beadId: "ums-memory-rkf.9",
    phase: "P2",
    title: "Provenance and Trust Boundary Enforcement",
    intent: "Enforce trust boundaries and provenance checks across integrations.",
  },
  {
    id: "P2-08",
    beadId: "ums-memory-rkf.10",
    phase: "P2",
    title: "Replay-safe Idempotent Ingestion at Scale",
    intent: "Guarantee idempotent ingestion and replay-safe processing at scale.",
  },
  {
    id: "P2-09",
    beadId: "ums-memory-rkf.11",
    phase: "P2",
    title: "Conflict Chronology Engine (A then B)",
    intent: "Represent chronological truth changes and conflict resolution notes.",
  },
  {
    id: "P2-10",
    beadId: "ums-memory-rkf.12",
    phase: "P2",
    title: "Freshness Scoring and Revalidation Cadence",
    intent: "Track staleness and trigger rule revalidation workflows.",
  },
  {
    id: "P2-11",
    beadId: "ums-memory-rkf.13",
    phase: "P2",
    title: "Enterprise Recall Ranking Across Sources",
    intent: "Rank recall candidates across sources with deterministic heuristics.",
  },
  {
    id: "P2-12",
    beadId: "ums-memory-rkf.14",
    phase: "P2",
    title: "Tenant Isolation and Security Hardening",
    intent: "Guarantee tenant-isolated retrieval and secure memory boundaries.",
  },
  {
    id: "P2-13",
    beadId: "ums-memory-rkf.15",
    phase: "P2",
    title: "Audit and Compliance Exports",
    intent: "Export memory lineage for audits, legal review, and compliance.",
  },
  {
    id: "P2-14",
    beadId: "ums-memory-rkf.16",
    phase: "P2",
    title: "Scale, Performance, and Cost Controls",
    intent: "Maintain bounded latency, storage, and compute costs at enterprise scale.",
  },
  {
    id: "P2-15",
    beadId: "ums-memory-rkf.17",
    phase: "P2",
    title: "Rollout, Migration, and Backfill Operations",
    intent: "Support staged rollout, migration, and historical backfill reliability.",
  },
];

export const CAPABILITY_CATALOG = Object.freeze(
  [...P1_CAPABILITIES, ...P2_CAPABILITIES].map((capability) => Object.freeze(capability)),
);

export function getCapabilityCatalog() {
  return CAPABILITY_CATALOG.map((capability) => ({ ...capability }));
}

export function getCapabilitiesByPhase(phase) {
  return CAPABILITY_CATALOG.filter((capability) => capability.phase === phase).map((entry) => ({
    ...entry,
  }));
}

export function findCapability(capabilityId) {
  return CAPABILITY_CATALOG.find((capability) => capability.id === capabilityId) ?? null;
}

export function isKnownCapability(capabilityId) {
  return findCapability(capabilityId) !== null;
}
