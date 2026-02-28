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
