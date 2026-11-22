/**
 * Project secrets: `check-secret` runs in the named `local-secrets`
 * environment, which maps the `LOCAL_DEV_API_KEY` project secret seed saves
 * into the step's environment. Missing everywhere, the run fails at startup
 * with `SCARN_ENVIRONMENT_UNRESOLVED`.
 */
import { definePipeline, succeed } from "@scarn/sdk/pipelines";
import { checkSecret } from "./secrets-steps";

const done = succeed("done");

export default definePipeline({
  key: "ld-secrets",
  title: "Local dev: project secret in a named environment",
  start: checkSecret({}),
  flow: [checkSecret.settings({ title: "Check the secret" }).next(done)],
});
