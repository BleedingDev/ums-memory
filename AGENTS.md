# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Lean Agent Flywheel Workflow (Default)

This project uses a lightweight flywheel loop:
**triage -> claim -> implement -> validate -> close -> repeat**.

### Role model (default)

1. **Claude (`cc`)** owns frontend work (UI, UX, client state, integration in FE code).
2. **Codex (`cod`)** owns backend work (API, services, DB, infra/backend logic).
3. **Gemini (`gmi`)** owns reviews and quality control (cross-check FE/BE contracts, test gaps, regressions, risk notes).

Use role ownership as default routing, not a hard wall. For cross-cutting beads, split into FE/BE sub-beads and let Gemini review the boundary.

### 1) Spawn the swarm

Use the project templates:

```bash
ntm spawn ums-memory -r simple   # 2 cc, 3 cod, 1 gmi
ntm spawn ums-memory -r complex  # 3 cc, 6 cod, 2 gmi
```

### 2) Kick off work immediately (required)

`ntm spawn` starts agents, but does not auto-assign useful work by itself.
Immediately send role-specific kickoff prompts:

```bash
ntm send ums-memory --cc "Role: Frontend lead. Read AGENTS.md + PLAN.md. Pull FE-tagged or UI-impact beads first. Follow the bead loop strictly and hand off API contract questions early."
ntm send ums-memory --cod "Role: Backend lead. Read AGENTS.md + PLAN.md. Pull BE-tagged or service/data beads first. Follow the bead loop strictly and publish clear API/contract notes for FE."
ntm send ums-memory --gmi "Role: Reviewer/QA lead. Read AGENTS.md + PLAN.md. Continuously review active FE/BE work, catch contract mismatches, test gaps, and regressions. Open/assign follow-up beads when needed."
ntm send ums-memory --all "Global loop: (1) run 'bd ready' and pick one unblocked item, (2) claim with 'bd update <id> --status in_progress', (3) implement smallest shippable step, (4) run relevant tests/lint, (5) commit with bead id in message, (6) close with 'bd close <id>', (7) repeat. If blocked >10 minutes, update/create blocking bead and switch."
```

### 3) Per-agent execution rules

1. Always claim a bead before changing code.
2. Keep changes small and focused to one bead.
3. Run the nearest relevant quality gate before committing.
4. Close or update bead status before switching context.
5. Respect role ownership first (`cc` FE, `cod` BE, `gmi` review), then collaborate through handoffs.

### 4) Cooperation protocol

1. FE/BE dependency? Create or update a contract bead with request/response schema and acceptance criteria.
2. Codex publishes backend contract updates early; Claude integrates against that contract.
3. Gemini reviews both sides before close and flags mismatches immediately.
4. If work spans both FE and BE, split into two linked beads plus one review bead.
5. When blocked by another role, send a short Agent Mail message and switch to next ready bead.

### 5) Coordination without overengineering

1. Use Agent Mail only for: file conflicts, blockers, and handoffs.
2. Do not introduce extra orchestration layers unless current flow breaks.
3. Prefer direct `bd` + `git` + `ntm send` over custom wrappers.

### 6) Integration cadence

1. Pick one integrator agent for sync/push steps during a swarm session.
2. Integrator cadence: every 30-60 minutes and at session end:
   `git pull --rebase && bd sync && git push`.
3. Other agents should avoid blind rebases while active work is in flight.

### 7) Tooling policy (minimal stack)

Required:

- `ntm` (spawn/send/status/kill)
- `bd` (ready/update/close/sync)
- `git`
- project test/lint/build commands

Optional (only when needed):

- `ntm mail` for coordination
- `ntm scan` for extra quality checks
- `cm`/`cass` for history/context lookup

Avoid making progress depend on fragile or partially-working automation.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
