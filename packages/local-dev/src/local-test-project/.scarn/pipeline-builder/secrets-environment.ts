/**
 * The `local-secrets` environment `ld-secrets` names. Push publishes it before
 * the steps, so the server accepts the step's reference. Seed saves
 * LOCAL_DEV_API_KEY as a project secret; a worker's .scarn/.env value for
 * the same name would win over it.
 */
import {
  defineEnvironment,
  Env,
  Runtime,
} from "@scarn/sdk/definitions/environments";

export const localSecrets = defineEnvironment({
  name: "local-secrets",
  description: "Local dev: a project secret delivered to a step",
  runtime: Runtime.managed.bun1(),
  vars: {
    LOCAL_DEV_API_KEY: Env.secret("LOCAL_DEV_API_KEY"),
  },
});
