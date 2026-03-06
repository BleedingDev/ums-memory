# ADR-0011: Daemon Config, Credential, and Multi-Account Routing Model
Date: 2026-03-06
Status: Proposed

## Context
UMS is moving to a daemon-first, CLI-first product surface for both solo and managed users. The current account-linked sync prototype stores one login plus one `storeId/profile` connection in a flat session file and posts every collected event into that single target. That model is sufficient for a first prototype, but it does not support the required end state:

- multiple remotes or hosting targets active at the same time,
- named memories routed by project/folder/workspace rules,
- safe fan-out delivery without event loss when one remote fails,
- secret handling appropriate for enterprise login flows,
- one external UX for solo and managed users.

This ADR resolves bead `ums-memory-c0j.1`.

## Decision
UMS adopts a declarative JSONC daemon-config model with keychain-backed credentials and first-class multi-account routing:

1. Declarative config format:
UMS uses a static `JSONC` config file as the default user-editable daemon configuration format. Executable TypeScript config is not the default path.
2. Config object model:
The config model is built around four user-facing entities:
   - `accounts`: local or remote backends plus auth mode and credential reference.
   - `memories`: named logical targets that bind to an `account` plus backend `storeId/profile` and optional project/workspace selectors.
   - `routes`: deterministic path/repo/workspace rules that map collected events to a named `memory`.
   - `defaults` and `policy`: default memory, ambiguity behavior, retention, and operator overrides.
3. Secrets out of config:
Secrets are not stored in the JSONC config. The config stores only a `credentialRef` or equivalent reference. User-device credentials must live in OS secure storage (Keychain, Credential Manager, Secret Service/libsecret) unless an explicit dev/CI fallback is requested.
4. Managed login posture:
Managed/company accounts use browser/device/SSO style login flows where possible. The daemon stores refresh/session material in secure storage and keeps short-lived access tokens in memory, not in the config file.
5. Solo and managed parity:
Solo and managed users use the same CLI concepts (`account`, `memory`, `route`, `status`, `doctor`, `sync`). Managed mode differs only by enrollment/auth behavior and backend policy enforcement.
6. CLI as primary writer:
The CLI is the canonical way to create and mutate config entries. Manual editing is allowed, but the config must pass schema validation before the daemon accepts it.
7. Schema-first type safety:
Type safety is enforced through strict schema validation, generated runtime types, and validation/explain commands. Config type safety does not depend on executing user-provided code.
8. Local journal plus per-target delivery state:
The daemon must first persist normalized collected events into a local append-only journal. Delivery and acknowledgement state are tracked per destination memory/account target, not with one global cursor only.
9. Deterministic routing precedence:
Routing resolution must be deterministic with the following precedence:
   - explicit event/session override,
   - exact repo/workspace match,
   - longest path-prefix route,
   - source-specific default,
   - global default.
10. Ambiguity fails safe:
If a source event cannot be assigned to a project or memory target with sufficient confidence, the daemon must follow explicit policy (`review`, `default`, or `drop`) instead of guessing silently.
11. Insecure fallback is explicit:
Environment-variable or plaintext-token auth paths are allowed only as explicit dev/CI fallback modes. They are not the default onboarding path for user devices.
12. Pre-release cutover is allowed:
Because UMS is not yet released, the flat legacy session model is not a compatibility target. The daemon may hard-cut to `config.jsonc` instead of shipping a migration layer.

Constraint tags used in mappings:
- `B`: backend-only
- `L`: local-first
- `S`: security defaults
- `D`: deterministic + idempotent updates
- `R`: bounded recall + guardrails
- `O`: observability/auditability

## Scope
In scope:
- Default daemon config file format and config object model.
- Secret-handling posture for local user devices.
- Named account/memory/route concepts.
- Deterministic routing precedence and ambiguity policy.
- Local journal and per-target delivery-checkpoint requirement.
- Solo versus managed parity for config and CLI shape.

Out of scope:
- Remote MCP gateway design.
- Frontend policy/config editing UI.
- Full OAuth/SSO implementation details for every identity provider.
- Connector-specific project-classification heuristics beyond the required contract boundary.
- A compatibility migration path from the flat legacy session file.

## Acceptance Criteria
1. Config contract:
One documented JSONC schema covers accounts, memories, routes, defaults, and policy controls.
2. Secret handling:
The default onboarding path stores user-device credentials outside the config file.
3. Multi-account readiness:
The model supports multiple simultaneously configured accounts and multiple destination memories.
4. Routing determinism:
Folder/repo routing precedence and ambiguity behavior are explicit and testable.
5. Delivery safety:
The design requires a local journal plus per-target delivery checkpoints before multi-target fan-out ships.
6. UX parity:
Solo and managed users use the same external CLI concepts; only enrollment differs.
7. Type-safety posture:
The accepted path is declarative config plus schema validation, not executable config as the default.

## Consequences
Positive:
- Separates backend scope fields from user-facing config concepts cleanly.
- Makes multi-account and future multi-hosting support possible without daemon duplication.
- Removes plaintext config secrets from the default user path.
- Keeps config auditable, deterministic, and editor-friendly.
- Preserves one product surface across solo and managed deployments.

Costs:
- Requires keychain integration and auth-session lifecycle work.
- Adds config-schema, validation tooling, and hard-cut cleanup of the prototype session flow.
- Requires a delivery journal and more precise checkpoint handling than the current prototype.

## Reference JSONC Shape
```jsonc
{
  "version": 1,
  "accounts": {
    "local": {
      "type": "local"
    },
    "company": {
      "type": "http",
      "apiBaseUrl": "https://ums.company.internal",
      "auth": {
        "mode": "oauth-device",
        "credentialRef": "keychain://ums/company"
      }
    }
  },
  "memories": {
    "personal": {
      "account": "local",
      "storeId": "personal",
      "profile": "main"
    },
    "company-new-engine": {
      "account": "company",
      "storeId": "coding-agent",
      "profile": "developer-main",
      "project": "new-engine"
    }
  },
  "routes": [
    {
      "match": {
        "pathPrefix": "/Users/satan/Developer/new-engine"
      },
      "memory": "company-new-engine"
    },
    {
      "match": {
        "pathPrefix": "/Users/satan/Developer"
      },
      "memory": "personal"
    }
  ],
  "defaults": {
    "memory": "personal",
    "onAmbiguous": "review"
  }
}
```

## Required Follow-ups
- `ums-memory-c0j.13`: define and validate the JSONC daemon config schema as the single source of truth.
- `ums-memory-c0j.14`: integrate keychain-backed credential storage and secure managed login flow.
- `ums-memory-c0j.15`: implement named accounts, memories, and route-registry CLI commands.
- `ums-memory-c0j.16`: add local ingest journal and per-target delivery checkpointing.
- `ums-memory-c0j.17`: implement deterministic project/path routing plus ambiguity explain tooling.
