import { CoreError } from "@scarn/core/lib/errors";

/**
 * A worker asked for project secrets its run's environment doesn't reference
 * (403). The message lists the rejected names and the ones the run may ask
 * for, so the worker's failure says what to fix.
 */
export class SecretNotReferencedError extends CoreError {
  constructor(rejected: readonly string[], allowed: readonly string[]) {
    const allowedText =
      allowed.length === 0 ? "none" : [...allowed].sort().join(", ");
    super({
      code: "SECRET_NOT_REFERENCED",
      message: `Secrets not referenced by this task run's environment: ${rejected.join(", ")}. It may request: ${allowedText}.`,
      status: 403,
      meta: { rejected: [...rejected], allowed: [...allowed] },
    });
  }
}
