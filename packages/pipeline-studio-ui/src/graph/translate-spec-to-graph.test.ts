import { describe, expect, test } from "bun:test";
import type {
  PipelineDocument,
  StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import ROUTES_ALL from "../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/routes-all.json";
import type { StudioIssue } from "./studio-graph-types";
import {
  nodeIdFromPath,
  START_NODE_ID,
  translateDocumentToGraph,
  translatePipelineToSnapshot,
} from "./translate-spec-to-graph";

const BUG_PIPELINE: PipelineDocument = {
  schemaVersion: 1,
  key: "fix-bug",
  title: "Fix a bug",
  start: { to: "triage" },
  nodes: {
    triage: {
      kind: "step",
      title: "Triage",
      step: "triage",
      next: {
        routes: [
          {
            when: {
              path: "result.score",
              op: "greaterThanInclusive",
              value: 7,
            },
            to: "fix",
          },
        ],
        otherwise: { to: "rejected" },
      },
      catch: [{ on: ["Scarn.Timeout"], to: "failed" }],
    },
    fix: {
      kind: "step",
      step: "fix",
      next: {
        routes: [{ to: "review", each: { over: "result.files" } }],
      },
    },
    review: {
      kind: "wait",
      for: "decision",
      actions: [
        { key: "approve", label: "Approve", body: "optional" },
        { key: "reject", label: "Reject", body: "optional" },
      ],
      next: {
        routes: [{ to: "done", partial: true }],
      },
    },
    done: { kind: "succeed" },
    rejected: { kind: "succeed", title: "Not worth fixing" },
    failed: { kind: "fail", error: "Triage.TimedOut" },
  },
};

const CATALOG: StepCatalog = {
  triage: {
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title"],
    },
    resultSchema: {
      type: "object",
      properties: { score: { type: "number" }, files: { type: "array" } },
    },
    errors: ["Triage.Unclear"],
  },
};

function issue(overrides: Partial<StudioIssue>): StudioIssue {
  return {
    code: "unknown_path",
    severity: "error",
    message: "message",
    pipelineKey: "fix-bug",
    ...overrides,
  };
}

describe("translateDocumentToGraph — mapping", () => {
  const { nodes, edges } = translateDocumentToGraph(BUG_PIPELINE);

  test("adds a start node plus one node per document node", () => {
    expect(nodes.map((node) => [node.id, node.data.kind])).toEqual([
      [START_NODE_ID, "start"],
      ["triage", "step"],
      ["fix", "step"],
      ["review", "wait"],
      ["done", "succeed"],
      ["rejected", "succeed"],
      ["failed", "fail"],
    ]);
  });

  test("labels nodes by title, falling back to the node id", () => {
    const labels = Object.fromEntries(
      nodes.map((node) => [node.id, node.data.label]),
    );
    expect(labels["triage"]).toBe("Triage");
    expect(labels["fix"]).toBe("fix");
    expect(labels["rejected"]).toBe("Not worth fixing");
  });

  test("records the step key and wait kind", () => {
    const fix = nodes.find((node) => node.id === "fix");
    const review = nodes.find((node) => node.id === "review");
    expect(fix?.data.stepKey).toBe("fix");
    expect(review?.data.waitFor).toBe("decision");
  });

  test("builds start, route, otherwise and catch edges with lane markers", () => {
    expect(
      edges.map((edge) => [
        edge.source,
        edge.target,
        edge.data?.kind,
        edge.data?.lane,
      ]),
    ).toEqual([
      [START_NODE_ID, "triage", "start", null],
      ["triage", "fix", "route", null],
      ["triage", "rejected", "otherwise", null],
      ["triage", "failed", "catch", null],
      ["fix", "review", "route", "each"],
      ["review", "done", "route", "partial"],
    ]);
  });

  test("labels conditions, fallbacks, lanes and catches", () => {
    expect(edges.map((edge) => edge.label)).toEqual([
      undefined,
      "result.score >= 7",
      "otherwise",
      "catch Scarn.Timeout",
      "each over result.files",
      "partial",
    ]);
  });

  test("marks first nodes and leaves a lone route unnumbered", () => {
    const triage = nodes.find((node) => node.id === "triage");
    expect(triage?.data.match).toBe("first");
    expect(nodes.find((node) => node.id === "done")?.data.match).toBe(
      undefined,
    );
    expect(edges.map((edge) => edge.data?.order)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("lists the partial routes a merge node waits for", () => {
    const done = nodes.find((node) => node.id === "done");
    expect(done?.data.mergeWaitsFor).toEqual(["review"]);
    expect(
      nodes.find((node) => node.id === "fix")?.data.mergeWaitsFor,
    ).toBeUndefined();
  });

  test("gives every edge a unique id", () => {
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
  });

  test("lays out every node at a distinct position", () => {
    const positions = new Set(
      nodes.map(
        (node) => `${String(node.position.x)},${String(node.position.y)}`,
      ),
    );
    expect(positions.size).toBe(nodes.length);
  });
});

describe("translateDocumentToGraph — route order", () => {
  test("numbers the routes of a first node with several routes, not otherwise", () => {
    const document: PipelineDocument = {
      schemaVersion: 1,
      key: "order",
      start: { to: "a" },
      nodes: {
        a: {
          kind: "step",
          step: "a",
          next: {
            routes: [
              { when: { path: "result.x", op: "equal", value: 1 }, to: "b" },
              { when: { path: "result.x", op: "equal", value: 2 }, to: "c" },
            ],
            otherwise: { to: "c" },
          },
        },
        b: { kind: "succeed" },
        c: { kind: "succeed" },
      },
    };
    const { edges } = translateDocumentToGraph(document);
    expect(
      edges.map((edge) => [edge.target, edge.data?.kind, edge.data?.order]),
    ).toEqual([
      ["a", "start", null],
      ["b", "route", 1],
      ["c", "route", 2],
      ["c", "otherwise", null],
    ]);
  });
});

describe("translateDocumentToGraph — routes-all catalog fixture", () => {
  const { nodes, edges } = translateDocumentToGraph(
    ROUTES_ALL as PipelineDocument,
  );
  const node = (id: string) => nodes.find((entry) => entry.id === id);

  test("marks the fork node as all and leaves its routes unordered", () => {
    expect(node("classifyIssue")?.data.match).toBe("all");
    expect(node("summariseFindings")?.data.match).toBe("first");
    const forkEdges = edges.filter((edge) => edge.source === "classifyIssue");
    expect(forkEdges.map((edge) => edge.data?.order)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("labels always, condition, each and otherwise routes of the fork", () => {
    expect(
      edges
        .filter((edge) => edge.source === "classifyIssue")
        .map((edge) => [edge.target, edge.label, edge.data?.lane]),
    ).toEqual([
      ["reproduceBug", "always", null],
      ["notifySecurity", 'result.category == "security"', null],
      [
        "captureScreenshot",
        "not (result.affectedPages isEmpty) · each over …",
        "each",
      ],
      ["addToBacklog", "otherwise", null],
    ]);
  });

  test("badges the partial and closing merges with the routes they wait for", () => {
    expect(node("writeFailingTest")?.data.mergeWaitsFor).toEqual([
      "Reproduce bug",
      "Notify security",
    ]);
    expect(node("summariseFindings")?.data.mergeWaitsFor).toEqual([
      "Capture screenshot",
      "Write failing test",
    ]);
    expect(node("addToBacklog")?.data.mergeWaitsFor).toBeUndefined();
  });

  test("lays out every node at a distinct position", () => {
    const positions = new Set(
      nodes.map(
        (entry) => `${String(entry.position.x)},${String(entry.position.y)}`,
      ),
    );
    expect(positions.size).toBe(nodes.length);
  });
});

describe("translateDocumentToGraph — edge routes", () => {
  const LOOPING: PipelineDocument = {
    schemaVersion: 1,
    key: "loop",
    start: { to: "propose" },
    nodes: {
      propose: {
        kind: "step",
        step: "propose",
        next: {
          routes: [
            { when: { path: "result.ok", op: "equal", value: true }, to: "review" },
          ],
          otherwise: { to: "propose" },
        },
      },
      review: {
        kind: "wait",
        for: "decision",
        actions: [{ key: "revise", label: "Revise", body: "optional" }],
        next: {
          routes: [
            { when: { path: "result.action", op: "equal", value: "revise" }, to: "propose" },
          ],
          otherwise: { to: "done" },
        },
      },
      done: { kind: "succeed" },
    },
  };
  const { nodes, edges } = translateDocumentToGraph(LOOPING);
  const route = (source: string, target: string) =>
    edges.find((edge) => edge.source === source && edge.target === target)
      ?.data?.route;

  test("routes self loops and back edges as loops on the side handles", () => {
    expect(route("propose", "propose")?.kind).toBe("loop");
    expect(route("review", "propose")?.kind).toBe("loop");
    const back = edges.find((edge) => edge.source === "review" && edge.target === "propose");
    expect([back?.sourceHandle, back?.targetHandle]).toEqual(["loop-out", "loop-in"]);
  });

  test("keeps forward edges flowing down with their own label slot", () => {
    const forward = route("propose", "review");
    expect(forward?.kind).toBe("flow");
    const propose = nodes.find((node) => node.id === "propose");
    const review = nodes.find((node) => node.id === "review");
    expect(review?.position.y).toBeGreaterThan(propose?.position.y ?? Infinity);
    if (forward?.kind !== "flow") throw new Error("expected a flow route");
    expect(forward.label).not.toBeNull();
  });

  test("nests the shorter loop inside the longer one, both clear of the nodes", () => {
    const self = route("propose", "propose");
    const back = route("review", "propose");
    if (self?.kind !== "loop" || back?.kind !== "loop") {
      throw new Error("expected loop routes");
    }
    const rightmostNode = Math.max(
      ...nodes
        .filter((node) => node.id === "propose" || node.id === "review")
        .map((node) => node.position.x + 240),
    );
    expect(self.laneX).toBeGreaterThan(rightmostNode);
    expect(back.laneX).toBeGreaterThan(self.laneX);
  });
});

describe("translateDocumentToGraph — shape", () => {
  test("resolves a step node's input and result fields from the catalog", () => {
    const { nodes } = translateDocumentToGraph(BUG_PIPELINE, [], CATALOG);
    const triage = nodes.find((node) => node.id === "triage");
    expect(triage?.data.shape).toEqual({
      kind: "step",
      inputFields: [
        { name: "title", type: "string", required: true },
        { name: "body", type: "string", required: false },
      ],
      resultFields: [
        { name: "score", type: "number", required: false },
        { name: "files", type: "array", required: false },
      ],
      resultSchemaJson: CATALOG["triage"]?.resultSchema as Record<
        string,
        unknown
      >,
      errors: ["Triage.Unclear"],
    });
  });

  test("falls back to 'none' for unknown steps and non-step nodes", () => {
    const { nodes } = translateDocumentToGraph(BUG_PIPELINE, [], CATALOG);
    expect(nodes.find((node) => node.id === "fix")?.data.shape).toEqual({
      kind: "none",
    });
    expect(nodes.find((node) => node.id === "review")?.data.shape).toEqual({
      kind: "none",
    });
  });
});

describe("translateDocumentToGraph — issue attachment", () => {
  test("attaches an issue inside a transition to that edge", () => {
    const { edges, nodes } = translateDocumentToGraph(BUG_PIPELINE, [
      issue({ path: "/nodes/triage/next/routes/0/when/path" }),
    ]);
    const edge = edges.find((candidate) => candidate.target === "fix");
    expect(edge?.data?.issues).toHaveLength(1);
    expect(nodes.find((node) => node.id === "triage")?.data.issues).toEqual([]);
  });

  test("attaches an issue on a node's own fields to the node", () => {
    const { nodes } = translateDocumentToGraph(BUG_PIPELINE, [
      issue({ path: "/nodes/fix/step", severity: "warning" }),
    ]);
    const fix = nodes.find((node) => node.id === "fix");
    expect(fix?.data.issues.map((entry) => entry.severity)).toEqual([
      "warning",
    ]);
  });

  test("ignores issues for other pipelines and issues with no node", () => {
    const { nodes, edges } = translateDocumentToGraph(BUG_PIPELINE, [
      issue({ path: "/nodes/fix", pipelineKey: "other" }),
      issue({ path: "/timeoutSeconds" }),
      issue({ path: undefined }),
    ]);
    expect(nodes.flatMap((node) => node.data.issues)).toEqual([]);
    expect(edges.flatMap((edge) => edge.data?.issues ?? [])).toEqual([]);
  });
});

describe("nodeIdFromPath", () => {
  test("reads the node id from a node pointer, unescaping it", () => {
    expect(nodeIdFromPath("/nodes/fix/next/routes/0")).toBe("fix");
    expect(nodeIdFromPath("/nodes/a~1b")).toBe("a/b");
    expect(nodeIdFromPath("/start/to")).toBeUndefined();
    expect(nodeIdFromPath(undefined)).toBeUndefined();
  });
});

describe("translatePipelineToSnapshot", () => {
  test("carries the pipeline's key and title alongside its graph", () => {
    const snapshot = translatePipelineToSnapshot(BUG_PIPELINE);
    expect(snapshot.key).toBe("fix-bug");
    expect(snapshot.name).toBe("Fix a bug");
    expect(snapshot.nodes).toHaveLength(7);
  });
});
