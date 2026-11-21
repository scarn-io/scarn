import { describe, expect, test } from "bun:test";
import { ReactFlowProvider } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeProps } from "@xyflow/react";
import { GraphNode, type GraphNodeType } from "./GraphNode";
import { NodeDetailPanel } from "./NodeDetailPanel";
import type { StudioNode, StudioNodeData } from "./studio-graph-types";
import { mcpToolTarget } from "./studio-graph-visuals";
import { translateDocumentToGraph } from "./translate-spec-to-graph";

const STEP_SHAPE = {
  kind: "step" as const,
  inputFields: [],
  resultFields: [],
  resultSchemaJson: {},
  errors: [],
};

function stepData(mcpTool?: { server: string; tool: string }): StudioNodeData {
  return {
    label: "Create issue",
    kind: "step",
    stepKey: "create-issue",
    issues: [],
    shape: { ...STEP_SHAPE, ...(mcpTool ? { mcpTool } : {}) },
  };
}

function renderNode(data: StudioNodeData): string {
  const props = {
    id: "n",
    data: { ...data, decoration: { badge: null } },
    selected: false,
  } as unknown as NodeProps<GraphNodeType>;
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <GraphNode {...props} />
    </ReactFlowProvider>,
  );
}

function renderPanel(data: StudioNodeData): string {
  const node = { id: "n", position: { x: 0, y: 0 }, data } as StudioNode;
  return renderToStaticMarkup(
    <NodeDetailPanel node={node} onBack={() => {}} />,
  );
}

describe("MCP tool steps in the studio", () => {
  test("the catalog's tool reaches the step node's shape", () => {
    const { nodes } = translateDocumentToGraph(
      {
        schemaVersion: 1,
        key: "p",
        start: { to: "create" },
        nodes: {
          create: {
            kind: "step",
            step: "create-issue",
            next: { routes: [], otherwise: { to: "done" } },
          },
          done: { kind: "succeed" },
        },
      },
      [],
      {
        "create-issue": {
          inputSchema: true,
          resultSchema: { type: "object" },
          errors: [],
          mcpTool: { server: "linear", tool: "create_issue" },
        },
      },
    );
    const create = nodes.find((node) => node.id === "create");
    expect(create && mcpToolTarget(create.data)).toBe("linear.create_issue");
  });

  test("the graph node shows a kind badge only on an MCP tool step", () => {
    const tool = renderNode(
      stepData({ server: "linear", tool: "create_issue" }),
    );
    expect(tool).toContain('data-badge="mcp-tool"');
    expect(tool).toContain("MCP tool");
    expect(tool).toContain("Calls linear.create_issue");

    expect(renderNode(stepData())).not.toContain('data-badge="mcp-tool"');
  });

  test("the detail panel names the server and tool", () => {
    const html = renderPanel(
      stepData({ server: "linear", tool: "create_issue" }),
    );
    expect(html).toContain("MCP tool");
    expect(html).toContain("<code>linear.create_issue</code>");
    expect(renderPanel(stepData())).not.toContain("MCP tool");
  });
});
