export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INVALID_TRANSITION"
  | "GUARD_FAILED"
  | "STALE_VERSION"
  | "DUPLICATE_ADMINISTRATION"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "DEMO_ONLY"
  | "CONFLICT"
  | "UNSAFE_CONTENT";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_TRANSITION: 409,
  GUARD_FAILED: 409,
  STALE_VERSION: 409,
  DUPLICATE_ADMINISTRATION: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  DEMO_ONLY: 404,
  CONFLICT: 409,
  UNSAFE_CONTENT: 422,
};

export class DomainError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (what = "Not found") => new DomainError("NOT_FOUND", what);
export const forbidden = (msg = "You don't have permission to do this.") => new DomainError("FORBIDDEN", msg);
export const staleVersion = () =>
  new DomainError("STALE_VERSION", "Someone else just updated this. Refresh to see the latest version.");
export const invalid = (msg: string, details?: unknown) => new DomainError("VALIDATION_ERROR", msg, details);
