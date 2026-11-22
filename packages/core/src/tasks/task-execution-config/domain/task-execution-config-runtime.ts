import type { EnvironmentRef } from "@scarn/core/common/contracts/environment";
import type { StoredEnvironment } from "../contracts/task-execution-config-stored";

/** The public environment bridge uses envJson; immutable stored v3 uses vars. */
export const storedEnvironmentFromRef = (
  environment: EnvironmentRef,
): StoredEnvironment => {
  if (environment === null || environment.kind === "named") return environment;
  const { envJson, ...rest } = environment;
  return {
    ...rest,
    ...(envJson == null || envJson.length === 0 ? {} : { vars: envJson }),
  };
};

export const environmentRefFromStored = (
  environment: StoredEnvironment,
): EnvironmentRef => {
  if (environment === null || environment.kind === "named") return environment;
  const { vars, ...rest } = environment;
  return {
    ...rest,
    ...(vars === undefined ? {} : { envJson: vars }),
  };
};
