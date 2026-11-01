import { describe, expect, test } from "bun:test";
import type { StudioNode } from "../graph/studio-graph-types";
import {
  edgeDashArray,
  HANDOFF_NODE_TYPE,
} from "../graph/studio-graph-visuals";
import {
  buildTemplateGraph,
  decideUseAction,
  findTemplateStep,
  getUseButtonState,
  HANDOFF_EDGE_LABEL,
  HANDOFF_RETURN_LABEL,
  handoffHeading,
  handoffNodeId,
  missingRequiredParameters,
  parameterValuesToSubmit,
  useSuccessMessage,
  useTarget,
} from "./template-detail-model";
import type {
  TemplateConflicts,
  TemplateDetail,
  TemplateParameter,
  TemplateStepPreview,
} from "./templates-api";

function stepNode(id: string, x: number, y: number): StudioNode {
  return {
    id,
    position: { x, y },
    data: {
      label: id,
      kind: "step",
      stepKey: id,
      issues: [],
      shape: { kind: "none" },
    },
  };
}

function stepPreview(key: string): TemplateStepPreview {
  return {
    key,
    name: `${key} step`,
    description: null,
    prompt: `Do ${key}.`,
    runtime: {
      executionMode: "workspace",
      devcontainerConfigPath: null,
      managedRuntime: null,
    },
    repo: { mode: "readOnly" },
    workItemPermissions: [],
    maxTurns: null,
    inputSchema: null,
    resultSchema: null,
  };
}

const NO_CONFLICTS: TemplateConflicts = {
  takenStepKeys: [],
  pipelineKeyTaken: false,
  nextPipelineKey: "wayfinder",
};

function detail(overrides: Partial<TemplateDetail> = {}): TemplateDetail {
  return {
    key: "wayfinder",
    name: "Wayfinder",
    summary: "Plans.",
    tags: [],
    stepCount: 3,
    handoffStepCount: 2,
    parameters: [],
    conflicts: NO_CONFLICTS,
    descriptionMarkdown: "",
    pipelineKey: "wayfinder",
    stepKeys: ["plan", "research", "grilling"],
    handoffSteps: [
      { key: "research", startedBy: "plan", summary: "Answers a question." },
      { key: "grilling", startedBy: "plan", summary: "Asks a person." },
    ],
    preview: {
      pipeline: {
        key: "wayfinder",
        name: "Wayfinder",
        nodes: [stepNode("plan", 0, 100)],
        edges: [],
      },
      steps: [
        stepPreview("plan"),
        stepPreview("research"),
        stepPreview("grilling"),
      ],
      errors: [],
    },
    ...overrides,
  };
}

const param = (key: string, required: boolean): TemplateParameter => ({
  key,
  label: key,
  type: "textarea",
  required,
});

describe("buildTemplateGraph", () => {
  test("draws hand-off steps as hand-off nodes beside the step that starts them", () => {
    const { nodes } = buildTemplateGraph(detail());
    const handoffs = nodes.filter((node) => node.data.kind === "handoff");

    expect(handoffs.map((node) => node.id)).toEqual([
      handoffNodeId("research"),
      handoffNodeId("grilling"),
    ]);
    for (const node of handoffs) {
      expect(node.type).toBe(HANDOFF_NODE_TYPE);
      expect(node.position.x).toBeGreaterThan(240);
      expect(node.data.handoff?.startedBy).toBe("plan");
    }
    expect(handoffs[0]?.data.label).toBe("research step");
    expect(handoffs[0]?.position.y).toBe(100);
    expect(handoffs[1]?.position.y).toBeGreaterThan(100);
  });

  test("joins each one to its starter with a dashed, labelled hand-off edge", () => {
    const edges = buildTemplateGraph(detail()).edges.filter(
      (edge) => edge.label === HANDOFF_EDGE_LABEL,
    );

    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.source).toBe("plan");
      expect(edge.label).toBe(HANDOFF_EDGE_LABEL);
      expect(edge.data?.kind).toBe("handoff");
      expect(edge.data?.route?.kind).toBe("handoff");
      expect(edgeDashArray(edge.data)).toBeDefined();
    }
    expect(edges.map((edge) => edge.target)).toEqual([
      handoffNodeId("research"),
      handoffNodeId("grilling"),
    ]);
  });

  test("draws one dashed return edge per starter, from its first hand-off back into it", () => {
    const { edges } = buildTemplateGraph(detail());
    const returns = edges.filter((edge) => edge.label === HANDOFF_RETURN_LABEL);

    expect(edges).toHaveLength(3);
    expect(returns).toHaveLength(1);
    const [back] = returns;
    expect(back?.source).toBe(handoffNodeId("research"));
    expect(back?.target).toBe("plan");
    expect(back?.data?.kind).toBe("handoff");
    expect(back?.data?.route?.kind).toBe("handoffReturn");
    expect(edgeDashArray(back?.data)).toBeDefined();
  });

  test("routes the return edge above the starter and inside the hand-off lane", () => {
    const { edges } = buildTemplateGraph(detail());
    const out = edges.find((edge) => edge.label === HANDOFF_EDGE_LABEL)?.data
      ?.route;
    const back = edges.find((edge) => edge.label === HANDOFF_RETURN_LABEL)?.data
      ?.route;
    if (out?.kind !== "handoff" || back?.kind !== "handoffReturn") {
      throw new Error("expected hand-off routes");
    }
    expect(back.topY).toBeLessThan(100);
    expect(back.laneX).toBeLessThan(out.laneX);
    expect(back.laneX).toBeGreaterThan(240);
  });

  test("keeps a hand-off step with an unknown starter, without an edge", () => {
    const { nodes, edges } = buildTemplateGraph(
      detail({
        handoffSteps: [{ key: "research", startedBy: "gone", summary: "" }],
      }),
    );
    expect(nodes.some((node) => node.id === handoffNodeId("research"))).toBe(
      true,
    );
    expect(edges).toEqual([]);
  });

  test("returns the pipeline graph untouched without hand-off steps", () => {
    const template = detail({ handoffSteps: [] });
    const graph = buildTemplateGraph(template);
    expect(graph.nodes).toBe(template.preview.pipeline?.nodes ?? []);
  });
});

describe("findTemplateStep", () => {
  test("finds the step a graph or hand-off node shows", () => {
    const { nodes } = buildTemplateGraph(detail());
    const steps = detail().preview.steps;
    expect(
      nodes.map((node) => findTemplateStep(steps, node)?.key ?? null),
    ).toEqual(["plan", "research", "grilling"]);
  });
});

test("handoffHeading names the starting step and says it resumes", () => {
  expect(handoffHeading("plan")).toBe(
    "Started by `plan` during a round; `plan` resumes when its ticket closes",
  );
});

describe("getUseButtonState", () => {
  test("is enabled without conflicts, even when the pipeline key is taken", () => {
    expect(
      getUseButtonState(
        detail({
          conflicts: {
            takenStepKeys: [],
            pipelineKeyTaken: true,
            nextPipelineKey: "wayfinder-2",
          },
        }),
      ),
    ).toEqual({ disabled: false });
  });

  test("is disabled and lists the keys when a step key is taken", () => {
    const state = getUseButtonState(
      detail({
        conflicts: { ...NO_CONFLICTS, takenStepKeys: ["plan", "research"] },
      }),
    );
    expect(state.disabled).toBe(true);
    if (state.disabled)
      expect(state.takenStepKeys).toEqual(["plan", "research"]);
  });
});

describe("decideUseAction", () => {
  test("posts straight away when the template has no parameters", () => {
    expect(decideUseAction(detail({ parameters: [] }))).toBe("post");
  });

  test("opens the dialog when it has any, even optional ones", () => {
    expect(decideUseAction(detail({ parameters: [param("a", false)] }))).toBe(
      "dialog",
    );
  });
});

describe("useTarget", () => {
  test("writes the template's own key when it's free", () => {
    expect(useTarget(detail())).toEqual({
      pipelineKey: "wayfinder",
      file: ".scarn/pipeline-builder/wayfinder.ts",
      renamed: false,
    });
  });

  test("writes the next numbered key when it's taken", () => {
    expect(
      useTarget(
        detail({
          conflicts: {
            takenStepKeys: [],
            pipelineKeyTaken: true,
            nextPipelineKey: "wayfinder-2",
          },
        }),
      ),
    ).toEqual({
      pipelineKey: "wayfinder-2",
      file: ".scarn/pipeline-builder/wayfinder-2.ts",
      renamed: true,
    });
  });
});

describe("parameter values", () => {
  test("only unfilled required parameters are missing", () => {
    const params = [param("a", true), param("b", false)];
    expect(missingRequiredParameters(params, { a: " ", b: "" })).toEqual(["a"]);
    expect(missingRequiredParameters(params, { a: "x", b: "" })).toEqual([]);
  });

  test("blank values are left out so the template's defaults apply", () => {
    expect(parameterValuesToSubmit({ a: "x", b: "  " })).toEqual({ a: "x" });
  });
});

test("useSuccessMessage gives the path, push command and assign snippet", () => {
  expect(
    useSuccessMessage({ file: "wayfinder-2.ts", pipelineKey: "wayfinder-2" }),
  ).toEqual({
    path: ".scarn/pipeline-builder/wayfinder-2.ts",
    pipelineKey: "wayfinder-2",
    pushCommand: "scarn pipelines push",
    assignSnippet: 'assign("wayfinder-2")',
    assignmentFile: "default-pipeline-assignment.ts",
  });
});
