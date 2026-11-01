/**
 * The template detail page's logic, kept free of React so it's unit tested:
 * the preview graph with its hand-off lane, the Use button's state, what a
 * click on Use does, and the text shown after a successful Use.
 */
import {
  graphBounds,
  HANDOFF_SOURCE_HANDLE,
  HANDOFF_TARGET_HANDLE,
  LOOP_SOURCE_HANDLE,
  LOOP_TARGET_HANDLE,
} from "../graph/edge-route";
import type { StudioEdge, StudioNode } from "../graph/studio-graph-types";
import {
  HANDOFF_NODE_TYPE,
  nodeLayoutSize,
} from "../graph/studio-graph-visuals";
import type {
  TemplateDetail,
  TemplateParameter,
  TemplateStepPreview,
  TemplateStepRepoAccess,
} from "./templates-api";

export const BUILDER_DIR = ".scarn/pipeline-builder";
export const HANDOFF_EDGE_LABEL = "starts via hand-off";
export const HANDOFF_RETURN_LABEL = "resumes when tickets close";
const HANDOFF_NODE_ID_PREFIX = "handoff:";
/** Gap between the graph's right edge and the vertical lane hand-off edges share. */
const HANDOFF_LANE_GAP = 40;
/** Gap between the graph's right edge and the lane return edges drop down; inside the hand-off lane. */
const HANDOFF_RETURN_LANE_GAP = 20;
/** How far above its starter's top a return edge runs across. */
const HANDOFF_RETURN_RISE = 28;
/** Gap between that lane and the hand-off column; wide enough for the edge label. */
const HANDOFF_COLUMN_GAP = 190;
const HANDOFF_ROW_GAP = 24;

export function handoffNodeId(stepKey: string): string {
  return `${HANDOFF_NODE_ID_PREFIX}${stepKey}`;
}

/**
 * The preview graph: `preview.pipeline`'s laid-out nodes and edges, plus one
 * dashed `handoff` node per hand-off step in a column to the right of
 * everything, stacked from the row of the step that starts them, each joined
 * to that step by a dashed edge labelled "starts via hand-off". Each starter
 * also gets one dashed edge back from the top of its hand-off stack,
 * labelled "resumes when tickets close": the step pauses while its tickets
 * run and a later round picks up when they close. That edge is display only;
 * the pipeline has no such transition. A hand-off step whose starter isn't in
 * the graph gets its node but no edges.
 */
export function buildTemplateGraph(
  detail: Pick<TemplateDetail, "handoffSteps" | "preview">,
): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const baseNodes = detail.preview.pipeline?.nodes ?? [];
  const baseEdges = detail.preview.pipeline?.edges ?? [];
  if (detail.handoffSteps.length === 0) {
    return { nodes: baseNodes, edges: baseEdges };
  }

  const bounds = graphBounds(baseNodes, baseEdges);
  const right = bounds ? bounds.x + bounds.width : 0;
  const returnLaneX = right + HANDOFF_RETURN_LANE_GAP;
  const laneX = right + HANDOFF_LANE_GAP;
  const columnX = laneX + HANDOFF_COLUMN_GAP;
  const stepNames = new Map(
    detail.preview.steps.map((step) => [step.key, step.name]),
  );
  const nextRowY = new Map<string, number>();

  const returned = new Set<string>();
  const nodes: StudioNode[] = [];
  const edges: StudioEdge[] = [];
  const returnEdges: StudioEdge[] = [];
  for (const handoff of detail.handoffSteps) {
    const starter = baseNodes.find(
      (node) =>
        node.data.kind === "step" && node.data.stepKey === handoff.startedBy,
    );
    const laneKey = starter?.id ?? "";
    const y = nextRowY.get(laneKey) ?? starter?.position.y ?? bounds?.y ?? 0;
    const data: StudioNode["data"] = {
      label: stepNames.get(handoff.key) ?? handoff.key,
      kind: "handoff",
      stepKey: handoff.key,
      handoff: { startedBy: handoff.startedBy, summary: handoff.summary },
      issues: [],
      shape: { kind: "none" },
    };
    const size = nodeLayoutSize(data);
    nextRowY.set(laneKey, y + size.height + HANDOFF_ROW_GAP);
    const id = handoffNodeId(handoff.key);
    nodes.push({
      id,
      type: HANDOFF_NODE_TYPE,
      position: { x: columnX, y },
      data,
    });
    if (!starter) continue;
    if (!returned.has(starter.id)) {
      returned.add(starter.id);
      const topY = starter.position.y - HANDOFF_RETURN_RISE;
      returnEdges.push({
        id: `${id}->${starter.id}`,
        source: id,
        target: starter.id,
        sourceHandle: HANDOFF_SOURCE_HANDLE,
        targetHandle: LOOP_TARGET_HANDLE,
        label: HANDOFF_RETURN_LABEL,
        data: {
          kind: "handoff",
          index: 0,
          lane: null,
          order: null,
          issues: [],
          route: {
            kind: "handoffReturn",
            laneX: returnLaneX,
            topY,
            label: { x: (returnLaneX + columnX + size.width / 2) / 2, y: topY },
          },
        },
      });
    }
    edges.push({
      id: `${starter.id}->${id}`,
      source: starter.id,
      target: id,
      sourceHandle: LOOP_SOURCE_HANDLE,
      targetHandle: HANDOFF_TARGET_HANDLE,
      label: HANDOFF_EDGE_LABEL,
      data: {
        kind: "handoff",
        index: 0,
        lane: null,
        order: null,
        issues: [],
        route: {
          kind: "handoff",
          laneX,
          label: { x: (laneX + columnX) / 2, y: y + size.height / 2 },
        },
      },
    });
  }
  return {
    nodes: [...baseNodes, ...nodes],
    edges: [...baseEdges, ...edges, ...returnEdges],
  };
}

/** The template step a preview graph node shows, hand-off or not. */
export function findTemplateStep(
  steps: readonly TemplateStepPreview[],
  node: Pick<StudioNode, "data">,
): TemplateStepPreview | null {
  const { stepKey } = node.data;
  if (stepKey === undefined) return null;
  return steps.find((step) => step.key === stepKey) ?? null;
}

/** The heading over a hand-off step's detail panel. */
export function handoffHeading(startedBy: string): string {
  return `Started by \`${startedBy}\` during a round; \`${startedBy}\` resumes when its ticket closes`;
}

/** The pipeline key and builder file a Use writes right now. */
export function useTarget(detail: Pick<TemplateDetail, "conflicts">): {
  pipelineKey: string;
  file: string;
  renamed: boolean;
} {
  const { nextPipelineKey, pipelineKeyTaken } = detail.conflicts;
  return {
    pipelineKey: nextPipelineKey,
    file: `${BUILDER_DIR}/${nextPipelineKey}.ts`,
    renamed: pipelineKeyTaken,
  };
}

export type UseButtonState =
  | { disabled: false }
  | { disabled: true; reason: string; takenStepKeys: string[] };

/** Use is disabled while any of the template's step keys is already taken. */
export function getUseButtonState(
  detail: Pick<TemplateDetail, "conflicts">,
): UseButtonState {
  const { takenStepKeys } = detail.conflicts;
  if (takenStepKeys.length === 0) return { disabled: false };
  return {
    disabled: true,
    reason:
      takenStepKeys.length === 1
        ? "A step with this key already exists in your pipeline builder:"
        : "Steps with these keys already exist in your pipeline builder:",
    takenStepKeys,
  };
}

/** No parameters: Use writes straight away. Otherwise it opens the dialog first. */
export function decideUseAction(
  detail: Pick<TemplateDetail, "parameters">,
): "post" | "dialog" {
  return detail.parameters.length === 0 ? "post" : "dialog";
}

/** The dialog's starting values: blank, so each field shows its placeholder. */
export function initialParameterValues(
  parameters: readonly Pick<TemplateParameter, "key">[],
): Record<string, string> {
  return Object.fromEntries(parameters.map((param) => [param.key, ""]));
}

/** Required parameters the user hasn't filled in yet, by key. */
export function missingRequiredParameters(
  parameters: readonly Pick<TemplateParameter, "key" | "required">[],
  values: Readonly<Record<string, string>>,
): string[] {
  return parameters
    .filter((param) => param.required && !values[param.key]?.trim())
    .map((param) => param.key);
}

/**
 * The values to POST: blank fields are left out so the template keeps its
 * own default for them.
 */
export function parameterValuesToSubmit(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.trim() !== ""),
  );
}

export type UseSuccessMessage = {
  path: string;
  pipelineKey: string;
  pushCommand: string;
  assignSnippet: string;
  assignmentFile: string;
};

/**
 * The toast after a Use: where the file went, and the two next steps. The
 * studio never edits `default-pipeline-assignment.ts`; it only shows the line
 * to add.
 */
export function useSuccessMessage(result: {
  file: string;
  pipelineKey: string;
}): UseSuccessMessage {
  return {
    path: `${BUILDER_DIR}/${result.file}`,
    pipelineKey: result.pipelineKey,
    pushCommand: "scarn pipelines push",
    assignSnippet: `assign(${JSON.stringify(result.pipelineKey)})`,
    assignmentFile: "default-pipeline-assignment.ts",
  };
}

/** "Read-only", "Read and write" or "None" for a step's repository access. */
export function formatRepoAccess(repo: TemplateStepRepoAccess | null): string {
  switch (repo?.mode) {
    case undefined:
    case "none":
      return "None";
    case "readOnly":
      return "Read-only";
    case "readWrite":
      return "Read and write";
  }
}

/** "Workspace (devcontainer: path)", "Workspace (managed: name)" or "No workspace". */
export function formatRuntime(runtime: TemplateStepPreview["runtime"]): string {
  if (runtime.executionMode === "no_workspace") return "No workspace";
  if (runtime.devcontainerConfigPath) {
    return `Workspace (devcontainer: ${runtime.devcontainerConfigPath})`;
  }
  if (runtime.managedRuntime) {
    return `Workspace (managed: ${runtime.managedRuntime})`;
  }
  return "Workspace";
}
