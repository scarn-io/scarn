import { describe, expect, test } from "bun:test";
import type { StudioNode } from "../graph/studio-graph-types";
import { DETACHED_NODE_TYPE } from "../graph/studio-graph-visuals";
import {
  buildTemplateGraph,
  decideUseAction,
  detachedNodeId,
  detachedStepNotice,
  findTemplateStep,
  getUseButtonState,
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
  entryKeyTaken: false,
  nextEntryKey: "wayfinder",
};

function detail(overrides: Partial<TemplateDetail> = {}): TemplateDetail {
  return {
    key: "wayfinder",
    name: "Wayfinder",
    summary: "Plans.",
    tags: [],
    entry: { kind: "pipeline", key: "wayfinder" },
    stepCount: 3,
    parameters: [],
    conflicts: NO_CONFLICTS,
    descriptionMarkdown: "",
    stepKeys: ["plan", "research", "grilling"],
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
  test("draws steps the graph doesn't run as detached nodes right of it", () => {
    const { nodes } = buildTemplateGraph(detail());
    const detached = nodes.filter((node) => node.data.kind === "detached");

    expect(detached.map((node) => node.id)).toEqual([
      detachedNodeId("research"),
      detachedNodeId("grilling"),
    ]);
    for (const node of detached) {
      expect(node.type).toBe(DETACHED_NODE_TYPE);
      expect(node.position.x).toBeGreaterThan(240);
    }
    expect(detached[0]?.data.label).toBe("research step");
    expect(detached[0]?.position.y).toBe(100);
    expect(detached[1]?.position.y).toBeGreaterThan(100);
  });

  test("gives detached steps no edges", () => {
    expect(buildTemplateGraph(detail()).edges).toEqual([]);
  });

  test("draws every step detached for an automation, which has no graph", () => {
    const template = detail({
      entry: { kind: "automation", key: "wayfinder" },
      preview: { ...detail().preview, pipeline: null },
    });
    const { nodes, edges } = buildTemplateGraph(template);
    expect(nodes.map((node) => node.id)).toEqual([
      detachedNodeId("plan"),
      detachedNodeId("research"),
      detachedNodeId("grilling"),
    ]);
    expect(nodes.every((node) => node.data.kind === "detached")).toBe(true);
    expect(nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(edges).toEqual([]);
  });

  test("returns the pipeline graph untouched when it runs every step", () => {
    const template = detail({
      preview: { ...detail().preview, steps: [stepPreview("plan")] },
    });
    const graph = buildTemplateGraph(template);
    expect(graph.nodes).toBe(template.preview.pipeline?.nodes ?? []);
  });
});

describe("findTemplateStep", () => {
  test("finds the step a graph or detached node shows", () => {
    const { nodes } = buildTemplateGraph(detail());
    const steps = detail().preview.steps;
    expect(
      nodes.map((node) => findTemplateStep(steps, node)?.key ?? null),
    ).toEqual(["plan", "research", "grilling"]);
  });
});

test("detachedStepNotice says what starts a detached step", () => {
  expect(detachedStepNotice("automation")).toContain("automation's rules");
  expect(detachedStepNotice("pipeline")).toContain("an agent starts it");
});

describe("getUseButtonState", () => {
  test("is enabled without conflicts, even when the entry key is taken", () => {
    expect(
      getUseButtonState(
        detail({
          conflicts: {
            takenStepKeys: [],
            entryKeyTaken: true,
            nextEntryKey: "wayfinder-2",
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
      entryKey: "wayfinder",
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
            entryKeyTaken: true,
            nextEntryKey: "wayfinder-2",
          },
        }),
      ),
    ).toEqual({
      entryKey: "wayfinder-2",
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

describe("useSuccessMessage", () => {
  test("gives the path, push command and a default.ts route to the pipeline", () => {
    expect(
      useSuccessMessage({
        file: "wayfinder-2.ts",
        entry: { kind: "pipeline", key: "wayfinder-2" },
      }),
    ).toEqual({
      path: ".scarn/pipeline-builder/wayfinder-2.ts",
      entryKey: "wayfinder-2",
      pushCommand: "scarn pipelines push",
      importSnippet: 'import wayfinder2 from "./wayfinder-2";',
      routeSnippet: "{ when: (r) => …, to: wayfinder2 }",
      automationFile: "default.ts",
    });
  });

  test("an automation template routes to attach(x)", () => {
    const message = useSuccessMessage({
      file: "wayfinder.ts",
      entry: { kind: "automation", key: "wayfinder" },
    });
    expect(message.routeSnippet).toBe(
      "{ when: (r) => …, to: attach(wayfinder) }",
    );
  });
});
