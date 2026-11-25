import type { EnvVarSpec } from "@scarn/sdk/env-vars";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import { planStepEnv, withInferredMcpEnv } from "./resolve-step-env";
import {
  planDryRunSecretEnv,
  resolveSecretEnv,
  type DryRunSecretReport,
  type RequestProjectSecrets,
} from "./resolve-secret-env";

type PlanInput = {
  envVars: readonly EnvVarSpec[] | null | undefined;
  inputJson: unknown;
  /** `worker` vars read this (`.scarn/.env` over `process.env`); `secret` vars never do. */
  workerEnv: Readonly<Record<string, string | undefined>>;
  /** The run's `.scarn/.env`, where `secret` vars are looked up by secret name. */
  localEnvVars: Readonly<Record<string, string>> | undefined;
  opencodeMcpJson: OpenCodeMcpServers | null | undefined;
};

/** The step's vars and its MCP servers' declared `workerVars`, project secrets included. */
function withMcpWorkerVars(input: PlanInput): EnvVarSpec[] {
  return withInferredMcpEnv(input.envVars, [], input.opencodeMcpJson);
}

/**
 * A claimed run's step env: project secrets resolved first (one Scarn call at
 * most), every value handed to `onSecretValues` for masking before the plan,
 * and therefore the runtime, can use it.
 */
export async function planClaimedStepEnv(
  input: PlanInput & {
    requestSecrets: RequestProjectSecrets;
    onSecretValues?: ((values: readonly string[]) => void) | undefined;
  },
): Promise<ReturnType<typeof planStepEnv>> {
  const secrets = await resolveSecretEnv({
    ...input,
    envVars: withMcpWorkerVars(input),
  });
  input.onSecretValues?.(Object.values(secrets.values));
  return planStepEnv({ ...input, projectSecrets: secrets.values });
}

/** A dry run's step env: never fetches from Scarn; reports each secret's source. */
export function planDryRunStepEnv(input: PlanInput): {
  plan: ReturnType<typeof planStepEnv>;
  secrets: DryRunSecretReport[];
} {
  const dryRun = planDryRunSecretEnv(
    withMcpWorkerVars(input),
    input.localEnvVars,
  );
  return {
    plan: planStepEnv({ ...input, projectSecrets: dryRun.values }),
    secrets: dryRun.secrets,
  };
}
