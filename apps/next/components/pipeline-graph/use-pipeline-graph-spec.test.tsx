import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  parseUuidV7,
  type PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import {
  __resetPipelineGraphSpecCacheForTests,
  usePipelineGraphSpec,
} from "./use-pipeline-graph-spec";
import { installDom } from "@/tests/support/install-dom";

const VERSION_ID = "019e9a92-b432-73e8-9341-3519156fa701";

const buildVersion = (id: string): PipelineVersionContract => ({
  id: parseUuidV7(id),
  pipelineDefinitionId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa703"),
  version: 1,
  schemaVersion: 1,
  contentHash: "hash",
  definition: {
    schemaVersion: 1,
    key: "quality-gate-pipeline",
    start: { to: "review" },
    nodes: {
      review: {
        kind: "step",
        step: "review",
        next: {
          routes: [{ to: "approve" }],
        },
      },
      approve: {
        kind: "wait",
        for: "decision",
        actions: [
          { key: "approve", label: "Approve", body: "optional" },
          { key: "reject", label: "Reject", body: "optional" },
        ],
        next: {
          routes: [{ to: "done" }],
        },
      },
      done: { kind: "succeed" },
    },
  },
  steps: [],
  createdAt: "2026-01-01T00:00:00.000Z",
});

function Probe({
  version,
  failed = false,
}: {
  version: PipelineVersionContract | null;
  failed?: boolean;
}) {
  const { nodes, edges, loading, error } = usePipelineGraphSpec(
    version,
    failed,
  );
  return (
    <div data-testid="probe">
      {loading
        ? "loading"
        : `nodes:${String(nodes.length)}:edges:${String(edges.length)}`}
      {error ? `:error:${error}` : ""}
    </div>
  );
}

describe("usePipelineGraphSpec", () => {
  beforeEach(() => {
    __resetPipelineGraphSpecCacheForTests();
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("translates the version's document, including the synthetic start node", () => {
    const view = render(<Probe version={buildVersion(VERSION_ID)} />);
    expect(view.getByTestId("probe").textContent).toBe("nodes:4:edges:3");
  });

  test("reports loading until a version arrives, and an error when it failed", () => {
    const loading = render(<Probe version={null} />);
    expect(loading.getByTestId("probe").textContent).toBe("loading");
    loading.unmount();

    const failed = render(<Probe version={null} failed />);
    expect(failed.getByTestId("probe").textContent).toContain(":error:");
  });
});
