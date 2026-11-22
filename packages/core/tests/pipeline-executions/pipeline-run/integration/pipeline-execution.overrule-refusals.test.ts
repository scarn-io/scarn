import { beforeAll, describe, expect } from "bun:test";
import { serialTest } from "tests/utils";
import { createOverruleHarness } from "./overrule-test-support";

describe("pipeline execution route overrule refusals", () => {
  const { harness, startRejectedRun, overrule, memberWith, createCodeStep } =
    createOverruleHarness("pipeline-run-overrule-refusals");

  beforeAll(async () => {
    await harness.setUp();
  });

  const fix = { routes: [{ kind: "route" as const, index: 0 }] };

  serialTest("overruling and previewing need executions:write", async () => {
    const { executionId, run, check } = await startRejectedRun();
    const reader = await memberWith("read");

    for (const preview of [false, true]) {
      const refused = await overrule(
        executionId,
        check.id,
        { ...fix, reason: "No permission", preview },
        reader,
      );
      expect(refused.data).toBeNull();
      expect(refused.error?.status).toBe(403);
    }
    expect(await harness.getRun(executionId)).toEqual(run);
  });

  serialTest(
    "a route the pipeline doesn't mark overridable is refused, listing it in meta.routes",
    async () => {
      const { executionId, run, check } = await startRejectedRun({
        overridable: "fix",
      });

      for (const preview of [false, true]) {
        const refused = await overrule(executionId, check.id, {
          ...fix,
          reason: "Otherwise isn't marked",
          preview,
        });
        expect(refused.error?.status).toBe(422);
        expect(refused.error?.value).toMatchObject({
          code: "PIPELINE_RUN_ROUTE_NOT_OVERRIDABLE",
          meta: { routes: [{ kind: "otherwise", index: 0 }] },
        });
      }
      expect(await harness.getRun(executionId)).toEqual(run);
    },
  );

  serialTest(
    "missing args refuse the overrule with meta.missing until the person accepts them",
    async () => {
      const { executionId, check } = await startRejectedRun({}, {});
      const missing = [{ arg: "note", reference: "result.note" }];

      const previewed = await overrule(executionId, check.id, {
        ...fix,
        reason: "Fix it anyway",
        preview: true,
      });
      expect(previewed.error?.status).toBe(422);
      expect(previewed.error?.value).toMatchObject({
        code: "PIPELINE_RUN_ROUTE_ARGS_MISSING",
        meta: { missing },
      });

      const refused = await overrule(executionId, check.id, {
        ...fix,
        reason: "Fix it anyway",
      });
      expect(refused.error?.value).toMatchObject({
        code: "PIPELINE_RUN_ROUTE_ARGS_MISSING",
        meta: { missing },
      });

      const accepted = await overrule(executionId, check.id, {
        ...fix,
        reason: "Fix it anyway",
        acceptMissing: true,
      });
      expect(accepted.error).toBeNull();
      const after = await harness.getRun(executionId);
      expect(
        after.visits.find((visit) => visit.id === check.id)?.routing,
      ).toMatchObject({ overrules: [{ missingArgs: missing }] });
      expect(harness.visitOf(after, "fix").input).toEqual({});
    },
  );

  serialTest(
    "accepting missing args is refused when the route leads to a code step",
    async () => {
      const { executionId, run, check } = await startRejectedRun(
        { fixStep: await createCodeStep() },
        {},
      );

      const refused = await overrule(executionId, check.id, {
        ...fix,
        reason: "Fix it anyway",
        acceptMissing: true,
      });
      expect(refused.error?.status).toBe(422);
      expect(refused.error?.value).toMatchObject({
        code: "PIPELINE_RUN_ROUTE_ARGS_MISSING",
        detail: expect.stringContaining("code step") as string,
        meta: { missing: [{ arg: "note", reference: "result.note" }] },
      });
      expect(await harness.getRun(executionId)).toEqual(run);
    },
  );

  serialTest(
    "accepting missing args is refused when the route leads to an MCP tool step",
    async () => {
      const { executionId, run, check } = await startRejectedRun(
        { fixStep: (await harness.createMcpToolStep()).key },
        {},
      );

      const refused = await overrule(executionId, check.id, {
        ...fix,
        reason: "Fix it anyway",
        acceptMissing: true,
      });
      expect(refused.error?.status).toBe(422);
      expect(refused.error?.value).toMatchObject({
        code: "PIPELINE_RUN_ROUTE_ARGS_MISSING",
        detail: expect.stringContaining("MCP tool step") as string,
        meta: { missing: [{ arg: "note", reference: "result.note" }] },
      });
      expect(await harness.getRun(executionId)).toEqual(run);
    },
  );

  serialTest(
    "a selector that matches no route or several is refused",
    async () => {
      const { executionId, check } = await startRejectedRun();

      const unknown = await overrule(executionId, check.id, {
        routes: [{ label: "Ship" }],
        reason: "No such route",
      });
      expect(unknown.error?.status).toBe(422);
      expect(unknown.error?.value).toMatchObject({
        code: "PIPELINE_RUN_UNKNOWN_ROUTE",
      });

      const ambiguous = await overrule(executionId, check.id, {
        routes: [{ to: "fix" }],
        reason: "Two routes lead there",
        preview: true,
      });
      expect(ambiguous.error?.status).toBe(422);
      expect(ambiguous.error?.value).toMatchObject({
        code: "PIPELINE_RUN_ROUTE_AMBIGUOUS",
        detail: expect.stringContaining("routes[0], routes[1]") as string,
        meta: {
          routes: [
            { kind: "route", index: 0 },
            { kind: "route", index: 1 },
          ],
        },
      });
    },
  );

  serialTest("the route already taken is refused as unchanged", async () => {
    const { executionId, check } = await startRejectedRun();

    const unchanged = await overrule(executionId, check.id, {
      routes: [{ kind: "otherwise" }],
      reason: "Same again",
    });
    expect(unchanged.error?.status).toBe(422);
    expect(unchanged.error?.value).toMatchObject({
      code: "PIPELINE_RUN_ROUTE_UNCHANGED",
    });
  });

  serialTest("a blank reason is rejected", async () => {
    const { executionId, check } = await startRejectedRun();

    const blank = await overrule(executionId, check.id, {
      ...fix,
      reason: "   ",
    });
    expect(blank.data).toBeNull();
    expect([400, 422]).toContain(blank.error?.status ?? 0);
  });
});
