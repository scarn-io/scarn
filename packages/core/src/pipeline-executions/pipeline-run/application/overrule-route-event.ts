import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { PipelineGraphVersionRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-version-repo";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { StepDefinitionKind } from "@scarn/core/pipeline-definitions/step-definition/domain/step-definition-entity";
import { assertNever } from "@scarn/core/lib/assert-never";
import {
  routeEntries,
  type Next,
  type PipelineDocument,
} from "@scarn/sdk/contracts/pipeline-document";
import type { RouteSelector } from "../contracts/overrule-contracts";
import type {
  EngineEvent,
  Routing,
  VisitTransition,
} from "../domain/engine/types";
import { stepDefinitionForNode } from "./step-definition-for-node";

export type OverruleEvent = Extract<EngineEvent, { type: "route_overruled" }>;

/** The overrule as analytics reports it. */
export type OverruleSummary = {
  nodeId: string;
  match: "first" | "all";
  from: VisitTransition[];
  to: VisitTransition[];
};

export type OverruleEventDeps = {
  pipelineGraphVersionRepo: PipelineGraphVersionRepo;
  stepDefinitionRepo: StepDefinitionRepo;
};

const describeTransition = ({ kind, index }: VisitTransition): string =>
  kind === "otherwise" ? "otherwise" : `routes[${String(index)}]`;

const nextOf = (
  document: PipelineDocument,
  nodeId: string,
): Next | undefined => {
  const node = document.nodes[nodeId];
  return node?.kind === "step" || node?.kind === "wait" ? node.next : undefined;
};

const resolveSelector = (
  next: Next | undefined,
  nodeId: string,
  selector: RouteSelector,
): Result<VisitTransition, CoreValidationError> => {
  if ("kind" in selector) {
    return Result.ok(
      selector.kind === "route"
        ? { kind: "route", index: selector.index }
        : { kind: "otherwise", index: 0 },
    );
  }
  const [field, value] =
    "to" in selector
      ? (["to", selector.to] as const)
      : (["label", selector.label] as const);
  const matches = routeEntries(next)
    .filter((entry) =>
      field === "to" ? entry.route.to === value : entry.route.label === value,
    )
    .map(({ kind, index }): VisitTransition => ({ kind, index }));
  const [only] = matches;
  if (only === undefined) {
    return Result.err(
      new CoreValidationError(
        `node "${nodeId}" has no route with ${field} "${value}"`,
        "PIPELINE_RUN_UNKNOWN_ROUTE",
      ),
    );
  }
  if (matches.length > 1) {
    return Result.err(
      new CoreValidationError(
        `${String(matches.length)} routes of node "${nodeId}" have ${field} "${value}": ${matches.map(describeTransition).join(", ")}; pick one by index`,
        "PIPELINE_RUN_ROUTE_AMBIGUOUS",
        { routes: matches },
      ),
    );
  }
  return Result.ok(only);
};

const isTurnedOn = (
  route: VisitTransition,
  taken: readonly VisitTransition[],
): boolean =>
  !taken.some(
    (entry) => entry.kind === route.kind && entry.index === route.index,
  );

/**
 * Whether a step of this kind can run with missing input: an agent step can,
 * a code step's entrypoint and an MCP tool step's args template can't.
 */
const toleratesMissingInput = (kind: StepDefinitionKind): boolean => {
  switch (kind) {
    case "built_in":
    case "user_defined":
      return true;
    case "code":
    case "mcp_tool":
      return false;
    default:
      return assertNever(kind);
  }
};

/**
 * Whether any route the overrule turns on leads to a step that can't run
 * with missing input (see `toleratesMissingInput`).
 */
const turnsOnCodeStep = async (
  pipelineGraphVersionId: UuidV7,
  next: Next | undefined,
  routes: readonly VisitTransition[],
  taken: readonly VisitTransition[],
  deps: OverruleEventDeps,
  tx: DbExecutor | undefined,
): Promise<boolean> => {
  const targets = new Set(
    routeEntries(next)
      .filter(
        (entry) =>
          routes.some(
            (route) => route.kind === entry.kind && route.index === entry.index,
          ) && isTurnedOn(entry, taken),
      )
      .map((entry) => entry.route.to),
  );
  for (const nodeId of targets) {
    const stepDefinition = await stepDefinitionForNode(
      { pipelineGraphVersionId, nodeId },
      deps,
      tx,
    );
    if (stepDefinition && !toleratesMissingInput(stepDefinition.kind)) {
      return true;
    }
  }
  return false;
};

/**
 * Builds the `route_overruled` event for a person's overrule of a visit:
 * resolves each route selector against the visit's node, and picks how
 * missing args are handled (refused outright when a route turns on a code
 * step).
 */
export const buildOverruleEvent = async (
  request: {
    visitId: string;
    routes: readonly RouteSelector[];
    reason: string;
    acceptMissing: boolean;
    userId: string;
  },
  pipeline: { versionId: UuidV7; document: PipelineDocument },
  visit: { nodeId: string; routing: Routing | null },
  deps: OverruleEventDeps,
  tx?: DbExecutor,
): Promise<
  Result<
    { event: OverruleEvent; summary: OverruleSummary },
    CoreValidationError
  >
> => {
  const next = nextOf(pipeline.document, visit.nodeId);
  const routes: VisitTransition[] = [];
  for (const selector of request.routes) {
    const resolved = resolveSelector(next, visit.nodeId, selector);
    if (!resolved.ok) {
      return resolved;
    }
    routes.push(resolved.value);
  }
  const taken = visit.routing?.taken ?? [];
  const codeStep = await turnsOnCodeStep(
    pipeline.versionId,
    next,
    routes,
    taken,
    deps,
    tx,
  );
  return Result.ok({
    event: {
      type: "route_overruled",
      visitId: request.visitId,
      routes,
      reason: request.reason,
      userId: request.userId,
      missingArgs: codeStep
        ? "reject_code_step"
        : request.acceptMissing
          ? "accept"
          : "reject",
    },
    summary: {
      nodeId: visit.nodeId,
      match: next?.match ?? "first",
      from: taken,
      to: routes,
    },
  });
};
