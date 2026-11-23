import type { CSSProperties } from "react";
import { tint } from "./graph-palette";
import { MCP_SERVERS_BADGE, MCP_TOOL_BADGE } from "./studio-graph-visuals";

function badgeStyle(color: string): CSSProperties {
  return {
    flexShrink: 0,
    padding: "0 5px",
    borderRadius: 4,
    border: `1px solid ${tint(color, 40)}`,
    fontSize: 10,
    lineHeight: "14px",
    fontWeight: 600,
    color,
    whiteSpace: "nowrap",
  };
}

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
      style={badgeStyle(color)}
    >
      {MCP_TOOL_BADGE}
    </span>
  );
}

/** The pill beside a code step's title; its tooltip names the MCP servers it mounts. */
export function McpServersBadge({
  servers,
  color,
}: {
  servers: readonly string[];
  color: string;
}) {
  return (
    <span
      data-badge="mcp-servers"
      title={`MCP servers: ${servers.join(", ")}`}
      style={badgeStyle(color)}
    >
      {MCP_SERVERS_BADGE}
    </span>
  );
}
