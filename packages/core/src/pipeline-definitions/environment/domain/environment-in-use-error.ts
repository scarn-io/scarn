import { CoreError } from "@scarn/core/lib/errors";

/** Deleting an environment that an active step definition still names (409). */
export class EnvironmentInUseError extends CoreError {
  constructor(name: string, stepKeys: readonly string[]) {
    super({
      code: "ENVIRONMENT_IN_USE",
      message: `Environment "${name}" is used by step definitions: ${stepKeys.join(", ")}. Change those steps to another environment first.`,
      status: 409,
      meta: { name, stepKeys: [...stepKeys] },
    });
  }
}
