type CoreErrorInput = {
  code: string;
  message: string;
  status: number;
  expose?: boolean;
  meta?: Record<string, unknown> | undefined;
};

const toResourceCodePrefix = (resource: string) =>
  resource
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

export class CoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly expose: boolean;
  readonly meta: Record<string, unknown> | undefined;

  constructor({ code, message, status, expose = true, meta }: CoreErrorInput) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.expose = expose;
    this.meta = meta;
  }
}

export class CoreValidationError extends CoreError {
  constructor(
    message: string,
    code = "VALIDATION_ERROR",
    meta?: Record<string, unknown>,
  ) {
    super({
      code,
      message,
      status: 422,
      meta,
    });
  }
}

export class ResourceNotFoundError extends CoreError {
  constructor(resource: string, identifier: string) {
    super({
      code: `${toResourceCodePrefix(resource)}_NOT_FOUND`,
      message: `${resource} ${identifier} not found`,
      status: 404,
      meta: {
        resource,
        identifier,
      },
    });
  }
}

export class ResourceConflictError extends CoreError {
  constructor(resource: string, identifier: string) {
    super({
      code: `${toResourceCodePrefix(resource)}_CONFLICT`,
      message: `${resource} ${identifier} already exists`,
      status: 409,
      meta: {
        resource,
        identifier,
      },
    });
  }
}

export class ResourceOwnershipError extends CoreError {
  constructor(resource: string, identifier: string, message?: string) {
    super({
      code: `${toResourceCodePrefix(resource)}_OWNERSHIP_CONFLICT`,
      message:
        message ?? `${resource} ${identifier} is not owned by the caller`,
      status: 409,
      meta: {
        resource,
        identifier,
      },
    });
  }
}

/**
 * The requested artifact's underlying bytes have aged out past
 * `STORAGE_RETENTION_DAYS` (see `ArtifactRepo.clearExpiredArtifacts`) and can
 * no longer be presigned/downloaded. Modeled as its own `CoreError` (status
 * 410 Gone) rather than reusing `ResourceNotFoundError` — the artifact row
 * still exists and is still listable, only its stored object is gone, which
 * is a materially different condition than "not found"/IDOR. Named after
 * (and shaped like) `UsageLimitExceededError` rather than
 * `ResourceNotFoundError(resource, identifier)` because this is a single,
 * specific domain condition rather than a generic "any resource" guard.
 */
export class ArtifactExpiredError extends CoreError {
  constructor(artifactId: string) {
    super({
      code: "ARTIFACT_EXPIRED",
      message: `Artifact ${artifactId} has expired and is no longer available`,
      status: 410,
      meta: { artifactId },
    });
  }
}

export class InvariantViolationError extends CoreError {
  constructor(message: string, code = "INVARIANT_VIOLATION") {
    super({
      code,
      message,
      status: 500,
      expose: false,
    });
  }
}

export type UsageLimitKind = "write" | "read" | "storage" | "signal";

export class UsageLimitExceededError extends CoreError {
  readonly kind: UsageLimitKind;

  constructor(
    kind: UsageLimitKind,
    meta?: { orgId?: string | undefined; period?: string | undefined },
  ) {
    super({
      code: `USAGE_LIMIT_EXCEEDED_${kind.toUpperCase()}`,
      message: `Usage limit exceeded for ${kind}`,
      status: 402,
      meta: {
        kind,
        ...(meta?.orgId !== undefined ? { orgId: meta.orgId } : {}),
        ...(meta?.period !== undefined ? { period: meta.period } : {}),
      },
    });
    this.kind = kind;
  }
}

export class PersistenceError extends CoreError {
  constructor(message: string, code = "PERSISTENCE_ERROR") {
    super({
      code,
      message,
      status: 500,
      expose: false,
    });
  }
}

export class ConfigurationError extends CoreError {
  constructor(message: string, code = "CONFIGURATION_ERROR") {
    super({
      code,
      message,
      status: 500,
      expose: false,
    });
  }
}

export type ExpectedCoreError =
  | ResourceNotFoundError
  | ResourceConflictError
  | ResourceOwnershipError
  | UsageLimitExceededError
  | CoreValidationError;
