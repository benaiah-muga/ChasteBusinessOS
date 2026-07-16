export class ChasteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "ChasteError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends ChasteError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, 400, details);
    this.name = "ValidationError";
  }
}

export class PermissionError extends ChasteError {
  constructor(permission: string) {
    super("PERMISSION_DENIED", `Missing permission: ${permission}`, 403, { permission });
    this.name = "PermissionError";
  }
}

export class NotFoundError extends ChasteError {
  constructor(resource: string) {
    super("NOT_FOUND", `${resource} not found`, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ChasteError {
  constructor(message: string, details?: unknown) {
    super("CONFLICT", message, 409, details);
    this.name = "ConflictError";
  }
}
