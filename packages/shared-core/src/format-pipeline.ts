import {
  pipelineDocumentSchema,
  routeEntries,
  type Catch,
  type PipelineDocument,
  type PipelineNode,
  type Route,
  type Start,
} from "@scarn/sdk/contracts/pipeline-document";
import type {
  GatheredPipelineShow,
  PinnedStepDefinition,
} from "./gather-pipeline";
import { shortId } from "./lib/short-id";

/** Text rendering for `pipelines show`: the version header, then every node
 * with its edges, ending with the commands to dig further. */

function describeEdge(
  route: Start | Omit<Route, "when"> | Route,
  label: string,
): string {
  const parts = [`→ ${route.to}`];
  if (label !== "") parts.push(label);
  if (route.pipeline !== undefined) parts.push(`pipeline ${route.pipeline}`);
  if (route.each !== undefined) parts.push(`each ${route.each.over}`);
  if ("partial" in route && route.partial === true) parts.push("partial");
  return parts.join("  ");
}

function describeCatch(entry: Catch): string {
  const parts = [`→ ${entry.to}`, `catch ${entry.on.join(", ")}`];
  if (entry.pipeline !== undefined) parts.push(`pipeline ${entry.pipeline}`);
  return parts.join("  ");
}

function edgeLines(node: PipelineNode): string[] {
  if (node.kind === "succeed" || node.kind === "fail") return [];
  const match = node.next?.match === "all" ? "every match" : "first match";
  const routes = routeEntries(node.next).map((entry) =>
    describeEdge(
      entry.route,
      entry.kind === "otherwise"
        ? "otherwise"
        : "when" in entry.route && entry.route.when !== undefined
          ? `when (${match})`
          : "",
    ),
  );
  return [...routes, ...(node.catch ?? []).map(describeCatch)];
}

function describeStep(
  stepKey: string,
  steps: readonly PinnedStepDefinition[],
): string {
  const pinned = steps.find((step) => step.stepKey === stepKey);
  if (pinned === undefined) return `step ${stepKey}`;
  if (pinned.status === "unavailable") {
    return `step ${stepKey} ${shortId(pinned.stepDefinitionId)} (unavailable: ${pinned.reason})`;
  }
  const { definition } = pinned;
  return `step ${stepKey} v${String(definition.version)} "${definition.name}" (${definition.kind}, ${definition.id})`;
}

function describeNode(
  node: PipelineNode,
  steps: readonly PinnedStepDefinition[],
): string {
  switch (node.kind) {
    case "step": {
      const limits = [
        node.maxRuns === undefined ? "" : `maxRuns ${String(node.maxRuns)}`,
        node.maxTurns === undefined ? "" : `maxTurns ${String(node.maxTurns)}`,
        node.retry === undefined
          ? ""
          : `retry ${node.retry.map((retry) => `${retry.on.join("|")}×${String(retry.maxAttempts)}`).join(", ")}`,
      ].filter((part) => part !== "");
      return [describeStep(node.step, steps), ...limits].join("  ");
    }
    case "wait": {
      const actions =
        node.actions === undefined
          ? ""
          : `  actions ${node.actions.map((action) => action.key).join(", ")}`;
      return `wait for ${node.for}${actions}`;
    }
    case "succeed":
      return "succeed";
    case "fail":
      return node.error === undefined ? "fail" : `fail with ${node.error}`;
  }
}

function documentLines(
  document: PipelineDocument,
  steps: readonly PinnedStepDefinition[],
): string[] {
  const nodes = Object.entries(document.nodes);
  const lines = [
    "",
    `Start  ${describeEdge(document.start, "")}`,
    "",
    `Nodes (${String(nodes.length)})`,
  ];
  for (const [nodeId, node] of nodes) {
    const title = node.title === undefined ? "" : `  "${node.title}"`;
    lines.push(
      `  ${node.kind.padEnd(7)} ${nodeId}${title}`,
      `          ${describeNode(node, steps)}`,
    );
    for (const edge of edgeLines(node)) lines.push(`          ${edge}`);
  }
  return lines;
}

export function formatPipelineShow(gathered: GatheredPipelineShow): string {
  const { pipeline, version, steps } = gathered;
  const state = gathered.isActive ? "active" : "not active";
  const lines = [
    `Pipeline ${pipeline.key}  "${pipeline.name}"`,
    `Id:      ${pipeline.id}`,
    `Version: ${String(version.version)} (${state})  published ${version.createdAt}  hash ${version.contentHash.slice(0, 12)}`,
  ];
  if (pipeline.archivedAt !== null) {
    lines.push(`Archived ${pipeline.archivedAt}`);
  }
  const parsed = pipelineDocumentSchema.safeParse(version.definition);
  if (parsed.success) {
    lines.push(...documentLines(parsed.data, steps));
  } else {
    lines.push(
      "",
      "The document does not match the schema this CLI knows; --json prints it as stored.",
    );
  }
  lines.push(
    "",
    `→ scarn runs list --pipeline ${pipeline.key}`,
    `→ scarn pipelines show ${pipeline.key}${gathered.isActive ? "" : ` --version ${String(version.version)}`} --json`,
  );
  return lines.join("\n");
}
