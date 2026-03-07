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

## Daemon-First Account-Linked Auto Ingestion (Target Model)

Use this when developers should continuously contribute local knowledge into one or more local/managed memories.

ADR reference:

- `docs/adr/0011-daemon-config-and-credential-model.md`
- `docs/runbooks/daemon-jsonc-config-schema.md`
- `docs/runbooks/daemon-lifecycle-parity-recovery.md`

Target operator flow:

1. Install once per developer machine:
   - `ums install`
2. Authenticate the managed account when needed:
   - `ums account login --name company --secret-stdin`
3. Define named memories:
   - `ums memory add personal --account local --store-id personal --profile main`
   - `ums memory add company --account company --store-id coding-agent --profile developer-main`
4. Define deterministic routes:
   - `ums route add --path ~/Developer/new-engine --memory company`
   - `ums route add --path ~/Developer --memory personal`
   - `ums route set-default --memory personal`
5. Start or inspect the daemon:
   - `ums status`
   - `ums sync`

Target behavior:

- The daemon loads a static JSONC config file, not an executable runtime config.
- Named `accounts`, `memories`, and `routes` drive deterministic path/project routing.
- Secrets are resolved through keychain-backed credential references instead of plaintext config tokens.
- The daemon journals collected events locally before routing/delivery fan-out.
- Solo and managed users see the same CLI concepts; only auth/enrollment differs.

Current runtime note:

- `ums sync`, `ums sync-daemon`, and `ums status` already use `config.jsonc` as the only supported daemon configuration source.
- `ums login` and `ums connect` remain reserved placeholders until secure keychain-backed remote auth lands; they are not part of the active sync path.

Current source adapters:

- `codex`: tails `~/.codex/**/*.jsonl`
- `claude`: tails `~/.claude/{transcripts,projects}/**/*.jsonl`
- `plan`: snapshots local `PLAN.md`

Security notes:

- The target model stores daemon config separately from credentials; the config file contains only credential references, not user-device secrets.
- User-device credentials should live in OS secure storage by default.
- Environment-variable or plaintext-token auth remains a dev/CI-only fallback, not the default managed-user path.
- The old flat `account-session.json` prototype is not part of the intended release path.
- Tokens are redacted from command output and never written to exported UMS state snapshots.
- API authentication still enforces bearer/x-ums-api-key checks server-side.

## Target JSONC Config Shape

The accepted target direction is a schema-validated JSONC config:

```jsonc
{
  "version": 1,
  "accounts": {
    "local": { "type": "local" },
    "company": {
      "type": "http",
      "apiBaseUrl": "https://ums.company.internal",
      "auth": {
        "mode": "oauth-device",
        "credentialRef": "keychain://ums/company",
      },
    },
  },
  "memories": {
    "personal": {
      "account": "local",
      "storeId": "personal",
      "profile": "main",
    },
    "company-new-engine": {
      "account": "company",
      "storeId": "coding-agent",
      "profile": "developer-main",
      "project": "new-engine",
    },
  },
  "routes": [
    {
      "match": { "pathPrefix": "/Users/satan/Developer/new-engine" },
      "memory": "company-new-engine",
    },
    {
      "match": { "pathPrefix": "/Users/satan/Developer" },
      "memory": "personal",
    },
  ],
  "defaults": {
    "memory": "personal",
    "onAmbiguous": "review",
  },
}
```

Routing precedence must remain deterministic:

1. explicit event/session override
2. exact repo/workspace match
3. longest path-prefix route
4. source-specific default
5. global default

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

- `bun run validate:ingestion` runs deterministic fixture-backed `check` mode and compares against `docs/reports/multi-store-ingestion-validation-summary.json` without rewriting it.
- Refresh baseline intentionally when contract behavior changes:
  - `bun run validate:ingestion:refresh`
- Run machine-local diagnostics explicitly (optional, not for CI baselines):
  - `bun run validate:ingestion:local`
- Local diagnostics do not write tracked reports by default.
- If a local report file is needed, write to an explicit non-tracked path:
  - `bun scripts/validate-ingestion.ts --mode local --write-report --output /tmp/ums-ingestion-local.json`
- Writing local diagnostics directly to the tracked deterministic baseline requires explicit `--force` and should be avoided.
- Only commit `docs/reports/multi-store-ingestion-validation-summary.json` when a deterministic baseline refresh is intentional and reviewed.
- If local diagnostics accidentally rewrote the tracked report, restore it before commit:
  - `git restore --source=HEAD -- docs/reports/multi-store-ingestion-validation-summary.json`
