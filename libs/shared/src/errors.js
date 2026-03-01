export const ErrorCode = Object.freeze({
  VALIDATION_FAILED: "VALIDATION_FAILED",
  EVIDENCE_REQUIRED: "EVIDENCE_REQUIRED",
  PAYLOAD_LIMIT: "PAYLOAD_LIMIT",
  ISOLATION_VIOLATION: "ISOLATION_VIOLATION",
  IDENTITY_INVARIANT: "IDENTITY_INVARIANT",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  CONTRACT_VIOLATION: "CONTRACT_VIOLATION",
});

export class UmsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends UmsError {
  constructor(message, details = {}) {
    super(ErrorCode.VALIDATION_FAILED, message, details);
  }
}

export class EvidenceRequiredError extends UmsError {
  constructor(message, details = {}) {
    super(ErrorCode.EVIDENCE_REQUIRED, message, details);
  }
}

export class PayloadLimitError extends UmsError {
  constructor(message, details = {}) {
    super(ErrorCode.PAYLOAD_LIMIT, message, details);
  }
}

export class IsolationViolationError extends UmsError {
  constructor(message, details = {}) {
    super(ErrorCode.ISOLATION_VIOLATION, message, details);
  }
}

export class IdentityInvariantError extends UmsError {
  constructor(message, details = {}) {
    super(ErrorCode.IDENTITY_INVARIANT, message, details);
  }
}

export class NotFoundError extends UmsError {
  constructor(message, details = {}) {
    super(ErrorCode.NOT_FOUND, message, details);
  }
}

export class ConflictError extends UmsError {
  constructor(message, details = {}) {
    super(ErrorCode.CONFLICT, message, details);
  }
}

export class ContractViolationError extends UmsError {
  constructor(message, details = {}) {
    super(ErrorCode.CONTRACT_VIOLATION, message, details);
  }
}
