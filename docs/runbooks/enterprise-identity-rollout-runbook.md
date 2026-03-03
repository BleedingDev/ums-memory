# Enterprise Identity Rollout Runbook (bead `ums-memory-wt0.9`)

## Purpose

Operational guide for rolling out Better Auth + SCIM identity flows in UMS with deterministic behavior, tenant isolation, and compliance-safe fallback.

## Preconditions

- `wt0.3` through `wt0.8` implementation and tests are merged.
- Migration level includes identity + provenance schema (`identity_issuer_bindings`, `user_external_subjects`, `identity_sync_checkpoints`).
- On-call rotation has named owner for identity rollout window.
- Staging environment has at least one tenant configured for OIDC + SCIM end-to-end rehearsal.

## Required Secrets and Config

- Better Auth provider config:
  - OIDC/SAML issuer metadata URL or static JWKS.
  - client id / client secret.
  - callback URL (must match environment domain).
- SCIM provisioning:
  - SCIM bearer token (rotation-supported).
  - tenant-scoped issuer binding identifiers.
- Audit integrity:
  - audit export signing secret and key id.
- Runtime flags:
  - strict TS + Effect runtime path enabled.
  - legacy shim cutover validations enabled.

## Rollout Procedure

1. Deploy DB migration and confirm schema objects exist.
2. Deploy API/runtime version containing enterprise identity services.
3. Register tenant issuer binding and routing claims in staging.
4. Execute SSO login smoke:
   - valid tenant claim -> accepted login.
   - missing/conflicting claim -> denied login.
5. Execute SCIM `/Users` lifecycle smoke:
   - create, update, disable, reprovision.
   - replay same cursor -> idempotent result.
   - stale cursor -> deterministic reject.
6. Execute SCIM `/Groups` reconciliation smoke:
   - role assignment creation.
   - project membership creation.
   - deterministic conflict tie-break for same project.
7. Validate authorization integration:
   - in-tenant allowed action passes.
   - cross-tenant request fails closed.
8. Validate identity audit event emission:
   - `identity.sso.login`
   - `identity.user.provision`
   - `identity.user.sync`
   - `identity.group.sync`

## Monitoring and Alerting

Track and alert on:

- SSO denial rate by reason code (`TENANT_ROUTE_MISSING`, `TENANT_ROUTE_CONFLICT`, `TENANT_ISSUER_MISMATCH`).
- SCIM stale-event reject count and replay count.
- Provenance health report counters:
  - missing provenance links
  - lineage breaks
  - normalization rejects
- Cross-tenant denied authorization attempts (must remain deny-only, zero mutation side effects).

Escalate to incident if:

- SSO acceptance drops below agreed threshold for known-good tenants.
- SCIM stale reject spikes unexpectedly (possible ordering regression).
- Any cross-tenant mutation is observed.

## Incident Response

1. Freeze new tenant onboarding for identity flows.
2. Preserve logs and audit event slices for affected tenant + issuer.
3. Identify failure class:
   - auth callback validation/routing
   - SCIM user lifecycle
   - SCIM group reconciliation
   - authorization boundary
4. Apply tactical mitigation:
   - revoke/rotate SCIM token if compromised.
   - disable issuer binding for affected tenant if mapping is incorrect.
   - temporarily force deny for affected tenant route while preserving read access.
5. Re-run deterministic smoke suite before unfreezing rollout.

## Fallback and Rollback

- Preferred fallback: keep identity tables and audits, disable active issuer binding to stop new SSO sessions.
- If runtime rollback is required:
  - deploy previous known-good runtime image,
  - keep DB schema forward-compatible (no destructive rollback migration),
  - replay SCIM events from checkpoint cursor after service restore.
- Never hard-delete identity audit trail during rollback.

## Post-Rollout Verification

- Confirm 24h stability of SSO accept/deny distribution.
- Confirm SCIM replay/stale behavior matches expected deterministic baseline.
- Confirm no cross-tenant authorization bypass.
- Archive rollout evidence in `docs/reports/` with date stamp and owner.
