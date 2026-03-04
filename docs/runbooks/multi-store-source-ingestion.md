# Multi-Store Source Ingestion Runbook

## Goal
Keep unrelated memory domains isolated so coding-agent workflows are not polluted by JIRA/team-history context.

## Store Strategy
- `coding-agent`: Codex CLI and Claude Code conversation history.
- `jira-history`: JIRA/Ferndesk connector exports and ticket/comment history.
- Additional domains should use explicit `storeId` values instead of sharing `default`.

## Request Contract
- API/CLI core operations accept `storeId` and `profile`.
- API also accepts `x-ums-store` header (used when request body omits `storeId`).
- UMS engine ingest/recall accepts `storeId` and `space`.

## Account-Linked Auto Ingestion (CLI)
Use this when developers should continuously contribute local knowledge into a deployed tenant store.

1. Login once per developer machine:
   - `ums login --api-url https://ums.company.internal --token <api-token>`
2. Bind the local machine to a tenant store/profile:
   - `ums connect --store-id coding-agent --profile developer-main --sources codex,claude,plan`
3. `connect` auto-starts `sync-daemon` by default (disable with `--no-auto-start`).
4. Run one deterministic cycle manually:
   - `ums sync`
5. Inspect status/daemon health:
   - `ums status`

Current source adapters:
- `codex`: tails `~/.codex/**/*.jsonl`
- `claude`: tails `~/.claude/{transcripts,projects}/**/*.jsonl`
- `plan`: snapshots local `PLAN.md`

Security notes:
- Session material is stored locally in `~/.ums/account-session.json` (override with `--account-file`).
- Tokens are redacted from command output and never written to exported UMS state snapshots.
- API authentication still enforces bearer/x-ums-api-key checks server-side.

## Supported Ingestion Shapes
- Raw event or event array:
  - `{ storeId, space, source, content, timestamp, metadata }`
- JIRA issue envelope:
  - `{ storeId, space, jiraBaseUrl?, issues: [{ key, fields, comments? }] }`
- Ferndesk export envelope:
  - `{ storeId, space, conversations: [{ id, messages: [...] }] }`
- Agent conversation envelope:
  - `{ storeId, space, platform, conversations: [{ id, messages: [...] }] }`

## Isolation Validation Checklist
1. Ingest JIRA payload into `storeId=jira-history`.
2. Ingest Codex/Claude payload into `storeId=coding-agent`.
3. Query `jira-history` for coding-only terms and confirm zero matches.
4. Query `coding-agent` for JIRA-only terms and confirm zero matches.
5. Verify exported state shows separate stores and per-store totals.

## Notes
- Existing snapshots with top-level `spaces` remain import-compatible and are treated as `storeId=default`.
- New snapshots export under top-level `stores[]` with explicit store totals.

## Validation Artifact Handling
- `npm run validate:ingestion` runs deterministic fixture-backed `check` mode and compares against `docs/reports/multi-store-ingestion-validation-summary.json` without rewriting it.
- Refresh baseline intentionally when contract behavior changes:
  - `npm run validate:ingestion:refresh`
- Run machine-local diagnostics explicitly (optional, not for CI baselines):
  - `npm run validate:ingestion:local`
- Local diagnostics do not write tracked reports by default.
- If a local report file is needed, write to an explicit non-tracked path:
  - `node --import tsx scripts/validate-ingestion.ts --mode local --write-report --output /tmp/ums-ingestion-local.json`
- Writing local diagnostics directly to the tracked deterministic baseline requires explicit `--force` and should be avoided.
- Only commit `docs/reports/multi-store-ingestion-validation-summary.json` when a deterministic baseline refresh is intentional and reviewed.
- If local diagnostics accidentally rewrote the tracked report, restore it before commit:
  - `git restore --source=HEAD -- docs/reports/multi-store-ingestion-validation-summary.json`
