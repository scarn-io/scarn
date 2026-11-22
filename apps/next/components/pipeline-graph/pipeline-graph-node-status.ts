import type { NodeVisitContract } from "@scarn/api/frontend-contracts";
import { getStepRunStatusLabel } from "@/components/executions/step-run-status-icon";
import {
  deriveVisitDisplayStatus,
  pickWorstVisitStatus,
  type VisitDisplayStatus,
} from "@/components/executions/visit-status";

/**
 * The color bucket a graph node's border/badge is drawn in — a subset of
 * MUI's `SvgIconProps["color"]` values, kept as our own union so this stays a
 * plain, React-free helper.
 */
export type NodeVisualStatusColorKey =
  "disabled" | "primary" | "warning" | "error" | "success";

/**
 * What a graph node needs to render its status: the worst current visit's
 * label and color, plus an "N/M succeeded" badge when the node has more than
 * one current visit (one per lane). All `null`/`false` when no current visit
 * is at this node.
 */
export type NodeVisualStatus = {
  label: string | null;
  colorKey: NodeVisualStatusColorKey | null;
  badgeLabel: string | null;
  /** Whether a current (non-superseded) visit reached this node; colors the edges into it. */
  traversed: boolean;
};

const STATUS_COLOR_KEY: Record<VisitDisplayStatus, NodeVisualStatusColorKey> = {
  queued: "disabled",
  running: "primary",
  abandoned: "warning",
  timeout: "error",
  waiting: "warning",
  succeeded: "success",
  failed: "error",
  cancelled: "disabled",
  superseded: "disabled",
};

export function computeNodeVisualStatus(
  nodeId: string,
  visits: readonly NodeVisitContract[],
): NodeVisualStatus {
  const statuses = visits
    .filter((visit) => visit.nodeId === nodeId && visit.status !== "superseded")
    .map(deriveVisitDisplayStatus);
  const worst = pickWorstVisitStatus(statuses);
  if (worst === null) {
    return { label: null, colorKey: null, badgeLabel: null, traversed: false };
  }
  const succeeded = statuses.filter((status) => status === "succeeded").length;
  return {
    label: getStepRunStatusLabel(worst),
    colorKey: STATUS_COLOR_KEY[worst],
    badgeLabel:
      statuses.length > 1
        ? `${String(succeeded)}/${String(statuses.length)} succeeded`
        : null,
    traversed: true,
  };
}
