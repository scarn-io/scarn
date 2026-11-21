// Bun's `with { type: "text" }` import attribute inlines the template at
// build time, so the bun-compile binary carries the script source as a string.
import template from "./mcp-handles-script.ts.tmpl" with { type: "text" };

export const MCP_HANDLES_SCRIPT_FILENAME = ".scarn-mcp-handles.mjs";
export const MCP_HANDLES_SCRIPT_TEMPLATE = template;
export const MCP_HANDLES_OUTPUT_MARKER = "__SCARN_MCP_HANDLES__";
