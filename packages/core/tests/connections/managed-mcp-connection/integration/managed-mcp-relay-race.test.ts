/**
 * Relayed calls racing the moves of authority (decisions 9, 10, 12, 14, 15):
 * a call is either served by the authority it was admitted under or refused
 * with the loss, never half-applied; a real in-flight call or a pending
 * refresh holds the seal back; and heartbeats, relay calls, registration,
 * seals and a disconnect interleave without a deadlock or a stall.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { FAKE_MCP_SLOW_TOOL } from "tests/connections/support/fake-mcp-server";
import { unwrapAsync } from "tests/utils";
import {
  authorityLost,
  createSealTestClient,
  type SealProject,
  type SealRun,
} from "./managed-authority-seal-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import { createRelayTestClient, rpc } from "./managed-mcp-relay-test-support";

const HOUR_MS = 60 * 60 * 1000;
const TOOL = "notion-tool-0-0";
const RACE_ITERATIONS = 10;
const RACE_STAGGER_STEPS = 10;
const CALLS_PER_RUN = 4;
/** Postgres reports a deadlock after `deadlock_timeout` (1 s); a stall past this is a hang. */
const NO_PROGRESS_MS = 20_000;

type Outcome = { status: number; code: string | null; reason: string | null };

const served: Outcome = { status: 200, code: null, reason: null };

const outcomeOf = async (response: Response): Promise<Outcome> => {
  const body = await response.text();
  if (response.status === 200) {
    return served;
  }
  const parsed = JSON.parse(body) as {
    code?: string;
    meta?: { reason?: string };
  };
  return {
    status: response.status,
    code: parsed.code ?? null,
    reason: parsed.meta?.reason ?? null,
  };
};

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(5);
  }
};

const withinDeadline = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no progress within ${String(NO_PROGRESS_MS)} ms`));
        }, NO_PROGRESS_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe("managed relay races", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, appContext, apiClient, logs } = harness;
  const seal = createSealTestClient(harness);
  const { relay } = createRelayTestClient(harness);

  afterEach(async () => {
    await harness.settleBackgroundTasks();
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const callTool = (run: SealRun, id: number, name = TOOL) =>
    relay(run, { body: rpc(id, "tools/call", { name, arguments: {} }) });

  const callsOn = (runs: SealRun[]) =>
    runs.flatMap((run) =>
      Array.from({ length: CALLS_PER_RUN }, (_, index) =>
        Bun.sleep(index)
          .then(() => callTool(run, index + 1))
          .then(outcomeOf),
      ),
    );

  const runOf = async (target: SealProject, run: SealRun) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).get({
        headers: target.owner.authHeaders,
      }),
    );

  const openOperations = (taskRunId: UuidV7) =>
    appContext.managedLaunchRepo.listOperations(taskRunId, getDb());

  /** Every call is served or refused with `reason`; only served calls reached Notion. */
  const expectServedOrLost = (outcomes: Outcome[], reason: string) => {
    for (const outcome of outcomes) {
      if (outcome.status !== 200) {
        expect(outcome).toMatchObject({ status: 409 });
        expect([
          "MANAGED_CONNECTION_AUTHORITY_LOST",
          "MANAGED_CONNECTION_NOT_READY",
        ]).toContain(outcome.code ?? "");
        if (outcome.code === "MANAGED_CONNECTION_AUTHORITY_LOST") {
          expect(outcome.reason).toBe(reason);
        }
      }
    }
    expect(fake.mcp.effectCount(TOOL)).toBe(
      outcomes.filter((outcome) => outcome.status === 200).length,
    );
  };

  /** After the race: no operation is left, a new call is refused, and the seal fails the run. */
  const expectSealedAsLost = async (
    target: SealProject,
    runs: SealRun[],
    reason: string,
  ) => {
    await harness.settleBackgroundTasks();
    for (const run of runs) {
      expect(await openOperations(run.taskRunId)).toEqual([]);
      expect(await outcomeOf(await callTool(run, 99))).toEqual({
        status: 409,
        code: "MANAGED_CONNECTION_AUTHORITY_LOST",
        reason,
      });
      const completed = await unwrapAsync(seal.complete(target, run));
      expect(completed).toMatchObject({
        status: "failed",
        errorJson: authorityLost(reason),
      });
      expect(await seal.commentsOn(run.workItemId)).toEqual([]);
    }
  };

  test(`relay calls racing a disconnect are served or refused with the loss, ${String(RACE_ITERATIONS)} times`, async () => {
    const target = await seal.project("relay-race-disconnect");
    let servedCalls = 0;
    let refusedCalls = 0;
    for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
      if (iteration > 0) {
        await seal.reconnectFromDisconnected(target);
      }
      const runs = [await seal.launchRun(target), await seal.launchRun(target)];
      fake.mcp.effects.clear();

      const [outcomes] = await Promise.all([
        Promise.all(callsOn(runs)),
        Bun.sleep(iteration % RACE_STAGGER_STEPS).then(() =>
          seal.disconnect(target),
        ),
      ]);

      expectServedOrLost(outcomes, "disconnected");
      servedCalls += fake.mcp.effectCount(TOOL);
      refusedCalls += outcomes.length - fake.mcp.effectCount(TOOL);
      await expectSealedAsLost(target, runs, "disconnected");
    }
    expect(servedCalls + refusedCalls).toBe(
      RACE_ITERATIONS * 2 * CALLS_PER_RUN,
    );
  }, 120_000);

  test("relay calls racing a confirmed reconnect are served or refused as replaced", async () => {
    const target = await seal.project("relay-race-confirm");
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const runs = [await seal.launchRun(target), await seal.launchRun(target)];
      const { pending, candidate } = await harness.reconnectToCandidate(
        target.owner,
        target.projectId,
        target.connectionId,
      );
      fake.mcp.effects.clear();

      const [outcomes] = await Promise.all([
        Promise.all(callsOn(runs)),
        Bun.sleep(iteration * 2).then(() =>
          unwrapAsync(
            harness
              .connections(target.projectId)({
                connectionId: target.connectionId,
              })
              .candidate.confirm.post(
                {
                  candidateId: candidate.id,
                  fingerprint: candidate.fingerprint,
                  expectedVersion: pending.version,
                },
                {
                  headers: {
                    ...target.owner.authHeaders,
                    origin: harness.origin,
                  },
                },
              ),
          ),
        ),
      ]);

      expectServedOrLost(outcomes, "replaced");
      expect(
        outcomes.filter(
          (outcome) => outcome.code === "MANAGED_CONNECTION_NOT_READY",
        ),
      ).toEqual([]);
      await expectSealedAsLost(target, runs, "replaced");
    }
  }, 120_000);

  test("relay calls racing a failed refresh: one refresh, nothing reaches Notion, the runs fail reconnect_required", async () => {
    const target = await seal.project("relay-race-reconnect-required");
    clock.advance(HOUR_MS);
    const runs = [await seal.launchRun(target), await seal.launchRun(target)];
    fake.faults.refresh = "invalid_grant";
    const refreshesBefore = fake.refreshCount;

    const outcomes = await Promise.all(callsOn(runs));

    expect(fake.refreshCount - refreshesBefore).toBe(1);
    expect(outcomes.filter((outcome) => outcome.status === 200)).toEqual([]);
    expectServedOrLost(outcomes, "reconnect_required");
    expect(fake.mcp.callsTo("tools/call")).toEqual([]);
    fake.faults = {};
    await expectSealedAsLost(target, runs, "reconnect_required");
  });

  test("a real relayed call in flight holds the seal back with 409, and the run seals once it ends", async () => {
    const target = await seal.project("relay-race-in-flight");
    const run = await seal.launchRun(target);
    fake.mcp.slowToolMs = 500;

    const pending = callTool(run, 1, FAKE_MCP_SLOW_TOOL);
    await waitFor(() => fake.mcp.effectCount(FAKE_MCP_SLOW_TOOL) === 1);
    const blocked = await seal.complete(target, run);

    expect(blocked.error?.status).toBe(409);
    expect(blocked.error?.value).toMatchObject({
      code: "MANAGED_OPERATION_IN_FLIGHT",
    });
    expect((await runOf(target, run)).status).toBe("running");
    expect(await outcomeOf(await pending)).toEqual(served);
    await harness.settleBackgroundTasks();
    expect(await openOperations(run.taskRunId)).toEqual([]);
    expect((await unwrapAsync(seal.complete(target, run))).status).toBe(
      "succeeded",
    );
    expect(await seal.commentsOn(run.workItemId)).toEqual([
      { body: "From the run" },
    ]);
  });

  test("a disconnect mid-call: new calls are refused and the seal fails the run without waiting for the open call", async () => {
    const target = await seal.project("relay-race-mid-call");
    const run = await seal.launchRun(target);
    fake.mcp.slowToolMs = 500;

    const pending = callTool(run, 1, FAKE_MCP_SLOW_TOOL);
    await waitFor(() => fake.mcp.effectCount(FAKE_MCP_SLOW_TOOL) === 1);
    await seal.disconnect(target);

    expect(await outcomeOf(await callTool(run, 2))).toEqual({
      status: 409,
      code: "MANAGED_CONNECTION_AUTHORITY_LOST",
      reason: "disconnected",
    });
    const completed = await unwrapAsync(seal.complete(target, run));
    expect(completed).toMatchObject({
      status: "failed",
      errorJson: authorityLost("disconnected"),
    });
    expect(await seal.commentsOn(run.workItemId)).toEqual([]);
    expect(await outcomeOf(await pending)).toEqual(served);
    expect(fake.mcp.effectCount(TOOL)).toBe(0);
    await harness.settleBackgroundTasks();
    expect(await openOperations(run.taskRunId)).toEqual([]);
  });

  test("a refresh a relayed call started blocks every referencing seal, and a concurrent call waits it out", async () => {
    const target = await seal.project("relay-race-refresh-pending");
    clock.advance(HOUR_MS);
    const caller = await seal.launchRun(target);
    const bystander = await seal.launchRun(target);
    const provider = harness.fakeProvider();
    const refresh = provider.refresh.bind(provider);
    const gate = Promise.withResolvers<undefined>();
    const claimed = Promise.withResolvers<undefined>();
    const spy = spyOn(provider, "refresh").mockImplementation(async (input) => {
      claimed.resolve(undefined);
      await gate.promise;
      return await refresh(input);
    });
    const refreshesBefore = fake.refreshCount;

    try {
      const first = callTool(caller, 1);
      await claimed.promise;

      const callerSeal = await seal.complete(target, caller);
      const bystanderSeal = await seal.complete(target, bystander);
      expect(callerSeal.error?.value).toMatchObject({
        code: "MANAGED_OPERATION_IN_FLIGHT",
      });
      expect(bystanderSeal.error?.status).toBe(409);
      expect(bystanderSeal.error?.value).toMatchObject({
        code: "MANAGED_CONNECTION_REFRESH_PENDING",
      });

      const second = callTool(bystander, 1);
      await Bun.sleep(50);
      gate.resolve(undefined);

      expect(await outcomeOf(await first)).toEqual(served);
      expect(await outcomeOf(await second)).toEqual(served);
    } finally {
      gate.resolve(undefined);
      spy.mockRestore();
    }
    expect(fake.refreshCount - refreshesBefore).toBe(1);
    expect(fake.mcp.effectCount(TOOL)).toBe(2);
    await harness.settleBackgroundTasks();
    for (const run of [caller, bystander]) {
      expect((await unwrapAsync(seal.complete(target, run))).status).toBe(
        "succeeded",
      );
    }
  });

  test("heartbeats, relay calls, registration, seals and a disconnect interleave without deadlock (run, then connection)", async () => {
    const target = await seal.project("relay-race-lock-order");
    const logsBefore = logs.length;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      if (iteration > 0) {
        await seal.reconnectFromDisconnected(target);
      }
      const relayed = [
        await seal.launchRun(target),
        await seal.launchRun(target),
      ];
      const registered = await seal.launchRun(target);
      const rest = [...relayed, registered];
      const stagger = (ms: number) => Bun.sleep(ms % 7);
      const heartbeat = (run: SealRun) =>
        apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).heartbeat.put(
          { claimToken: run.claimToken, leaseDurationSeconds: 60 },
          { headers: target.owner.authHeaders },
        );

      const statusOf = (result: { error: { status: unknown } | null }) =>
        Number(result.error?.status ?? 200);

      const statuses = await withinDeadline(
        Promise.all([
          ...relayed.flatMap((run, index) => [
            stagger(index)
              .then(() => callTool(run, 1))
              .then(outcomeOf)
              .then((outcome) => outcome.status),
            stagger(index + 3)
              .then(() => callTool(run, 2))
              .then(outcomeOf)
              .then((outcome) => outcome.status),
          ]),
          ...rest.map((run, index) =>
            stagger(index + iteration)
              .then(() => heartbeat(run))
              .then(statusOf),
          ),
          stagger(iteration + 1)
            .then(() =>
              apiClient.api["task-runs"]({
                taskRunId: registered.taskRunId,
              })["managed-launch"].post(
                {
                  claimToken: registered.claimToken,
                  entries: { notion: { url: fake.resource } },
                  remotesWithoutAuth: {},
                },
                { headers: target.owner.authHeaders },
              ),
            )
            .then(statusOf),
          ...rest.map((run, index) =>
            stagger(index * 2 + iteration)
              .then(() => seal.complete(target, run))
              .then(statusOf),
          ),
          stagger(iteration * 3)
            .then(() => seal.disconnect(target))
            .then(() => 200),
        ]),
      );

      for (const status of statuses) {
        expect(status).toBeLessThan(500);
      }
      await harness.settleBackgroundTasks();
      for (const run of rest) {
        if ((await runOf(target, run)).status === "running") {
          await unwrapAsync(seal.complete(target, run));
        }
        const stored = await runOf(target, run);
        if (stored.status === "succeeded") {
          expect(await seal.commentsOn(run.workItemId)).toEqual([
            { body: "From the run" },
          ]);
        } else {
          expect(stored).toMatchObject({
            status: "failed",
            errorJson: authorityLost("disconnected"),
          });
          expect(await seal.commentsOn(run.workItemId)).toEqual([]);
        }
        expect(await openOperations(run.taskRunId)).toEqual([]);
      }
    }
    expect(
      logs.slice(logsBefore).filter((line) => /deadlock/iu.test(line)),
    ).toEqual([]);
  }, 120_000);
});
