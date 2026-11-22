/**
 * Load sanity for the relay (decisions 10, 12 and 14): many runs of one
 * project share a connection whose access token has expired, and all of
 * their calls go through the relay at once. The fake sees exactly one
 * refresh per expiry, no lock waits past Postgres's deadlock detection,
 * and every operation is released.
 *
 * With 100 calls queued on a 10-connection pool, the refresh's commit can
 * wait its turn past the relay's 2 s busy wait, so a caller may get the
 * designed 503 `MANAGED_CONNECTION_REFRESH_BUSY`. Such a call never reached
 * Notion, and its resend is served.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { getDb } from "@/lib/db";
import { unwrapAsync } from "tests/utils";
import {
  createSealTestClient,
  type SealProject,
  type SealRun,
} from "./managed-authority-seal-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import { createRelayTestClient, rpc } from "./managed-mcp-relay-test-support";

const HOUR_MS = 60 * 60 * 1000;
const RUNS = 20;
const CALLS_PER_RUN = 5;
const EXPIRIES = 2;
const TOOL = "notion-tool-0-0";
/** The whole burst of calls for one expiry must finish within this. */
const BURST_DEADLINE_MS = 30_000;

type Call = { run: SealRun; id: number };
type Result = Call & { status: number; code: string | null };

describe("managed relay under load", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, appContext, logs } = harness;
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

  const send = async (call: Call): Promise<Result> => {
    const response = await relay(call.run, {
      body: rpc(call.id, "tools/call", { name: TOOL, arguments: {} }),
    });
    const body = await response.text();
    return {
      ...call,
      status: response.status,
      code:
        response.status === 200
          ? null
          : ((JSON.parse(body) as { code?: string }).code ?? null),
    };
  };

  const burst = async (runs: SealRun[]) => {
    const started = Date.now();
    const results = await Promise.all(
      runs.flatMap((run) =>
        Array.from({ length: CALLS_PER_RUN }, (_, index) =>
          send({ run, id: index + 1 }),
        ),
      ),
    );
    return { results, elapsedMs: Date.now() - started };
  };

  const sealAll = async (target: SealProject, runs: SealRun[]) => {
    for (const run of runs) {
      expect((await unwrapAsync(seal.complete(target, run))).status).toBe(
        "succeeded",
      );
    }
  };

  test(`${String(RUNS)} runs × ${String(CALLS_PER_RUN)} calls at once: one refresh per expiry, every call served or busy-then-served, no deadlock`, async () => {
    const target = await seal.project("relay-load");
    const logsBefore = logs.length;

    for (let expiry = 1; expiry <= EXPIRIES; expiry += 1) {
      clock.advance(HOUR_MS);
      const runs: SealRun[] = [];
      for (let index = 0; index < RUNS; index += 1) {
        runs.push(await seal.launchRun(target));
      }
      fake.mcp.effects.clear();

      const { results, elapsedMs } = await burst(runs);

      expect(elapsedMs).toBeLessThan(BURST_DEADLINE_MS);
      expect(fake.refreshCount).toBe(expiry);
      const busy = results.filter((result) => result.status !== 200);
      expect(
        busy.map(({ status, code }) => ({ status, code })),
      ).toEqual(
        busy.map(() => ({
          status: 503,
          code: "MANAGED_CONNECTION_REFRESH_BUSY",
        })),
      );
      expect(fake.mcp.effectCount(TOOL)).toBe(results.length - busy.length);

      const resent = await Promise.all(busy.map(send));
      expect(resent.map((result) => result.status)).toEqual(
        busy.map(() => 200),
      );
      expect(fake.refreshCount).toBe(expiry);
      expect(fake.mcp.effectCount(TOOL)).toBe(RUNS * CALLS_PER_RUN);

      await harness.settleBackgroundTasks();
      for (const run of runs) {
        expect(
          await appContext.managedLaunchRepo.listOperations(
            run.taskRunId,
            getDb(),
          ),
        ).toEqual([]);
      }
      await sealAll(target, runs);
    }

    expect(
      logs.slice(logsBefore).filter((line) => /deadlock/iu.test(line)),
    ).toEqual([]);
  }, 180_000);
});
