import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { JsonValue } from "@scarn/sdk/contracts/pipeline-document";
import {
  NodeVisitEntity,
  type NodeVisitRowProps,
} from "@/pipeline-executions/pipeline-run/domain/node-visit-entity";

function waitRow(result: JsonValue | null): NodeVisitRowProps {
  return {
    id: createUuidV7(),
    pipelineRunId: createUuidV7(),
    nodeId: "review-fix",
    nodeKind: "wait",
    laneId: null,
    fromVisitId: null,
    fromLaneGroupId: null,
    transition: { kind: "route", index: 0 },
    routing: null,
    status: result === null ? "waiting" : "succeeded",
    input: { plan: { summary: "p" } },
    taskId: null,
    resultTaskId: null,
    result,
    error: null,
    createdByUserId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date("2026-10-24T00:00:00Z"),
    completedAt: null,
    conversationId: null,
  };
}

describe("NodeVisitEntity: wait results", () => {
  test.concurrent("a decision result round-trips", () => {
    const result = { action: "revise", body: "Handle the empty cart" };
    const visit = NodeVisitEntity.rehydrate(waitRow(result));
    expect(visit.toRow().result).toEqual(result);
    expect(visit.toEngineVisit().result).toEqual(result);
  });

  test.concurrent("a decision without a body keeps body null", () => {
    const visit = NodeVisitEntity.rehydrate(waitRow(null)).withPatch({
      status: "succeeded",
      result: { action: "approve", body: null },
    });
    expect(visit.toRow().result).toEqual({ action: "approve", body: null });
  });

  test.concurrent("a reply result round-trips", () => {
    const reply = { replied: true, body: "Chrome", commentId: "c" };
    expect(NodeVisitEntity.rehydrate(waitRow(reply)).toRow().result).toEqual(
      reply,
    );
  });

  test.concurrent("an approval result is rejected", () => {
    expect(() =>
      NodeVisitEntity.rehydrate(waitRow({ approved: true, comment: null })),
    ).toThrow("{ action, body } or { replied, body, commentId }");
  });

  test.concurrent("an unrecognised result names every accepted shape", () => {
    expect(() => NodeVisitEntity.rehydrate(waitRow({ verdict: "ok" }))).toThrow(
      "{ action, body } or { replied, body, commentId }",
    );
  });
});
