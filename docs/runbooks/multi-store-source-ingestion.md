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
