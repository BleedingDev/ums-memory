# Policy Replay Transcript (Deterministic Verification)

## Scenario

- Operation: `policy_decision_update`
- Store: `tenant-enterprise-a`
- Profile: `operator-console`
- Request Digest: `req_5811ac80205e32a1`
- Incident: `inc-20260304-03`

## Input Payload (normalized)

```json
{
  "storeId": "tenant-enterprise-a",
  "profile": "operator-console",
  "policyKey": "cross_space_allowlist",
  "outcome": "deny",
  "reasonCodes": ["allowlist_denied"],
  "provenanceEventIds": ["evt_pol_1003"],
  "timestamp": "2026-03-04T09:14:11.000Z"
}
```

## Replay Runs

1. Run A (`2026-03-04T09:15:00.000Z`): `decisionId=pol_20260304_0002`, `outcome=deny`, `reasonCodes=[allowlist_denied]`, `requestDigest=req_5811ac80205e32a1`
2. Run B (`2026-03-04T09:16:10.000Z`): `decisionId=pol_20260304_0002`, `outcome=deny`, `reasonCodes=[allowlist_denied]`, `requestDigest=req_5811ac80205e32a1`

## Determinism Result

- Replay parity: PASS
- Decision drift: none
- Digest drift: none
- Incident rollback integrity: verified
