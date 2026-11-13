import { ActionError, unwrapAction } from "./lib/action-error";
import type { RunActionClient, SentVisitMessage } from "./lib/action-clients";
import type { AuthHeaders } from "./lib/api-result";
import type { RunVisit, RunWithVisits } from "./lib/run-api-types";
import {
  resolveStepVisit,
  visitsForNode,
  type ResolvedStepVisit,
} from "./lib/run-visits";

/**
 * The safe actions on a pipeline run: rerun step visits, message a step, and
 * cancel the run. Each is split into a read that finds what the action will
 * touch (so the CLI can confirm it) and the call that does it.
 */

type RunActionOptions = {
  client: RunActionClient;
  headers: AuthHeaders;
  runId: string;
};

export async function loadRun(
  options: RunActionOptions,
): Promise<RunWithVisits> {
  const { client, headers, runId } = options;
  const result = await client.pipelineExecutions.getPipelineExecution({
    path: { pipelineExecutionId: runId },
    headers,
  });
  if (result.error?.status === 404) {
    throw new ActionError("not_found", `Pipeline run ${runId} not found.`);
  }
  return unwrapAction(`load pipeline run ${runId}`, result);
}

/** One visit an action targets, with its step key and attempt number. */
export type TargetVisit = {
  stepKey: string;
  visit: RunVisit;
  attemptNumber: number;
};

function resolveTarget(
  run: RunWithVisits,
  stepKey: string,
  attempt: number | undefined,
): ResolvedStepVisit {
  try {
    return resolveStepVisit(run, stepKey, attempt);
  } catch (error) {
    throw new ActionError(
      "not_found",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export type RerunSelection =
  | { kind: "step"; stepKey: string; attempt: number | undefined }
  | {
      kind: "failed";
    };

/**
 * The visits a rerun will restart: the `--step` visit, or every failed step
 * visit (oldest first). Throws when `--failed` finds none.
 */
export function planRerun(
  run: RunWithVisits,
  selection: RerunSelection,
): TargetVisit[] {
  if (selection.kind === "step") {
    const resolved = resolveTarget(run, selection.stepKey, selection.attempt);
    return [
      {
        stepKey: selection.stepKey,
        visit: resolved.visit,
        attemptNumber: resolved.attemptNumber,
      },
    ];
  }
  const failed = run.visits
    .filter((visit) => visit.nodeKind === "step" && visit.status === "failed")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (failed.length === 0) {
    throw new ActionError(
      "rejected",
      `Pipeline run ${run.id} has no failed steps to rerun.`,
    );
  }
  return failed.map((visit) => ({
    stepKey: visit.nodeId,
    visit,
    attemptNumber:
      visitsForNode(run, visit.nodeId).findIndex(
        (candidate) => candidate.id === visit.id,
      ) + 1,
  }));
}

/** What one visit's rerun did: the new visit, or why it was skipped. */
export type RerunOutcome =
  | { target: TargetVisit; status: "rerun"; newVisitId: string | null }
  | { target: TargetVisit; status: "skipped"; reason: string };

export type RerunResult = { run: RunWithVisits; outcomes: RerunOutcome[] };

function latestVisitId(run: RunWithVisits, stepKey: string): string | null {
  return visitsForNode(run, stepKey).at(-1)?.id ?? null;
}

/**
 * Reruns each target in order. Rerunning a visit supersedes everything
 * downstream of it, so a later target the earlier reruns already superseded
 * is skipped instead of sent.
 */
export async function rerunVisits(
  options: RunActionOptions & { run: RunWithVisits; targets: TargetVisit[] },
): Promise<RerunResult> {
  const { client, headers, runId } = options;
  let run = options.run;
  const outcomes: RerunOutcome[] = [];
  for (const target of options.targets) {
    const current = run.visits.find((visit) => visit.id === target.visit.id);
    if (run !== options.run && current?.status === "superseded") {
      outcomes.push({
        target,
        status: "skipped",
        reason: "an earlier rerun already restarted it",
      });
      continue;
    }
    run = unwrapAction(
      `rerun step "${target.stepKey}" (visit ${target.visit.id})`,
      await client.pipelineExecutions.rerunPipelineExecutionVisit({
        path: { pipelineExecutionId: runId, visitId: target.visit.id },
        headers,
      }),
    );
    outcomes.push({
      target,
      status: "rerun",
      newVisitId: latestVisitId(run, target.stepKey),
    });
  }
  return { run, outcomes };
}

/** Sends `body` to a step visit; the visit reruns with a new Task carrying it. */
export async function messageStep(
  options: RunActionOptions & {
    stepKey: string;
    attempt: number | undefined;
    body: string;
  },
): Promise<{ target: TargetVisit; sent: SentVisitMessage }> {
  const { client, headers, runId, stepKey } = options;
  const run = await loadRun(options);
  const resolved = resolveTarget(run, stepKey, options.attempt);
  if (resolved.visit.nodeKind !== "step") {
    throw new ActionError(
      "rejected",
      `"${stepKey}" is a ${resolved.visit.nodeKind} node; only steps take messages.`,
    );
  }
  const sent = unwrapAction(
    `message step "${stepKey}"`,
    await client.pipelineExecutions.sendVisitMessage({
      path: { pipelineExecutionId: runId, visitId: resolved.visit.id },
      body: { body: options.body },
      headers,
    }),
  );
  return {
    target: {
      stepKey,
      visit: resolved.visit,
      attemptNumber: resolved.attemptNumber,
    },
    sent,
  };
}

export async function cancelRun(
  options: RunActionOptions,
): Promise<RunWithVisits> {
  const { client, headers, runId } = options;
  return unwrapAction(
    `cancel pipeline run ${runId}`,
    await client.pipelineExecutions.cancelPipelineExecution({
      path: { pipelineExecutionId: runId },
      headers,
    }),
  );
}
