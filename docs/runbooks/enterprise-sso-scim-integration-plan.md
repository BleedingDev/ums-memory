# Enterprise SSO/SCIM Integration Plan (bead `ums-memory-dd2.5`)

## Purpose

Define a backend contract for enterprise identity federation so UMS can accept SSO authentication and SCIM provisioning while preserving tenant isolation, deterministic write behavior, and strict TypeScript + Effect boundaries.

Hard requirement: UMS login and SSO integration must use **Better Auth** as the authentication/control-plane layer.

Operational companion runbook: [Enterprise Identity Rollout Runbook](./enterprise-identity-rollout-runbook.md).

## Scope

In scope:

- Better Auth as the single login/SSO integration boundary (no parallel auth stack).
- SSO authentication/authorization boundary between enterprise IdPs and UMS.
- SCIM entity contracts and mappings into UMS domain tables.
- Deterministic provisioning, deprovisioning, and role/group reconciliation rules.
- Audit/compliance expectations and phased rollout.

Out of scope:

- Full runtime implementation details (separate implementation beads).
- UI/admin portal design work.
- Cross-tenant federation and multi-region identity replication.
- Cross-repository memory sharing design (covered by bead `ums-memory-dd2.4` in [Cross-Repo Memory Federation Model](./cross-repo-memory-federation-model.md)).

## UMS Domain Alignment (Current Model)

This plan maps to existing enterprise schema entities:

- `tenants`: enterprise customer boundary and isolation root.
- `users`: identity principals with `status` lifecycle (`active|disabled|pending`).
- `roles`: tenant role catalog (`system|project|custom`).
- `user_role_assignments`: tenant-wide role links.
- `projects`: project anchors.
- `project_memberships`: project-level user + optional role link.
- `audit_events`: append-only event trail for security/compliance evidence.

Canonical references:

- `libs/shared/src/effect/storage/sqlite/enterprise-schema.ts`
- `docs/reports/phase1-enterprise-sqlite-schema.md`
- `docs/standards/strict-ts-effect-standard.md`

## 1) SSO Authn/Authz Boundary (IdP -> UMS)

### Boundary contract

- Better Auth is the authoritative integration layer for authentication/session handling in UMS.
- IdP is authoritative for `authentication` (credential proof and subject assertion).
- UMS is authoritative for `authorization` (what the subject can do in tenant/project scopes).
- IdP group/role claims are `inputs` only; they do not grant access until mapped to UMS roles/memberships.

### SSO authentication requirements

- Accepted protocols: OIDC (preferred) and SAML 2.0 through Better Auth integrations.
- UMS must validate issuer, audience, signature, token time window, nonce/replay guard, and tenant routing hint.
- Subject keys must be deterministic per `(tenant_id, idp_issuer, subject)` and stable across sessions.
- JIT user creation is allowed only when tenant policy enables it and maps to `users.status = 'pending'` or `active` by policy.

### Tenant routing claim contract (required)

Every successful Better Auth SSO callback must resolve exactly one tenant in deterministic order:

1. `tenant_id` claim (exact match to `tenants.tenant_id`).
2. `tenant_slug` claim (exact match to `tenants.tenant_slug`).
3. Static issuer binding map `(idp_issuer -> tenant_id)` configured in UMS.

Validation rules:

- If none of the above resolve a tenant, authentication is denied with `TENANT_ROUTE_MISSING`.
- If multiple resolution paths disagree, authentication is denied with `TENANT_ROUTE_CONFLICT`.
- If resolved tenant does not belong to the configured issuer binding, authentication is denied with `TENANT_ISSUER_MISMATCH`.
- Every denial must emit `identity.sso.login.denied` audit event with reason code and issuer metadata.

### Authorization requirements

- Effective access is computed from UMS tables (`users`, `user_role_assignments`, `project_memberships`, `roles`).
- Authorization checks must remain tenant-scoped and fail closed for cross-tenant references.
- If role sync is delayed, UMS keeps last known valid assignments and emits staleness audit events.

## 2) SCIM Entities and Mapping Contracts

### Supported SCIM resources

- `/Users`: required.
- `/Groups`: required for role/membership sync.
- `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`: required metadata endpoints.

### Identity key contract

Current schema now includes dedicated identity runtime mapping tables:

- `identity_issuer_bindings`: tenant-scoped issuer binding registry.
- `user_external_subjects`: deterministic `(tenant, issuer_binding, external_subject)` -> `users.user_id` mapping.
- `identity_sync_checkpoints`: replay-safe sync cursor checkpoints per issuer/channel.

Federation contract:

- Canonical external subject key: `idp_issuer + \"::\" + scim_user_id` (materialized as subject mapping row).
- Deterministic `users.user_id` binding remains immutable once mapped.
- Raw external IDs (`externalId`, `id`, issuer) remain preserved in `audit_events.details` for audit traceability.
- Normalization is mandatory before key generation:
  - trim whitespace for issuer and SCIM id
  - lowercase issuer value
  - preserve SCIM id case but encode with canonical UTF-8 normalization
  - reject empty normalized values with deterministic `ScimMappingError`

### `/Users` mapping

| SCIM User field                  | UMS target                                  | Contract rule                                               |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `id`                             | `users.user_id` (derived deterministic key) | Immutable identity anchor after first successful provision. |
| `externalId`                     | audit metadata                              | Required for correlation; not used as mutable primary key.  |
| `userName` / primary email       | `users.email`                               | Normalized lowercase; unique within tenant.                 |
| `name.formatted` or given+family | `users.display_name`                        | Must be non-empty after normalization.                      |
| `active`                         | `users.status`                              | `true -> active`, `false -> disabled`.                      |
| `meta.lastModified`              | sync ordering metadata                      | Used for deterministic stale-event rejection.               |

### `/Groups` mapping

Group `externalId` is authoritative for mapping (display name is informational only):

- `ums:role:<role_code>` -> upsert `user_role_assignments` for resolved tenant role.
- `ums:project:<project_key>:role:<role_code>` -> upsert `project_memberships` with resolved project + role.
- Unknown/invalid mapping expressions are ignored and audited as contract violations.

Mapping prerequisites:

- Referenced `roles.role_code` and `projects.project_key` must already exist in tenant scope.
- Missing anchors are handled deterministically: reject sync unit, emit audit record, keep previous assignments.

## 3) Provisioning and Deprovision Lifecycle

### Lifecycle states

- `pending`: created but not fully activated (optional approval/JIT gate).
- `active`: can authenticate and authorize.
- `disabled`: login denied and assignments revoked from effective authorization.

### Lifecycle flow

1. `Provision` (`SCIM POST /Users` or JIT on first SSO):
   - Resolve tenant + IdP binding.
   - Create/update `users` row.
   - Emit `identity.user.provisioned` audit event.
2. `Update` (`SCIM PATCH/PUT /Users`):
   - Apply managed attribute changes (`email`, `display_name`, `status`) idempotently.
   - Reject stale updates using SCIM version/`lastModified` ordering.
3. `Role sync` (`SCIM /Groups` membership delta):
   - Reconcile desired role/project edges to `user_role_assignments` and `project_memberships`.
4. `Deprovision` (`active=false` or delete policy):
   - Set `users.status = 'disabled'`.
   - Remove effective assignments from sync-managed edges.
   - Preserve user row and audit history for traceability.
5. `Reprovision`:
   - Re-enable via `active=true`.
   - Reapply group-derived assignments from latest successful sync snapshot.

## 4) Role/Group Sync and Conflict Resolution

### Source-of-truth rules

- SCIM-managed attributes are authoritative for managed fields.
- UMS-local fields not in SCIM contract remain UMS-managed.
- Break-glass local assignments are allowed only for explicit protected roles and must be tagged in audit metadata.

### Deterministic reconciliation algorithm

1. Decode and validate SCIM payload with strict schema contracts.
2. Build desired role edge set from group mappings.
3. Fetch current sync-managed edges in tenant scope.
4. Compute `to_add` and `to_remove` sets with deterministic sort order.
5. Apply changes in one transaction; emit one audit record per edge mutation.

### Conflict resolution rules

- Same email mapped to different external subject in same tenant: reject with identity-collision error, no partial writes.
- Multiple groups mapping to one `(tenant, project, user)` membership with different roles:
  - Use tenant-configured role-priority map.
  - Tie-break by lexical `role_code` (ascending) for deterministic behavior.
- Local manual changes on SCIM-managed edges are overwritten on next successful sync unless edge is marked protected.

## 5) Strict TypeScript + Effect Direction

All new federation logic must follow `docs/standards/strict-ts-effect-standard.md`:

- Define inbound/outbound contracts as Effect `Schema` types (SSO assertion claims, SCIM resources, sync deltas).
- Implement identity federation capability as explicit Effect services + layers (no ad hoc singleton wiring).
- Model failure modes with `Schema.TaggedError` (examples: `IdentityCollisionError`, `ScimMappingError`, `StaleScimEventError`).
- Keep business logic and runtime entrypoints in strict TypeScript modules.
- Enforce idempotent processing for SCIM write paths using deterministic request identity keys.

## 6) Audit and Compliance Expectations

### Required audit events

- `identity.sso.login.accepted|denied`
- `identity.user.provisioned|updated|disabled|reprovisioned`
- `identity.role_sync.started|completed|failed`
- `identity.role_assignment.added|removed`
- `identity.project_membership.added|removed`
- `identity.contract_violation.detected`

### Mandatory audit fields

- Persisted `audit_events` columns must include:
  - `tenant_id`, `operation`, `outcome`, `reason`, `recorded_at_ms`.
- Identity federation metadata must be stored in `audit_events.details` (JSON payload), including:
  - `idp_issuer`, `external_subject_id`, `request_id`, `idempotency_key`, and upstream SCIM event/version metadata.
- `audit_events.details` should also include before/after hashes for reconciled membership sets (for replay diagnostics).

### Compliance posture

- Append-only audit semantics are required (align with existing `audit_events` immutability triggers).
- Enterprise default retention target: minimum 365 days of identity audit events.
- Redaction policy must remove secrets/tokens while retaining non-sensitive correlation metadata.

## 7) Rollout Phases

| Phase                   | Goal                                           | Exit criteria                                                       |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| 0. Contract Lock        | Finalize protocol/mapping/error contracts      | Runbook approved; schemas and error taxonomy drafted.               |
| 1. SSO Foundation       | OIDC/SAML login with tenant routing            | Successful login/deny paths + audit events in CI/integration tests. |
| 2. SCIM User Lifecycle  | `/Users` create/update/disable idempotent flow | Deterministic replay tests green; stale event rejects verified.     |
| 3. Role/Group Sync      | `/Groups` to role/membership reconciliation    | Conflict/tie-break rules tested; no cross-tenant mutation gaps.     |
| 4. Compliance Hardening | Ops readiness for enterprise rollout           | Alerting, retention, and runbooked incident response validated.     |

## 8) Explicit Non-Goals

- No custom in-house auth framework parallel to Better Auth.
- No attempt to make IdP groups the runtime authorization engine of record.
- No automatic creation of tenant projects/roles from arbitrary SCIM group names.
- No cross-tenant user linking or global directory merge in this bead.
- No frontend SSO settings UI.
- No irreversible hard-delete user purge path as part of default deprovision.
