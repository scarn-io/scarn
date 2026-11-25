import { describe, expect } from "bun:test";
import {
  CURRENT_LANE_SCHEMA_VERSION,
  CURRENT_NODE_VISIT_SCHEMA_VERSION,
  readStoredLane,
  readStoredNodeVisit,
  readStoredPipelineRunError,
} from "@/pipeline-executions/pipeline-run/contracts/pipeline-run-state-stored";
import { concurrentTest } from "tests/utils";
import v1Lane from "../fixtures/v1-lane.json";
import v1NodeVisit from "../fixtures/v1-node-visit.json";
import runError from "../fixtures/pipeline-run-error.json";

describe("pipeline-run state stored readers", () => {
  concurrentTest("the fixtures are at the current versions", () => {
    expect(v1Lane.schemaVersion).toBe(CURRENT_LANE_SCHEMA_VERSION);
    expect(v1NodeVisit.schemaVersion).toBe(CURRENT_NODE_VISIT_SCHEMA_VERSION);
  });

  concurrentTest("reads a v1 lane", () => {
    expect(readStoredLane(1, v1Lane) as unknown).toEqual({
      success: true,
      value: {
        item: v1Lane.itemJson,
        route: v1Lane.routeJson,
        arrivalArgs: v1Lane.arrivalArgsJson,
        arrivalTransition: v1Lane.arrivalTransitionJson,
      },
    });
  });

  concurrentTest("reads a v1 visit, keeping every routing key", () => {
    expect(readStoredNodeVisit(1, v1NodeVisit) as unknown).toEqual({
      success: true,
      value: {
        transition: v1NodeVisit.transitionJson,
        routing: v1NodeVisit.routingJson,
        input: v1NodeVisit.inputJson,
        result: v1NodeVisit.resultJson,
        error: v1NodeVisit.errorJson,
      },
    });
  });

  concurrentTest(
    "reads a transition and a note whose kinds it doesn't know",
    () => {
      const read = readStoredNodeVisit(1, {
        ...v1NodeVisit,
        transitionJson: { kind: "retired_kind", index: 2 },
        routingJson: {
          taken: [{ kind: "retired_kind", index: 0 }],
          notes: [{ kind: "retired_note", detail: 1 }],
        },
      });
      expect(read.success).toBe(true);
      expect(read.success && (read.value.transition.kind as string)).toBe(
        "retired_kind",
      );
    },
  );

  concurrentTest(
    "fills missingArgs on an overrule written without them",
    () => {
      const [overrule] = v1NodeVisit.routingJson.overrules;
      const read = readStoredNodeVisit(1, {
        ...v1NodeVisit,
        routingJson: {
          overrules: [{ ...overrule, missingArgs: undefined }],
        },
      });
      expect(
        read.success && read.value.routing?.overrules?.[0]?.missingArgs,
      ).toEqual([]);
    },
  );

  concurrentTest("reads the nullable columns as null", () => {
    expect(
      readStoredLane(1, {
        itemJson: null,
        routeJson: { kind: "merge", index: 0 },
        arrivalArgsJson: null,
        arrivalTransitionJson: null,
      }).success,
    ).toBe(true);
    expect(
      readStoredNodeVisit(1, {
        ...v1NodeVisit,
        routingJson: null,
        resultJson: null,
        errorJson: null,
      }).success,
    ).toBe(true);
  });

  concurrentTest("a transition without an index is unreadable", () => {
    expect(
      readStoredLane(1, { ...v1Lane, routeJson: { kind: "route" } }).success,
    ).toBe(false);
    expect(
      readStoredNodeVisit(1, { ...v1NodeVisit, transitionJson: {} }).success,
    ).toBe(false);
  });

  concurrentTest("a visit error without a message is unreadable", () => {
    expect(
      readStoredNodeVisit(1, { ...v1NodeVisit, errorJson: { name: "X" } })
        .success,
    ).toBe(false);
  });

  concurrentTest("an unknown schema_version is unreadable", () => {
    expect(readStoredLane(99, v1Lane)).toEqual({
      success: false,
      reason: "unknown schema_version 99 (current is 1)",
    });
    expect(readStoredNodeVisit(99, v1NodeVisit).success).toBe(false);
  });

  concurrentTest("reads a run error, keeping its other keys", () => {
    expect(readStoredPipelineRunError(runError.errorJson)).toEqual({
      success: true,
      value: runError.errorJson,
    });
    expect(readStoredPipelineRunError(null)).toEqual({
      success: true,
      value: null,
    });
    expect(readStoredPipelineRunError({ name: "X" }).success).toBe(false);
  });
});
