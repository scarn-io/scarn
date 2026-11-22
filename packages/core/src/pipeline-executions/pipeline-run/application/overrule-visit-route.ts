import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import {
  overrulePreviewResultSchema,
  overruleVisitRouteInputSchema,
  type OverrulePreviewResult,
  type OverruleVisitRouteInput,
} from "../contracts/overrule-contracts";
import type { PipelineExecutionContract } from "../contracts/pipeline-run-contracts";
import { decide } from "../domain/engine/decide";
import { summarizeOverrule } from "../domain/engine/summarize-overrule";
import {
  DecideError,
  type Routing,
  type VisitTransition,
} from "../domain/engine/types";
import type { PipelineRunEntity } from "../domain/pipeline-run-entity";
import {
  decideErrorToResult,
  loadRunState,
  type AdvanceError,
} from "./advance-pipeline-run";
import {
  commandPipelineRun,
  type PipelineRunCommandDeps,
} from "./command-pipeline-run";
import {
  buildOverruleEvent,
  type OverruleEvent,
  type OverruleSummary,
} from "./overrule-route-event";

type ParsedInput = ReturnType<typeof overruleVisitRouteInputSchema.parse>;

const describeTransition = ({ kind, index }: VisitTransition): string =>
  kind === "otherwise" ? "otherwise" : `${kind}:${String(index)}`;

/** Loads the run's pinned version and the visit, and builds the overrule event. */
const overruleEventFor = async (
  run: PipelineRunEntity,
  input: ParsedInput,
  deps: PipelineRunCommandDeps,
  tx: DbExecutor,
): Promise<
  Result<
    {
      event: OverruleEvent;
      summary: OverruleSummary;
      document: PipelineDocument;
    },
    AdvanceError
  >
> => {
  const version = await deps.pipelineGraphVersionRepo.load(
    run.pipelineGraphVersionId,
    tx,
  );
  if (!version) {
    return Result.err(
      new ResourceNotFoundError(
        "Pipeline graph version",
        run.pipelineGraphVersionId,
      ),
    );
  }
  const history = await deps.pipelineRunRepo.loadHistory(run.id, tx);
  const visit = history.visits.find((item) => item.id === input.visitId);
  if (!visit) {
    return Result.err(new ResourceNotFoundError("Node visit", input.visitId));
  }
  const built = await buildOverruleEvent(
    {
      visitId: input.visitId,
      routes: input.routes,
      reason: input.reason,
      acceptMissing: input.acceptMissing,
      userId: deps.userAuthz.actorId,
    },
    { versionId: version.id, document: version.definitionJson },
    { nodeId: visit.nodeId, routing: visit.routing },
    deps,
    tx,
  );
  return built.ok
    ? Result.ok({ ...built.value, document: version.definitionJson })
    : built;
};

/** Runs `decide` on the run as it is and summarizes the commands, writing nothing. */
const previewOverrule = async (
  input: ParsedInput,
  deps: PipelineRunCommandDeps,
): Promise<Result<OverrulePreviewResult, AdvanceError>> => {
  const run = await deps.pipelineRunRepo.load(
    input.pipelineExecutionId,
    deps.dbExecutor,
  );
  if (!run) {
    return Result.err(
      new ResourceNotFoundError("Pipeline run", input.pipelineExecutionId),
    );
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: run.projectId,
    permission: "executions:write",
    dbExecutor: deps.dbExecutor,
  });
  const db: DbExecutor = deps.dbExecutor ?? getDb();
  return await db.transaction(async (tx) => {
    const built = await overruleEventFor(run, input, deps, tx);
    if (!built.ok) {
      return built;
    }
    const { state } = await loadRunState(run, deps, tx);
    const { event, document } = built.value;
    try {
      const { commands } = decide(document, state, event, {
        newId: createUuidV7,
        now: deps.timeProvider.now().toISOString(),
      });
      return Result.ok(
        overrulePreviewResultSchema.parse({
          preview: summarizeOverrule(document, state, event.visitId, commands),
        }),
      );
    } catch (error) {
      if (error instanceof DecideError) {
        return Result.err(decideErrorToResult(error, event));
      }
      throw error;
    }
  });
};

const acceptedMissingCount = (
  execution: PipelineExecutionContract,
  visitId: string,
): number => {
  const visit = execution.visits.find((item) => item.id === visitId);
  const routing = visit?.routing as Routing | null | undefined;
  return routing?.overrules?.at(-1)?.missingArgs.length ?? 0;
};

/**
 * A person changes which routes a succeeded step visit took, with a reason.
 * The visit keeps its result; what came after it is superseded and the run
 * continues along the new routes. With `preview`, returns what the overrule
 * would do and writes nothing; refusals come back the same way either way.
 */
export const overruleVisitRoute = async (
  input: OverruleVisitRouteInput,
  deps: PipelineRunCommandDeps,
): Promise<
  Result<PipelineExecutionContract | OverrulePreviewResult, AdvanceError>
> => {
  const parsed = overruleVisitRouteInputSchema.parse(input);
  if (parsed.preview) {
    return await previewOverrule(parsed, deps);
  }
  let summary: OverruleSummary | undefined;
  let projectId: string | undefined;
  const outcome = await commandPipelineRun(
    parsed.pipelineExecutionId,
    {
      event: async (run, tx) => {
        const built = await overruleEventFor(run, parsed, deps, tx);
        if (!built.ok) {
          return built;
        }
        summary = built.value.summary;
        projectId = run.projectId;
        return Result.ok(built.value.event);
      },
    },
    deps,
  );
  if (!outcome.ok) {
    return outcome;
  }
  const execution = outcome.value.pipelineExecution;
  if (summary && projectId && !deps.dbExecutor) {
    deps.analytics.capture(
      deps.userAuthz.actorId,
      AnalyticsEvents.PipelineRouteOverruled,
      {
        project_id: projectId,
        pipeline_run_id: execution.id,
        node_id: summary.nodeId,
        match: summary.match,
        from: summary.from.map(describeTransition),
        to: summary.to.map(describeTransition),
        accepted_missing: acceptedMissingCount(execution, parsed.visitId) > 0,
      },
    );
  }
  return Result.ok(execution);
};
