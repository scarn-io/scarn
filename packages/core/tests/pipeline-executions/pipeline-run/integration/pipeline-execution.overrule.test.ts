import { beforeAll, describe, expect } from "bun:test";
import { serialTest } from "tests/utils";
import { createOverruleHarness } from "./overrule-test-support";

describe("pipeline execution route overrules", () => {
  const { analytics, harness, forkDocument, startRejectedRun, overrule } =
    createOverruleHarness("pipeline-run-overrule");

  beforeAll(async () => {
    await harness.setUp();
  });

  serialTest(
    "overruling a failed run onto another route supersedes what came after and queues the new route's Task",
    async () => {
      const { executionId, workItemId, run, check } = await startRejectedRun();
      expect(run).toMatchObject({ runStatus: "failed", endNodeId: "rejected" });
      const rejected = harness.visitOf(run, "rejected");

      const overruled = await overrule(executionId, check.id, {
        routes: [{ label: "Fix" }],
        reason: "The check misread the logs",
      });
      expect(overruled.error).toBeNull();
      expect(overruled.data).toMatchObject({
        runStatus: "active",
        endNodeId: null,
        error: null,
        completedAt: null,
      });

      const reopened = await harness.getRun(executionId);
      const checkAfter = reopened.visits.find((visit) => visit.id === check.id);
      expect(checkAfter).toMatchObject({
        status: "succeeded",
        result: check.result,
        routing: {
          taken: [{ kind: "route", index: 0 }],
          overrules: [
            {
              from: [{ kind: "otherwise", index: 0 }],
              to: [{ kind: "route", index: 0 }],
              byUserId: harness.requireSetup().userId,
              reason: "The check misread the logs",
              missingArgs: [],
            },
          ],
        },
      });
      expect(
        reopened.visits.find((visit) => visit.id === rejected.id)?.status,
      ).toBe("superseded");
      const fix = harness.visitOf(reopened, "fix");
      expect(fix).toMatchObject({
        status: "active",
        fromVisitId: check.id,
        transition: { kind: "route", index: 0 },
        input: { note: "Retry the import" },
      });

      const claimed = await harness.claimOne(workItemId);
      expect(fix.tasks.map((task) => task.taskId)).toEqual([claimed.taskId]);
      await harness.complete(claimed, "succeeded");
      expect(await harness.getRun(executionId)).toMatchObject({
        runStatus: "succeeded",
        endNodeId: "done",
      });

      expect(
        analytics.calls.filter(
          (call) =>
            call.event === "pipeline_route_overruled" &&
            call.properties.pipeline_run_id === executionId,
        ),
      ).toEqual([
        {
          distinctId: harness.requireSetup().userId,
          event: "pipeline_route_overruled",
          properties: {
            project_id: harness.requireSetup().projectId,
            pipeline_run_id: executionId,
            node_id: "check",
            match: "first",
            from: ["otherwise"],
            to: ["route:0"],
            accepted_missing: false,
          },
        },
      ]);
    },
  );

  serialTest(
    "a preview writes nothing and matches what the overrule then does",
    async () => {
      const { executionId, run, check } = await startRejectedRun();
      const rejected = harness.visitOf(run, "rejected");
      const recorded = analytics.calls.length;

      const previewed = await overrule(executionId, check.id, {
        routes: [{ kind: "route", index: 0 }],
        reason: "Preview first",
        preview: true,
      });
      expect(previewed.error).toBeNull();
      expect(previewed.data).toEqual({
        preview: {
          superseded: [
            { visitId: rejected.id, nodeId: "rejected", status: "failed" },
          ],
          cancelledTasks: 0,
          lanesAdded: [],
          lanesRemoved: [],
          mergesRerun: [],
          started: ["fix"],
          reopensRun: true,
          missing: [],
        },
      });
      expect(await harness.getRun(executionId)).toEqual(run);
      expect(analytics.calls).toHaveLength(recorded);

      await overrule(executionId, check.id, {
        routes: [{ kind: "route", index: 0 }],
        reason: "Preview first",
      });
      const after = await harness.getRun(executionId);
      expect(
        after.visits
          .filter((visit) => visit.status === "superseded")
          .map((visit) => visit.id),
      ).toEqual([rejected.id]);
      expect(
        after.visits
          .filter(
            (visit) => !run.visits.some((before) => before.id === visit.id),
          )
          .map((visit) => visit.nodeId),
      ).toEqual(["fix"]);
      expect(after.runStatus).toBe("active");
    },
  );

  serialTest(
    'overruling a match: "all" node onto another route adds a lane to its group',
    async () => {
      const { executionId, workItemId } =
        await harness.startRun(forkDocument());
      await harness.complete(await harness.claimOne(workItemId), "succeeded", {
        left: true,
        right: false,
      });
      const before = await harness.getRun(executionId);
      const pick = harness.visitOf(before, "pick");
      const [group] = before.laneGroups;
      if (!group) {
        throw new Error("Expected pick to spawn a lane group");
      }
      expect(group).toMatchObject({ kind: "all", laneCount: 1 });

      const request = {
        routes: [{ kind: "route" as const, index: 0 }, { to: "right" }],
        reason: "Both sides need the change",
      };
      const previewed = await overrule(executionId, pick.id, {
        ...request,
        preview: true,
      });
      expect(previewed.error).toBeNull();
      expect(previewed.data).toEqual({
        preview: {
          superseded: [],
          cancelledTasks: 0,
          lanesAdded: [{ route: { kind: "route", index: 1 } }],
          lanesRemoved: [],
          mergesRerun: [],
          started: ["right"],
          reopensRun: false,
          missing: [],
        },
      });

      const overruled = await overrule(executionId, pick.id, request);
      expect(overruled.error).toBeNull();

      const after = await harness.getRun(executionId);
      expect(after.laneGroups).toEqual([{ ...group, laneCount: 2 }]);
      const lanes = after.lanes.filter((lane) => lane.laneGroupId === group.id);
      expect(lanes.map((lane) => lane.route)).toEqual([
        { kind: "route", index: 0 },
        { kind: "route", index: 1 },
      ]);
      expect(lanes[1]).toMatchObject({ origin: "split", status: "active" });
      expect(harness.visitOf(after, "left").status).toBe("active");
      expect(harness.visitOf(after, "right")).toMatchObject({
        status: "active",
        laneId: lanes[1]?.id,
      });
    },
  );
});
