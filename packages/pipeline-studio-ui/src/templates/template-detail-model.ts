/**
 * The template detail page's logic, kept free of React so it's unit tested:
 * the preview graph with its detached steps, the Use button's state, what a
 * click on Use does, and the text shown after a successful Use.
 */
import type { Grant } from "@scarn/sdk/definitions/steps";
import { graphBounds } from "../graph/edge-route";
import type { StudioEdge, StudioNode } from "../graph/studio-graph-types";
import {
  DETACHED_NODE_TYPE,
  nodeLayoutSize,
} from "../graph/studio-graph-visuals";
import type {
  TemplateDetail,
  TemplateEntryKind,
  TemplateParameter,
  TemplateStepPreview,
  TemplateStepRepoAccess,
} from "./templates-api";

export const BUILDER_DIR = ".scarn/pipeline-builder";
const DETACHED_NODE_ID_PREFIX = "detached:";
/** Gap between the graph's right edge and the detached-step column. */
const DETACHED_COLUMN_GAP = 80;
const DETACHED_ROW_GAP = 24;

export function detachedNodeId(stepKey: string): string {
  return `${DETACHED_NODE_ID_PREFIX}${stepKey}`;
}

/**
 * The preview graph: `preview.pipeline`'s laid-out nodes and edges, plus one
 * dashed `detached` node, with no edges, for each step the file exports that
 * the graph doesn't run, stacked in a column to the right of everything. For
 * an automation entry there is no graph, so every step is detached.
 */
export function buildTemplateGraph(detail: Pick<TemplateDetail, "preview">): {
  nodes: StudioNode[];
  edges: StudioEdge[];
} {
  const baseNodes = detail.preview.pipeline?.nodes ?? [];
  const baseEdges = detail.preview.pipeline?.edges ?? [];
  const inGraph = new Set(
    baseNodes.flatMap((node) =>
      node.data.kind === "step" && node.data.stepKey !== undefined
        ? [node.data.stepKey]
        : [],
    ),
  );
  const detachedSteps = detail.preview.steps.filter(
    (step) => !inGraph.has(step.key),
  );
  if (detachedSteps.length === 0) {
    return { nodes: baseNodes, edges: baseEdges };
  }

  const bounds = graphBounds(baseNodes, baseEdges);
  const columnX = bounds ? bounds.x + bounds.width + DETACHED_COLUMN_GAP : 0;
  let y = bounds?.y ?? 0;
  const nodes = detachedSteps.map((step): StudioNode => {
    const data: StudioNode["data"] = {
      label: step.name,
      kind: "detached",
      stepKey: step.key,
      issues: [],
      shape: { kind: "none" },
    };
    const node: StudioNode = {
      id: detachedNodeId(step.key),
      type: DETACHED_NODE_TYPE,
      position: { x: columnX, y },
      data,
    };
    y += nodeLayoutSize(data).height + DETACHED_ROW_GAP;
    return node;
  });
  return { nodes: [...baseNodes, ...nodes], edges: baseEdges };
}

/** The template step a preview graph node shows, detached or not. */
export function findTemplateStep(
  steps: readonly TemplateStepPreview[],
  node: Pick<StudioNode, "data">,
): TemplateStepPreview | null {
  const { stepKey } = node.data;
  if (stepKey === undefined) return null;
  return steps.find((step) => step.key === stepKey) ?? null;
}

/** The note over a detached step's detail panel. */
export function detachedStepNotice(kind: TemplateEntryKind): string {
  return kind === "automation"
    ? "Started by the automation's rules, not by a pipeline graph."
    : "Not part of the pipeline graph; an agent starts it by key.";
}

/** The entry key and builder file a Use writes right now. */
export function useTarget(detail: Pick<TemplateDetail, "conflicts">): {
  entryKey: string;
  file: string;
  renamed: boolean;
} {
  const { nextEntryKey, entryKeyTaken } = detail.conflicts;
  return {
    entryKey: nextEntryKey,
    file: `${BUILDER_DIR}/${nextEntryKey}.ts`,
    renamed: entryKeyTaken,
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
  entryKey: string;
  pushCommand: string;
  importSnippet: string;
  routeSnippet: string;
  automationFile: string;
};

/** `wayfinder-2` → `wayfinder2`: the default import's name for a key. */
function importNameOf(key: string): string {
  const name = key
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part !== "")
    .map((part, index) =>
      index === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join("");
  return /^[A-Za-z_$]/u.test(name) ? name : `_${name}`;
}

/**
 * The toast after a Use: where the file went, and the two next steps. The
 * studio never edits `default.ts`; it only shows the route to add: `to: x`
 * for a pipeline, `to: attach(x)` for a work-item automation.
 */
export function useSuccessMessage(result: {
  file: string;
  entry: { kind: TemplateEntryKind; key: string };
}): UseSuccessMessage {
  const name = importNameOf(result.entry.key);
  const target = result.entry.kind === "automation" ? `attach(${name})` : name;
  return {
    path: `${BUILDER_DIR}/${result.file}`,
    entryKey: result.entry.key,
    pushCommand: "scarn pipelines push",
    importSnippet: `import ${name} from "./${result.file.replace(/\.ts$/u, "")}";`,
    routeSnippet: `{ when: (r) => …, to: ${target} }`,
    automationFile: "default.ts",
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

/**
 * A step's grants on one line, e.g. "read self; create children:
 * wayfinder:research, wayfinder:task; close self", or "None".
 */
export function describeGrants(grants: readonly Grant[]): string {
  if (grants.length === 0) return "None";
  return grants
    .map((grant) => {
      const head = `${grant.action} ${grant.scope}`;
      return "labels" in grant ? `${head}: ${grant.labels.join(", ")}` : head;
    })
    .join("; ");
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
