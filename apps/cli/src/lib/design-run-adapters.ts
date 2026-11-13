import * as clack from "@clack/prompts";
import { z } from "zod";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import { automationDocumentSchema } from "@scarn/sdk/contracts/automation-document";
import {
  listPinnedStepDefinitionIds,
  readActivePipelineVersion,
  readLocalEnvVars,
  resolveSourceBranch,
  runPipelineHealthChecksDryRun,
} from "@scarn/worker";
import { connectApi, describeApiError } from "./cli-api-client";
import type { DryRunGateResult } from "./design-run-offer";
import {
  clearRunOfferGateFailure,
  writeRunOfferGateFailure,
} from "./design-run-offer-gate-marker";
import { toDryRunGateResult } from "./dry-run-report";
import { createTransport } from "./logger";
import type { BaseReporter } from "./reporter-types";
import { captureMilestone } from "./telemetry";
import { CliError } from "./cli-error";

/**
 * The real implementations of the run offer's ports: one `clack` confirm and two
 * API calls.
 *
 * Deliberately thin — every branch lives in `design-run-offer.ts`, where it is
 * unit-tested without a terminal or a network. The one exception is
 * {@link firstPipelineKeyOf}, which has to compensate for a generated type
 * and so is tested directly.
 */

/**
 * The pipeline the project's `default` automation starts: its first pipeline
 * target, in rule and route order (`otherwise` after the routes). Deciding
 * which pipeline a given item would get needs the item; the first target is
 * the pipeline the design session just pushed. `undefined` when the
 * automation starts no pipeline.
 *
 * Parsed rather than read because the generated SDK types the version as
 * `T | unknown`, which TypeScript collapses to plain `unknown`. The compiler
 * offers no help at this boundary, so the schema is the only thing pinning
 * the document's shape.
 */
export function firstPipelineKeyOf(
  // eslint-disable-next-line local/no-unknown-parameter-type -- parses an untyped API field
  latestVersion: unknown,
): string | undefined {
  const parsed = defaultAutomationVersionSchema.safeParse(latestVersion);
  if (!parsed.success) return undefined;
  for (const rule of parsed.data.document.rules) {
    const targets = [
      ...rule.next.routes,
      ...(rule.next.otherwise === undefined ? [] : [rule.next.otherwise]),
    ];
    const pipeline = targets.find((target) => target.kind === "pipeline");
    if (pipeline?.kind === "pipeline") return pipeline.to;
  }
  return undefined;
}

const defaultAutomationVersionSchema = z.object({
  document: automationDocumentSchema,
});

/** The project automation the starter scaffolds and the designer edits. */
export const DEFAULT_AUTOMATION_KEY = "default";

/**
 * The pipeline definition the project's `default` automation starts (see
 * {@link firstPipelineKeyOf}). `undefined` when there is no such automation
 * or pipeline — which the offer reads as nothing to run.
 */
export async function resolveAssignedPipeline(input: {
  baseUrl: string;
  projectId: string;
}): Promise<string | undefined> {
  const { client, headers } = await connectApi(input.baseUrl);

  const automations = await client.automations.listAutomations({
    path: { projectId: input.projectId },
    headers,
  });
  if (automations.error !== undefined) {
    throw new Error(
      `Could not read the project's automations: ${describeApiError(automations.error)}`,
    );
  }

  const automation = automations.data.find(
    (candidate) =>
      candidate.key === DEFAULT_AUTOMATION_KEY && candidate.scope === "project",
  );
  const pipelineKey = firstPipelineKeyOf(automation?.latestVersion);
  if (pipelineKey === undefined) return undefined;

  const pipelines = await client.pipelineDefinitions.listPipelineDefinitions({
    path: { projectId: input.projectId },
    headers,
  });
  if (pipelines.error !== undefined) {
    throw new Error(
      `Could not read the project's pipelines: ${describeApiError(pipelines.error)}`,
    );
  }
  return pipelines.data.find((pipeline) => pipeline.key === pipelineKey)?.id;
}

/**
 * The two step-definition fields that decide where a step executes. Parsed for
 * the same reason as {@link firstPipelineKeyOf}: the generated type
 * collapses the nullable `managedRuntime` to `unknown`.
 */
export const stepRuntimeTargetSchema = z.object({
  executionMode: z.enum(["workspace", "no_workspace"]),
  managedRuntime: z.string().nullable(),
});

export type StepRuntimeTarget = z.infer<typeof stepRuntimeTargetSchema>;

/**
 * A step runs inside the project's devcontainer only when it needs a workspace
 * and no managed runtime supplies the container. `no_workspace` steps run on
 * the host; managed-runtime steps run in a Scarn-provided image.
 */
export function stepNeedsProjectDevcontainer(step: StepRuntimeTarget): boolean {
  return step.executionMode === "workspace" && step.managedRuntime === null;
}

/**
 * Does any step of `pipelineDefinitionId` execute inside the project's own
 * devcontainer? Host-only and managed-runtime pipelines run without one.
 */
export async function pipelineNeedsProjectDevcontainer(input: {
  baseUrl: string;
  pipelineDefinitionId: string;
}): Promise<boolean> {
  const { client, headers } = await connectApi(input.baseUrl);

  const pipeline = await client.pipelineDefinitions.getPipelineDefinition({
    path: { pipelineDefinitionId: input.pipelineDefinitionId },
    headers,
  });
  if (pipeline.error !== undefined) {
    throw new Error(
      `Could not read the pipeline: ${describeApiError(pipeline.error)}`,
    );
  }

  const stepDefinitionIds = listPinnedStepDefinitionIds(
    readActivePipelineVersion(input.pipelineDefinitionId, pipeline.data),
  );

  const steps = await Promise.all(
    stepDefinitionIds.map(async (stepDefinitionId) => {
      const step = await client.stepDefinitions.getStepDefinition({
        path: { stepDefinitionId },
        headers,
      });
      if (step.error !== undefined) {
        throw new Error(
          `Could not read step definition ${stepDefinitionId}: ${describeApiError(step.error)}`,
        );
      }
      return stepRuntimeTargetSchema.parse(step.data);
    }),
  );

  return steps.some(stepNeedsProjectDevcontainer);
}

/**
 * Queue a run of `pipelineDefinitionId` against one work item.
 *
 * This is the same call the dashboard's executions drawer makes. It is needed
 * because neither creating a work item nor pushing a pipeline queues anything:
 * the default-assignment policy only fires when a work item is *upserted* by an
 * integration sync, so without this the worker would have nothing to claim.
 *
 * `inputJson` is omitted — the pipeline's input comes from the work item.
 */
export async function queueDesignRun(input: {
  baseUrl: string;
  projectId: string;
  workItemId: string;
  pipelineDefinitionId: string;
}): Promise<void> {
  const { client, headers } = await connectApi(input.baseUrl);

  const { error } = await client.pipelineExecutions.createPipelineExecution({
    body: {
      projectId: input.projectId,
      workItemId: input.workItemId,
      pipelineDefinitionId: input.pipelineDefinitionId,
    },
    headers,
  });

  if (error !== undefined) {
    throw new CliError(
      "run_queue_failed",
      `Could not queue the run: ${describeApiError(error)}`,
    );
  }

  // Milestone 8, "First run queued / worker run started" — scoped to the
  // queue side only. Whether a worker actually claims and starts THIS run
  // is not observable from here: the `scarn work` process that eventually
  // claims it is very often a different process (often a different
  // machine) than the one that queued it, with no webhook or callback
  // connecting the two. Queueing is the CLI-observable half of the
  // milestone and the one this fires.
  captureMilestone(AnalyticsEvents.CliRunQueued);
}

/**
 * The real implementation of {@link DesignRunOfferPorts.runPipelineHealthDryRun}:
 * run every step's health checks, one launch per distinct runtime, then
 * persist (or clear) the marker the NEXT `pipelines design` session's
 * orientation reads — see `design-run-offer-gate-marker.ts`. There is no live
 * session left to tell right now; this is the only channel across the gap.
 */
export async function runPipelineHealthDryRun(input: {
  baseUrl: string;
  projectId: string;
  pipelineDefinitionId: string;
  builderDir: string;
  reporter: BaseReporter;
}): Promise<DryRunGateResult> {
  const [localEnvVars, sourceBranchResult] = await Promise.all([
    readLocalEnvVars(process.cwd()),
    resolveSourceBranch({ cwd: process.cwd(), override: undefined }),
  ]);

  if (sourceBranchResult.warning) {
    input.reporter.warn(sourceBranchResult.warning);
  }

  const result = toDryRunGateResult(
    await runPipelineHealthChecksDryRun({
      projectId: input.projectId,
      baseUrl: input.baseUrl,
      pipelineDefinitionId: input.pipelineDefinitionId,
      dest: createTransport(),
      localEnvVars,
      sourceBranch: sourceBranchResult.branch,
    }),
  );

  if (result.ok) {
    // An old marker from an earlier, since-fixed failure no longer describes
    // reality — this run is the new source of truth.
    clearRunOfferGateFailure(input.builderDir);
    captureMilestone(AnalyticsEvents.CliDryRunPassed, {
      via: "pipelines-design",
    });
    return result;
  }

  writeRunOfferGateFailure(input.builderDir, {
    pipelineDefinitionId: input.pipelineDefinitionId,
    summary: result.summary,
  });
  return result;
}

/**
 * The closing confirm. Defaults to yes: the user just spent a session designing
 * this, and watching it run is the point.
 */
export async function promptRunNow(workItemTitle: string): Promise<boolean> {
  const answer = await clack.confirm({
    message: `Run your new pipeline on “${workItemTitle}” now?`,
    initialValue: true,
  });
  // Cancelling the offer is not a failed session — the pipeline is already
  // pushed. Treated as "not now", so the command prints instead of running.
  return !clack.isCancel(answer) && answer;
}
