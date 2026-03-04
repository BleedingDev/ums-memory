# Policy Incident Checklist (Sample Completed Record)

- Incident ID: `inc-20260304-03`
- Severity: `Sev2`
- Detection Time (UTC): `2026-03-04T09:10:30.000Z`
- Containment Action: policy decision path switched to deny-by-default for affected tenant window.
- Rollback / Mitigation Action: reverted policy-pack override and replayed impacted requests.
- Deterministic Replay Verification:
  - replay request digest: `req_5811ac80205e32a1`
  - before mitigation decision: `deny` (`reasonCode=allowlist_denied`)
  - after mitigation decision: `deny` (`reasonCode=allowlist_denied`)
  - replay status: deterministic parity confirmed
- Rollback Required: `true`
- Rollback Decision ID: `pol_20260304_0001`
- Degraded Mode During Incident: `true`
- Reviewed By: `incident-commander-1`
- Post-Incident Owner: `platform-safety`

## Decision Trace Evidence

- `decisionId`: `pol_20260304_0002`
- `requestDigest`: `req_5811ac80205e32a1`
- `policyVersion`: `2026.03.04`
- `reasonCodes`: `allowlist_denied`
- `storeId`: `tenant-enterprise-a`
- `profile`: `operator-console`
