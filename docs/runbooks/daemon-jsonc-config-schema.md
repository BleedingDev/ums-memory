# UMS Daemon JSONC Config Schema

## Goal

Define the concrete static config contract for the daemon-first CLI runtime so config loading, validation, routing, and editor integration can proceed without re-opening product semantics.

Related decisions:

- `docs/adr/0011-daemon-config-and-credential-model.md`
- Bead `ums-memory-c0j.13`

Schema artifact:

- `docs/schema/ums-daemon-config.schema.json`

## Files and Ownership

- User-editable config: `~/.ums/config.jsonc`
- Runtime state directory: `~/.ums/state/`
- Credentials: OS secure storage referenced by `credentialRef`
  The daemon treats config and state as separate concerns:
- config is declarative and portable,
- state is runtime-owned and mutable,
- credentials are external to both.

## Top-Level Shape

```jsonc
{
  "version": 1,
  "state": {
    "rootDir": "~/.ums/state",
    "journalDir": "~/.ums/state/journal",
    "checkpointDir": "~/.ums/state/checkpoints",
    "compactDeliveredAfterHours": 168,
  },
  "accounts": {},
  "memories": {},
  "sources": {},
  "routes": [],
  "defaults": {},
  "policy": {},
}
```

## Entity Model

### `accounts`

Named backends or hosting targets.

Supported types in v1:

- `local`
- `http`

`local` accounts:

- keep data local-first
- require no auth block

`http` accounts:

- require `apiBaseUrl`
- require `auth`

Supported auth modes in v1 schema:

- secure/default:
  - `oauth-device`
  - `oidc-pkce`
  - `session-ref`
- explicit fallback:
  - `token-env`

Rules:

- plaintext tokens do not belong in config
- secure modes require `credentialRef`, but CLI should generate a platform-native default when omitted
- `token-env` is an explicit fallback, not the preferred managed-user path
- secure session material is stored via `ums account login`, not embedded into `config.jsonc`

### `memories`

Named logical destinations.

Each memory binds to:

- `account`
- `storeId`
- `profile`

Optional selectors:

- `project`
- `workspace`
- `readOnly`
- `tags`

Rules:

- memory names are stable aliases used by CLI and routes
- a memory must reference an existing account
- `storeId/profile` remain the backend-serving boundary
- `project/workspace` are routing/provenance selectors layered on top

### `sources`

Collector configuration for supported adapters.

Supported adapters in v1 schema:

- `codex`
- `claude`
- `cursor`
- `opencode`
- `vscode`
- `codexNative`
- `plan`

Each adapter may override:

- `enabled`
- `roots`
- `includeGlobs`
- `excludeGlobs`

Managed source bindings live under:

- `sources.bindings`

Each binding records:

- `source`
- `kind`
- `path`
- `status`
- optional `id`, `label`, `health`, `lastSeenAt`

Shared defaults:

- `scanIntervalMs`
- `maxEventsPerCycle`

### `routes`

Deterministic mapping rules from source provenance to a named memory.

Allowed match keys in v1:

- `pathPrefix`
- `repoRoot`
- `workspaceRoot`
- `source`

Each route must define:

- `match`
- `memory`

Optional routing metadata:

- `priority`
- `project`
- `workspace`
- `notes`

### `defaults`

Global fallback behavior.

Required fields:

- `memory`
- `onAmbiguous`

`onAmbiguous` options:

- `review`
- `default`
- `drop`

### `policy`

Cross-cutting daemon guardrails.

Supported controls in v1 schema:

- `allowEnvTokenFallback`
- `allowPlaintextDevAuth`
- `requireProjectForManagedWrites`
- `managedMemoryPrefixes`

## Validation Rules Beyond Raw Schema

JSON Schema covers structural shape, but runtime validation must also enforce:

1. Referential integrity:

- every memory references an existing account
- every route references an existing memory
- `defaults.memory` references an existing memory

2. Secure defaults:

- `allowPlaintextDevAuth` defaults to `false`
- managed memories must not use insecure auth unless explicitly allowed

3. Route sanity:

- exact duplicate routes are rejected
- conflicting exact-match routes are rejected
- overlapping prefix routes are allowed only with deterministic precedence

4. Path normalization:

- paths are normalized to absolute canonical form before comparison
- trailing separators are removed before persistence

5. Canonical output:

- CLI writers persist config in stable key order
- stable serialization is required for deterministic diffs and explain output

## Routing Resolution Contract

Routing precedence:

1. explicit event/session override
2. exact `repoRoot` or `workspaceRoot` match
3. longest `pathPrefix`
4. global default memory

Tie-breakers:

1. higher `priority`
2. more specific match kind (`repoRoot` > `workspaceRoot` > `pathPrefix`)
3. lexical stable order on route identity

If no route resolves cleanly:

- `review`: journal event and emit unresolved-routing record
- `default`: send to `defaults.memory`
- `drop`: reject delivery but preserve audit/journal trace

## Pre-release Cutover Contract

UMS is still pre-release, so `config.jsonc` is the only supported daemon configuration source.

Implications:

- there is no required compatibility migration path from `account-session.json`
- breaking changes in config/state shape are allowed while the daemon surface is still stabilizing
- docs and CLI should optimize for the target architecture, not for preserving the prototype session model

## CLI Contract (Target)

Config creation and validation should be primarily CLI-driven:

- `ums config init`
- `ums config validate`
- `ums config doctor`
- `ums account add ...`
- `ums account login ...`
- `ums account logout ...`
- `ums memory add ...`
- `ums route add ...`
- `ums route explain ...`

The CLI may write `config.jsonc`, but manual edits remain supported if validation passes.

## Editor Integration

Target editor support:

- associate `~/.ums/config.jsonc` with `docs/schema/ums-daemon-config.schema.json`
- provide autocomplete and inline diagnostics
- keep schema versioned with the daemon config `version`

## Non-Goals

- Executable `ums.config.ts` as the default path
- Plaintext managed-user secrets in config
- Remote MCP transport configuration
- Connector-specific project heuristics beyond the contract boundary
