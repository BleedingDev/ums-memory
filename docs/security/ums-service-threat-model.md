# UMS Service Threat Model

## Scope
- Service components in scope:
  - `apps/api/src/core.mjs` operation layer (`recall_authorization`, `tutor_degraded`, `policy_audit_export`, policy audit trail).
  - `apps/api/src/ums/engine.mjs` ingest/recall path (space isolation, unsafe filtering, secret redaction).
  - `libs/shared/src/effect/storage/sqlite/storage-repository.ts` persistence redaction and deterministic idempotency controls.
- Environment assumptions:
  - Backend-only execution with local-first persistence.
  - Single service boundary with deterministic replay and append-style audit semantics.

## Assets
- Tenant-scoped memory state:
  - Events, learner profile updates, policy decisions, policy audit trail entries.
- Security-sensitive content:
  - Secrets/tokens/password-like strings and PII in payloads and metadata.
- Authorization policy state:
  - Recall allowlist policy (`allowedStoreIds`) and cross-space authorization decisions.
- Integrity evidence:
  - Policy audit export payloads, checksums, and HMAC signature metadata/value.
- Operational metadata:
  - Replay digests, idempotency keys, deterministic decision identifiers.

## Trust Boundaries
- Boundary A: External request payloads -> operation handlers.
  - Untrusted fields include tenant/store identifiers, requester identifiers, mode toggles, export options, and arbitrary metadata.
- Boundary B: Cross-tenant access checks.
  - Requests with `requesterStoreId != storeId` cross the tenant boundary and must fail closed unless explicitly allowlisted.
- Boundary C: Persisted storage and exported artifacts.
  - Storage and exported files are treated as potentially observable artifacts and must not expose raw secrets/PII.
- Boundary D: Runtime configuration secrets.
  - `UMS_POLICY_AUDIT_EXPORT_SIGNING_SECRET` and `UMS_POLICY_AUDIT_EXPORT_SIGNING_KEY_ID` are privileged inputs and are mandatory for signed export.

## Abuse Cases and Existing Controls

### 1) Cross-tenant recall/data access attempt
- Abuse path:
  - Adversary submits cross-tenant request by setting `requesterStoreId` to another tenant.
- Controls:
  - `recall_authorization` defaults to `failClosed`.
  - Unauthorized cross-space checks return `PERSONALIZATION_POLICY_DENY`.
  - Every authorization decision emits deterministic `policyAuditTrail` entries with `allowlist_denied` reason codes.
  - `tutor_degraded` enforces `ensureRecallAuthorizationForOperation` before serving cross-tenant requests.

### 2) Authorization bypass by fail-open misuse
- Abuse path:
  - Caller sets `failClosed=false` and expects implicit allow behavior.
- Controls:
  - Request can avoid throw, but decision still evaluates unauthorized and is audit logged as deny.
  - `authorized=false` and `crossSpace=true` are explicit in response and observability fields.

### 3) Secret/PII exfiltration through ingest or persistence
- Abuse path:
  - Payload includes tokens/passwords/API keys/emails/phones intending to leak through recall or storage.
- Controls:
  - Engine-level redaction (`redactSecrets`) before event storage.
  - Storage-level payload sanitization/redaction in sqlite repository tests and implementation.
  - Recall guardrail telemetry includes redaction counters.

### 4) Prompt-injection and unsafe instruction replay
- Abuse path:
  - Content asks to ignore safety controls or exfiltrate secrets.
- Controls:
  - Unsafe instruction pattern detection at ingest.
  - Recall filters unsafe content unless `includeUnsafe=true`.
  - Guardrails expose `filteredUnsafe` count for auditability.

### 5) Policy audit export tampering or signature forgery
- Abuse path:
  - Modify export payload/content post-generation while presenting it as authentic.
- Controls:
  - Deterministic section/content/payload checksums.
  - Deterministic HMAC signature over signature metadata digest.
  - Missing signing secret/key id fails fast (`SERVICE_MISCONFIGURATION`).
  - Signature key rotation changes signature value while preserving deterministic event identity.

## Security Gaps
- No external key management/HSM integration for policy audit signing keys.
- No online revocation/expiry semantics for exported signature artifacts.
- Unsafe-pattern detection is lexical and can miss semantically obfuscated prompt injection.
- Fail-open mode exists by design and depends on caller discipline/policy, creating operational misuse risk.
- No explicit rate-limiting/throttling controls in core authorization paths.

## Residual Risk
- Medium: sophisticated prompt-injection variants can evade regex-based unsafe detection.
- Medium: signed export integrity is strong, but operational key compromise would still permit valid malicious signatures.
- Medium: improper client use of fail-open responses could still surface unauthorized workflows downstream.
- Low to Medium: redaction false negatives/positives in long-tail payload patterns.

## Operational Mitigations
- Enforce production policy:
  - Default all cross-tenant operations to fail-closed and disallow fail-open paths except explicitly approved service accounts.
- Protect signing keys:
  - Move signing secret storage to managed secret manager and rotate on a fixed schedule with incident-runbook rotation steps.
- Add verification in downstream consumers:
  - Require checksum and HMAC verification before accepting policy audit exports.
- Improve abuse detection:
  - Expand unsafe pattern corpus and add incident feedback loop from policy/audit events.
- Monitor:
  - Alert on spikes in `allowlist_denied`, `filteredUnsafe`, and export/signing misconfiguration errors.
- Incident readiness:
  - Preserve deterministic replay artifacts (request digest, policyAuditEventId, signature metadata digest) for forensic replay.

