import { describe, expect, test } from "bun:test";
import {
  listPinnedStepDefinitionIds,
  readActivePipelineVersion,
  resolveStartStepDefinitionId,
} from "../../../../src/work/task-run/application/pipeline-version-steps";
import { ConfigurationError } from "../../../../src/lib/errors";

/**
 * The dry runs resolve a pipeline id to step definitions through its active
 * version: the start node for `work --dry-run --pipeline-id`, every step node
 * for the run-offer health gate.
 */

const pipeline = (currentVersion: object | null) => ({
  id: "pipeline-1",
  key: "bug",
  currentVersion,
});

const version = {
  definition: {
    schemaVersion: 1,
    key: "bug",
    start: { to: "triage" },
    nodes: {
      fix: { kind: "step", step: "fix" },
      triage: { kind: "step", step: "triage" },
      approve: {
        kind: "wait",
        for: "decision",
        actions: [{ key: "approve", label: "Approve", body: "optional" }],
      },
      retriage: { kind: "step", step: "triage" },
      done: { kind: "succeed" },
    },
  },
  steps: [
    { stepKey: "triage", stepDefinitionId: "step-triage" },
    { stepKey: "fix", stepDefinitionId: "step-fix" },
  ],
};

describe("readActivePipelineVersion", () => {
  test("throws for a missing pipeline", () => {
    expect(() => readActivePipelineVersion("pipeline-1", undefined)).toThrow(
      ConfigurationError,
    );
  });

  test("throws for a pipeline with no published version", () => {
    expect(() =>
      readActivePipelineVersion("pipeline-1", pipeline(null)),
    ).toThrow("has no published version");
  });
});

describe("resolveStartStepDefinitionId", () => {
  test("picks the step at the start node, not the first listed", () => {
    const active = readActivePipelineVersion("pipeline-1", pipeline(version));

    expect(resolveStartStepDefinitionId("pipeline-1", active)).toBe(
      "step-triage",
    );
  });

  test("throws when the pipeline starts at a non-step node", () => {
    const active = readActivePipelineVersion(
      "pipeline-1",
      pipeline({
        ...version,
        definition: { ...version.definition, start: { to: "approve" } },
      }),
    );

    expect(() => resolveStartStepDefinitionId("pipeline-1", active)).toThrow(
      ConfigurationError,
    );
  });
});

describe("listPinnedStepDefinitionIds", () => {
  test("lists step nodes' definitions once each, in document order", () => {
    const active = readActivePipelineVersion("pipeline-1", pipeline(version));

    expect(listPinnedStepDefinitionIds(active)).toEqual([
      "step-fix",
      "step-triage",
    ]);
  });
});
