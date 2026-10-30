import type { StudioIssue } from "./studio-graph-types";
import { severityColor } from "./studio-graph-visuals";

/**
 * A small colored pill labeling an issue's own severity ("ERROR"/"WARNING"/
 * "INFO", via CSS `text-transform: uppercase`). Shown next to every issue
 * row in both the pipeline-level issues list and the per-node detail panel.
 * Reuses `severityColor`, so its color matches the issue's node/edge color.
 */
export function SeverityChip({
  severity,
}: {
  severity: StudioIssue["severity"];
}) {
  return (
    <span
      className="studio-severity-chip"
      style={{ backgroundColor: severityColor(severity) }}
    >
      {severity}
    </span>
  );
}
