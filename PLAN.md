# PLAN_FOR_UNIVERSAL_MEMORY_SYSTEM.md
**Project:** Universal Memory System (UMS) — persistent memory across coding agents + chat UIs  
**Goal:** One memory substrate, many LLMs. Multi-year retention. Evidence-backed recall. Controlled forgetting.  
**Based on:** CASS/cass-memory planning patterns (ACE pipeline, 3-layer memory) + NCM/BioCortexAI neuromorphic principles (STM/LTM, diffusion/homeostasis, consolidation “sleep”, constant-latency aspiration).

---

## Table of Contents (11 Major Sections)
1. Executive Summary  
2. Core Architecture  
3. Conceptual Data Model (no schema yet)  
4. API / CLI Surface (commands & JSON contracts)  
5. Reflection & Consolidation Pipeline  
6. Integration (connectors, sanitization, ingestion)  
7. LLM Integration (provider abstraction, prompts, guardrails)  
8. Storage & Persistence (local-first, portability, indices)  
9. Agent Integration (MCP, AGENTS.md, feedback hooks)  
10. Implementation Roadmap (phased delivery)  
11. Comparison Matrix (CASS vs NCM vs RAG vs naïve summaries)

---

# 1) Executive Summary

## The Problem
AI assistants and coding agents generate **valuable knowledge** (decisions, fixes, patterns, user preferences, “gotchas”), but that knowledge is:
- **Trapped** inside sessions and vendor silos (Claude ↔ ChatGPT ↔ Gemini ↔ CLI agents).
- **Non-portable** across tools and interfaces.
- **Hard to trust** (summaries collapse detail; “learned rules” fossilize; hallucinations get re-stored).
- **Time-unstable** (what was true last year may be wrong today).

## The Solution (UMS)
A memory system that treats “memory” as a **closed-loop control system**, not just a database:

### Three-layer cognitive architecture (CASS-style)
- **Episodic Memory:** immutable ground-truth events (raw logs, tickets, docs, commits).
- **Working Memory:** structured summaries / diaries / session digests.
- **Procedural Memory:** distilled rules, anti-patterns, and playbooks with decay + evidence.

### Neuromorphic substrate option (NCM-style)
A **dynamic associative layer** that supports:
- **STM/LTM separation**
- **diffusion + homeostasis** (gradual forgetting)
- **consolidation “sleep”** events
- **constant-latency aspiration** via fixed-capacity indices and local computation

> Key idea: procedural rules should be evidence-backed and stable; associative recall should be fast and adaptive.

## Key Innovations We Want (as product requirements)
1. **Evidence-backed memory** (every rule points to episodes; no “floating truths”).
2. **Deterministic curation** (memory evolves by deltas; avoid catastrophic rewrite).
3. **Controlled forgetting** (decay + tombstones + diffusion-style fading).
4. **Chronological conflict handling** (A was true, later B replaced A; both remain but context differs).
5. **Cross-agent transfer** (anything learned anywhere becomes reusable everywhere).
6. **Feedback-as-signal** (human correction + runtime outcomes become “pain”/error signals driving updates).
7. **Security by default** (local-first storage, encryption, redaction, isolation per profile/tenant).

## What “Success” Looks Like
- You ask: “We solved something like this before — how?”  
  → UMS returns:
  - the exact prior episode(s) and artifacts,
  - the distilled fix rule(s),
  - what failed previously (anti-pattern),
  - whether a human corrected the AI,
  - what changed since (freshness/decay warnings).

---

# 2) Core Architecture

## 2.1 Conceptual model
UMS is an **adaptive memory controller** operating on event streams.

### State update (unifying equation)
Let:
- `x_t` = new input event (chat message, agent log chunk, Jira update, commit, etc.)
- `z_t` = full memory state (symbolic + associative + statistics)
- `δ_t` = error/pain signal (explicit feedback, failures, regressions, “this was wrong”)

Then:
- **Write/Update:** `z_{t+1} = Φ(z_t, x_t, δ_t)`
- **Recall for task/query q:** `m_t = R(z_t, q)` returning a bounded “memory pack” for prompting/tools.

This captures both:
- CASS: deltas, confidence decay, rule promotion/demotion.
- NCM: diffusion, homeostasis, STM→LTM consolidation.

## 2.2 Memory layers (canonical)
### A) Episodic Memory (ground truth)
- Immutable events with timestamps + provenance.
- Never “edited”, only supplemented.
- Can be huge; retrieval relies on indices/pointers.

### B) Working Memory (structured)
- Session diary, ticket digest, project decision summary, meeting notes, etc.
- May be regenerated (but always traceable to episodes).

### C) Procedural Memory (rules + anti-patterns)
- Compact, high-value knowledge for future actions.
- Has *confidence*, *decay*, *evidence*, *scope*.

## 2.3 Associative substrate (optional but powerful)
Inspired by NCM/BioCortexAI:
- Two-level **STM/LTM** buffering.
- **Consolidation events** that filter noise and keep LTM compact.
- **Diffusion + homeostasis** that naturally fades unreinforced traces.
- Fast recall via local candidate selection (top-k), not scanning everything.

## 2.4 The ACE pipeline (CASS-style)
We adopt a modular pipeline:
1. **Generator (Context hydration):** assemble task-specific memory pack.
2. **Reflector:** extract candidate learnings from recent episodes.
3. **Validator:** test candidate rules against evidence (episodic store).
4. **Curator:** apply deterministic deltas into procedural memory.

## 2.5 Seven design principles (non-negotiables)
1. **Agent-agnostic:** works with any chat/agent tool.
2. **Evidence-first:** rules must cite episodes; never pure claims.
3. **Delta-only procedural updates:** no full playbook rewrites.
4. **Time-aware truth:** memory is versioned by time and scope.
5. **Degraded-mode usable:** still works if LLM/offline/index missing.
6. **Safety & isolation:** profiles/tenants never leak across.
7. **Observability:** every recall explains *why* it was retrieved.

---

# 3) Conceptual Data Model (no schema yet)

> We intentionally avoid a concrete DB schema in this phase. We only define *conceptual entities* and invariants.

## Entities (conceptual)
- **Event / Episode:** immutable piece of ground truth (message, log chunk, issue update).
- **Artifact:** file, diff, snippet, attachment; linked to events.
- **Diary / Digest:** structured summary of a bounded episode set.
- **Rule:** procedural guidance with confidence and evidence.
- **Anti-pattern:** “DON’T do X”, created from harmful outcomes.
- **Decision Record:** “We chose A over B because…”
- **Outcome:** success/failure + metrics + links to rules used.
- **Correction:** explicit human fix of model output (strong negative signal).
- **Profile / Memory Space:** work vs personal vs project vs customer-support; isolation boundary.
- **Pointer:** compact reference to episodic evidence (query + ids).

## Invariants
- Every Rule/Anti-pattern must link to ≥1 Episode (directly or via Diary).
- No destructive edits of Episodes; only append tombstones/annotations.
- Any recall payload is bounded by strict token/size budgets.
- Any cross-space retrieval requires explicit allowlist policy.

---

# 4) API / CLI Surface (commands & JSON contracts)

We want an interface that is:
- **tool-friendly** (JSON-first, stable contracts),
- implementable as **CLI + MCP server + HTTP API**,
- easy to call from agents *and* web chat wrappers.

## Core verbs (conceptual)
- `ingest`: add events (from agents/chats/Jira).
- `context`: get memory pack for a task/query.
- `reflect`: produce candidate deltas from recent episodes.
- `validate`: evidence-check deltas against episodic history.
- `curate`: apply deltas deterministically.
- `feedback / mark`: helpful/harmful signals tied to outcomes.
- `outcome`: record task outcome + rules used.
- `audit`: scan for violations, stale rules, contradictions.
- `export`: produce agent-friendly docs (AGENTS.md / playbook).
- `doctor`: health check for indices, encryption, budgets.

> We will define concrete JSON shapes after we agree on semantics.

---

# 5) Reflection & Consolidation Pipeline

## 5.1 Scheduling
Two clocks:
- **Interaction clock:** runs per event/session.
- **Sleep clock:** consolidation triggered periodically or by fatigue threshold (write load/novelty).

## 5.2 Pipeline stages (detailed)
1. **Ingest & sanitize** (PII/secret redaction + provenance)
2. **Chunk & classify** (what kind of event is this?)
3. **Write to STM** (buffer)
4. **Consolidate → LTM** (sleep):
   - keep stable + reinforced traces
   - merge duplicates
   - demote noisy traces
5. **Reflect**:
   - propose new rules / anti-patterns / decisions
6. **Validate**:
   - check for supporting evidence in episodic store
   - check for contradictions / staleness
7. **Curate**:
   - apply deltas to procedural memory
   - update decay/weights
8. **Audit & health**:
   - detect drift, stale rules, poisoning attempts

## 5.3 Feedback as “pain signal”
- Explicit: “this is wrong”, thumbs-down, human rewrite.
- Implicit: test failures, regressions, repeated reopenings of tickets.
These signals should:
- increase harmful weight
- trigger rule inversion to anti-pattern
- accelerate decay of stale advice

---

# 6) Integration (connectors, sanitization, ingestion)

## Sources we must support
- Coding agents: Claude Code, Codex CLI, Gemini CLI, Cursor logs, etc.
- Chat UIs: ChatGPT, Gemini, Claude, AI Studio (via exports / browser extension / API proxy).
- Work systems: Jira, GitHub, Slack/Email (optional), legacy ticketing/CRM/orders.
- Docs: specs, runbooks, ADRs, PDFs (document library cooperating with memory).

## Key requirements
- Idempotent ingestion (replays don’t duplicate).
- Strong provenance: every item knows its origin.
- Secret/PII sanitization before persistence.
- “Trust boundaries”: internal vs public vs customer.

---

# 7) LLM Integration (provider abstraction, prompts, guardrails)

## 7.1 Memory pack design
A recall output must include:
- **top rules** (procedural memory)
- **anti-patterns**
- **evidence pointers** (episodes to open if needed)
- **freshness warnings** (decay, last validated date)
- **conflict notes** (A then later B; choose based on time/scope)

## 7.2 Prompting contract
- Memory is **advice**, not truth.
- Model must cite evidence when making critical claims (“here’s the prior ticket”).
- Any memory item must be ignorable if conflicts with current requirements.

## 7.3 Guardrails
- Prevent prompt injection via memory: never store raw untrusted instructions as “rules” without validation.
- Isolation: no retrieval across profiles unless allowed.
- Size budgets and truncation policies.

---

# 8) Storage & Persistence (local-first, portability, indices)

## Principles
- Local-first, encrypt-at-rest.
- Portable memory bundle (backup/export/import).
- Append-only core (episodes).
- Derived stores (working/procedural/indices) are regenerable.

## Constant-footprint aspiration
Even if episodes grow, we can keep *associative recall* stable via:
- fixed-size caches
- bounded STM
- bounded “active” procedural set + tombstones
- archival tiers for old episodes

---

# 9) Agent Integration (MCP, AGENTS.md, feedback hooks)

## Required agent patterns
- Pre-flight: always call `context` before non-trivial tasks.
- Inline feedback: agents annotate when a rule helped/hurt.
- Outcome logging: task success/failure with rules used.
- Export: write AGENTS.md/CLAUDE.md snippets so tools self-teach.

## Multi-agent swarm compatibility
- Concurrency: file reservations; memory locks; deterministic merges.
- A “commit agent” pattern (clean history).

---

# 10) Implementation Roadmap (phased delivery)

## Phase P0 — Foundations (highest ROI)
- Ingestion for coding agent logs + chat exports
- Episodic store + indexing + `context` recall (basic)
- Manual feedback (helpful/harmful) + outcome logging
- Security: redaction + encryption + profile isolation

## Phase P1 — Learning loop
- Working memory diaries
- Reflection pipeline (reflect → validate → curate)
- Confidence decay + tombstones + anti-pattern inversion
- Health checks + audit + drift detection

## Phase P2 — Enterprise sources
- Jira + legacy tickets + docs library
- Cross-source linking (issue ↔ PR ↔ chat ↔ fix)
- Better conflict handling and freshness UI

## Phase P3 — Personalization / tutoring
- Learner profiles
- Misconception tracking via feedback loops
- Memory-driven curriculum planning (spaced repetition, interests)

---

# 11) Comparison Matrix (CASS vs NCM vs RAG)

## CASS/cass-memory strengths
- Evidence-backed procedural rules (playbooks)
- Deterministic curation prevents context collapse
- Confidence decay + anti-pattern learning
- Great for coding-agent workflows

## NCM/BioCortexAI strengths
- Associative recall with diffusion/homeostasis
- STM/LTM + consolidation “sleep”
- Constant-latency aspiration; local computation
- Great for long-horizon conversational continuity and personalization

## RAG strengths
- Exact quoting from documents
- Easy to plug into existing stacks
- Good for “document truth” and compliance

## UMS goal
Hybridize:
- **RAG for exactness**
- **CASS for procedural reliability**
- **NCM principles for long-term adaptive recall**
