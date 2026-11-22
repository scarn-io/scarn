import { beforeAll, describe, expect } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { serialTest } from "tests/utils";
import { createQuestionHarness } from "./question-test-support";

describe("pipeline execution decision commands", () => {
  const { harness, headers, startWaitingRun, memberWith } =
    createQuestionHarness("pipeline-run-decision-commands");

  beforeAll(async () => {
    await harness.setUp();
  });

  const decisionDocument = (): PipelineDocument => {
    const { stepKey } = harness.requireSetup();
    return {
      schemaVersion: 1,
      key: harness.uniqueKey("decision"),
      start: { to: "draft" },
      nodes: {
        draft: {
          kind: "step",
          step: stepKey,
          next: { routes: [{ to: "review" }] },
        },
        review: {
          kind: "wait",
          for: "decision",
          actions: [
            { key: "approve", label: "Approve" },
            { key: "revise", label: "Request changes", body: "required" },
            { key: "reject", label: "Reject", body: "optional" },
          ],
          next: {
            routes: [
              {
                when: { path: "result.action", op: "equal", value: "approve" },
                to: "publish",
              },
              {
                when: { path: "result.action", op: "equal", value: "revise" },
                to: "draft",
              },
            ],
            otherwise: { to: "rejected" },
          },
        },
        publish: {
          kind: "step",
          step: stepKey,
          next: { routes: [{ to: "done" }] },
        },
        done: { kind: "succeed" },
        rejected: { kind: "fail", error: "DraftRejected" },
      },
    };
  };

  /** Starts a run and completes `draft`, so it parks on `review`. */
  const startDecisionRun = async () => {
    const { executionId, workItemId } =
      await harness.startRun(decisionDocument());
    await harness.complete(await harness.claimOne(workItemId), "succeeded");
    const review = harness.visitOf(await harness.getRun(executionId), "review");
    return { executionId, workItemId, review };
  };

  const decide = (
    executionId: UuidV7,
    visitId: UuidV7,
    body: { action: string; body?: string | null },
    authHeaders = headers(),
  ) =>
    harness
      .visitRoutes(executionId, visitId)
      .decision.post(body, { headers: authHeaders });

  serialTest(
    "a decision wait parks the run with its actions",
    async () => {
      const { executionId, workItemId, review } = await startDecisionRun();

      expect(await harness.getRun(executionId)).toMatchObject({
        runStatus: "waiting",
        status: "waiting",
        waitingFor: "decision",
      });
      expect(review).toMatchObject({
        nodeKind: "wait",
        status: "waiting",
        waitFor: "decision",
      });
      expect(review.actions).toEqual([
        { key: "approve", label: "Approve", body: "optional" },
        { key: "revise", label: "Request changes", body: "required" },
        { key: "reject", label: "Reject", body: "optional" },
      ]);
      expect(
        harness.visitOf(await harness.getRun(executionId), "draft").actions,
      ).toBeNull();
      expect(await harness.claim(workItemId)).toHaveLength(0);
    },
    30_000,
  );

  serialTest(
    "approving with a body continues the run and stores the decision",
    async () => {
      const { executionId, workItemId, review } = await startDecisionRun();

      const decided = await decide(executionId, review.id, {
        action: "approve",
        body: "  Ship it ",
      });

      expect(decided.error).toBeNull();
      expect(decided.data).toMatchObject({
        runStatus: "active",
        waitingFor: null,
      });
      const resolved = harness.visitOf(
        await harness.getRun(executionId),
        "review",
      );
      expect(resolved).toMatchObject({
        status: "succeeded",
        result: { action: "approve", body: "Ship it" },
        resolvedByUserId: harness.requireSetup().userId,
      });

      await harness.complete(await harness.claimOne(workItemId), "succeeded");
      expect(await harness.getRun(executionId)).toMatchObject({
        runStatus: "succeeded",
        endNodeId: "done",
      });
    },
    30_000,
  );

  serialTest(
    "a blank body is stored as null",
    async () => {
      const { executionId, review } = await startDecisionRun();

      const decided = await decide(executionId, review.id, {
        action: "approve",
        body: "   ",
      });

      expect(decided.error).toBeNull();
      expect(
        harness.visitOf(await harness.getRun(executionId), "review").result,
      ).toEqual({ action: "approve", body: null });
    },
    30_000,
  );

  serialTest(
    "an action that needs a body is rejected without one",
    async () => {
      const { executionId, review } = await startDecisionRun();

      for (const body of [{}, { body: "  " }]) {
        const decided = await decide(executionId, review.id, {
          action: "revise",
          ...body,
        });
        expect(decided.data).toBeNull();
        expect(decided.error?.status).toBe(422);
        expect(decided.error?.value).toMatchObject({
          code: "PIPELINE_RUN_DECISION_INVALID",
        });
      }
      expect(
        harness.visitOf(await harness.getRun(executionId), "review").status,
      ).toBe("waiting");
    },
    30_000,
  );

  serialTest(
    "an unknown action is rejected",
    async () => {
      const { executionId, review } = await startDecisionRun();

      const decided = await decide(executionId, review.id, {
        action: "aprove",
      });

      expect(decided.data).toBeNull();
      expect(decided.error?.status).toBe(422);
      expect(decided.error?.value).toMatchObject({
        code: "PIPELINE_RUN_DECISION_INVALID",
      });
      expect((await harness.getRun(executionId)).runStatus).toBe("waiting");
    },
    30_000,
  );

  serialTest(
    "a reply wait can't be decided",
    async () => {
      const { executionId } = await startWaitingRun();
      const ask = harness.visitOf(
        await harness.getRun(executionId),
        "ask-for-details",
      );

      const decided = await decide(executionId, ask.id, { action: "approve" });

      expect(decided.data).toBeNull();
      expect(decided.error?.status).toBe(422);
      expect(decided.error?.value).toMatchObject({
        code: "PIPELINE_RUN_VISIT_NOT_WAITING",
      });
      expect(await harness.getRun(executionId)).toMatchObject({
        runStatus: "waiting",
        waitingFor: "reply",
      });
    },
    30_000,
  );

  serialTest(
    "deciding needs executions:write",
    async () => {
      const { executionId, review } = await startDecisionRun();
      const reader = await memberWith("read");

      const decided = await decide(
        executionId,
        review.id,
        { action: "approve" },
        reader,
      );

      expect(decided.data).toBeNull();
      expect(decided.error?.status).toBe(403);
      expect(
        harness.visitOf(await harness.getRun(executionId), "review").status,
      ).toBe("waiting");
    },
    30_000,
  );
});
