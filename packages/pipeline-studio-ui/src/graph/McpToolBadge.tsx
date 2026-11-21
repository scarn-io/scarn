import { tint } from "./graph-palette";
import { MCP_TOOL_BADGE } from "./studio-graph-visuals";

/** The kind pill beside an MCP tool step's title; its tooltip names the tool. */
export function McpToolBadge({
  target,
  color,
}: {
  target: string;
  color: string;
}) {
  return (
    <span
      data-badge="mcp-tool"
      title={`Calls ${target}`}
      style={{
        flexShrink: 0,
        padding: "0 5px",
        borderRadius: 4,
        border: `1px solid ${tint(color, 40)}`,
        fontSize: 10,
        lineHeight: "14px",
        fontWeight: 600,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {MCP_TOOL_BADGE}
    </span>
  );
}
