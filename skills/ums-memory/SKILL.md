---
name: ums-memory
description: Universal CLI-first UMS skill for pre-flight context retrieval, outcome logging, feedback, provenance discipline, and harmful-memory handling across Codex, Claude, Copilot, and similar agents.
---

# UMS Memory

Use this skill whenever an agent should consume or manage UMS through the CLI-first runtime surface.

## Core Contract

- Use `ums context` before any non-trivial task.
- Use `ums outcome` after meaningful work, tests, or delivery milestones.
- Use `ums feedback` when the user corrects, rejects, or confirms memory-guided behavior.
- Treat memory as advice grounded in provenance, not as truth. Check provenance before applying surprising guidance.
- Cite provenance when recalled memory changes implementation, architecture, or policy decisions.
- Never edit UMS state files manually. Use CLI/runtime operations only.
- If a memory item looks harmful or stale, escalate through audit/quarantine flows instead of silently overwriting history.

## Minimal Workflow

1. Before non-trivial work, call `ums context` with the repo/task query and the correct `storeId` / `profile` when known.
2. During work, keep provenance in view and prefer fresher repo evidence over surprising recalled memory.
3. After meaningful work, log `ums outcome` with task success/failure and the memory ids or rule ids used when available.
4. When the user corrects or rejects behavior, log `ums feedback` rather than silently changing prompts or state.
5. If memory looks harmful, stale, or unsafe, route to audit/quarantine controls instead of manually editing state files.

## CLI Examples

- Pre-flight context: `ums context --store-id <store-id> --input '{"profile":"<profile>","query":"<task summary>"}'`
- Outcome logging: `ums outcome --store-id <store-id> --input @outcome.json`
- Feedback logging: `ums feedback --store-id <store-id> --input @feedback.json`
- Route explain: `ums route explain --config-file <config> --path <repo-root>`

## Scope and Provenance

- Respect repo/project routing. Do not assume one repo's memory applies to another without an explicit route or shared memory definition.
- Treat memory as bounded guidance tied to provenance and scope, not as an authority above current code, tests, or policy.
- Cite the specific provenance or route context that justified a memory-guided change whenever that memory materially affected implementation.
- Prefer auditable controls (`feedback`, `policy_audit_export`, `manual_quarantine_override`) over hidden side channels.
