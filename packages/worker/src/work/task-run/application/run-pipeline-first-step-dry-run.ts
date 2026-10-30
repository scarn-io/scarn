import { createScarnClient } from "@scarn/sdk";
import { ConfigurationError } from "../../../lib/errors";
import { resolveScarnBaseUrl } from "../../../auth/session/infra/auth-config";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import {
  readActivePipelineVersion,
  resolveStartStepDefinitionId,
} from "./pipeline-version-steps";
import {
  runWorkDryRun,
  type WorkDryRunOptions,
  type WorkDryRunReport,
} from "./run-work-dry-run";

/**
 * Invocation 2 of the extended `work --dry-run` (#146; see `run-work-dry-run.ts`
 * for invocation 1's `--global-only` scope): a **pipeline id**, not an
 * ambiguous step id, resolved to its start step so the dry run can
 * unambiguously target the first step.
 *
 * Deliberately does not validate every step — see the doc on
 * {@link fetchFirstStepDefinitionId} for why only the first step is checked
 * here.
 */

/**
 * The first step of a pipeline is the step at its active version's `start`
 * node — the same one a real run visits first.
 *
 * Only the first step: this is `work --dry-run --pipeline-id`'s full
 * single-step rehearsal. The run-offer gate's every-step health checks, which
 * split launches on MCP-key conflicts and per runtime and keep each step's
 * abort to itself, live in `run-pipeline-health-checks-dry-run.ts`.
 */
async function fetchFirstStepDefinitionId(
  client: ReturnType<typeof createScarnClient>,
  headers: { Authorization: string },
  pipelineDefinitionId: string,
): Promise<string> {
  const result = await client.pipelineDefinitions.getPipelineDefinition({
    path: { pipelineDefinitionId },
    headers,
  });
  return resolveStartStepDefinitionId(
    pipelineDefinitionId,
    readActivePipelineVersion(pipelineDefinitionId, result.data),
  );
}

export type PipelineFirstStepDryRunOptions = Omit<
  WorkDryRunOptions,
  "stepDefinitionId" | "globalOnly"
> & {
  /** The pipeline to resolve to its first step — not a step id. */
  pipelineDefinitionId: string;
};

/**
 * Resolve `pipelineDefinitionId` to its first step (by `position`), then run
 * the full environment rehearsal against it — container, OpenCode, MCP
 * servers, and declared health checks. Comprehensive, unlike invocation 1's
 * `--global-only` scope, because this runs post-push: step-specific
 * configuration exists by now.
 */
export async function runPipelineFirstStepDryRun(
  options: PipelineFirstStepDryRunOptions,
): Promise<WorkDryRunReport> {
  const baseUrl = resolveScarnBaseUrl(options.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new ConfigurationError(`Not signed in to ${baseUrl}.`);
  }
  const headers = {
    Authorization: `Bearer ${authenticated.profile.accessToken}`,
  };
  const client = createScarnClient(baseUrl);
  const stepDefinitionId = await fetchFirstStepDefinitionId(
    client,
    headers,
    options.pipelineDefinitionId,
  );

  return runWorkDryRun({ ...options, baseUrl, stepDefinitionId });
}
