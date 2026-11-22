/**
 * The authority fence end to end: a pipeline step whose run lost authority
 * takes the failure route, and a disconnect racing a completion always ends
 * in one of the two legal orders (decision 9: whichever commits first wins).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { createPipelineFromDocument } from "tests/pipeline-definitions/pipeline-test-support";
import { unwrapAsync } from "tests/utils";
import {
  authorityLost,
  createSealTestClient,
} from "./managed-authority-seal-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const RACE_ITERATIONS = 50;
/** The disconnect starts 0 to this many ms − 1 after the completion, so both orders occur. */
const RACE_STAGGER_STEPS = 10;

describe("managed authority fence races", () => {
  const harness = createManagedConnectionHarness();
  const { fake, appContext, apiClient } = harness;
  const seal = createSealTestClient(harness);

  afterAll(async () => {
    await fake.stop();
  });

  test("a pipeline step that lost authority takes its catch route and applies nothing", async () => {
    const target = await seal.project("seal-pipeline");
    const definition = await createPipelineFromDocument(
      apiClient,
      target.owner.authHeaders,
      target.projectId,
      {
        schemaVersion: 1,
        key: `seal-pipeline-${crypto.randomUUID()}`,
        start: { to: "notion" },
        nodes: {
          notion: {
            kind: "step",
            step: target.stepKey,
            catch: [{ on: ["ManagedConnectionAuthorityLost"], to: "lost" }],
            next: { routes: [{ to: "done" }] },
          },
          done: { kind: "succeed" },
          lost: { kind: "fail", error: "NotionLost" },
        },
      },
    );
    const workItemId = await seal.seedNativeWorkItem(target.projectId);
    const execution = await unwrapAsync(
      apiClient.api["pipeline-executions"].post(
        {
          projectId: target.projectId,
          workItemId,
          pipelineDefinitionId: parseUuidV7(definition.id),
        },
        { headers: target.owner.authHeaders },
      ),
    );
    const claimed = await seal.claim(target, workItemId);
    await seal.register(target, claimed.taskRunId, claimed.claimToken);
    await seal.disconnect(target);

    const completed = await unwrapAsync(
      seal.complete(target, { ...claimed, workItemId }),
    );

    expect(completed).toMatchObject({
      status: "failed",
      errorJson: authorityLost("disconnected"),
    });
    expect(await seal.commentsOn(workItemId)).toEqual([]);
    expect(
      await unwrapAsync(
        apiClient.api["pipeline-executions"]({
          pipelineExecutionId: execution.id,
        }).get({ headers: target.owner.authHeaders }),
      ),
    ).toMatchObject({
      runStatus: "failed",
      endNodeId: "lost",
      error: { name: "NotionLost" },
    });
  });

  test(`a disconnect racing a completion ends in a legal order, ${String(RACE_ITERATIONS)} times`, async () => {
    const target = await seal.project("seal-race");
    const outcomes = { completedFirst: 0, disconnectedFirst: 0 };
    for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
      if (iteration > 0) {
        await seal.reconnectFromDisconnected(target);
      }
      const run = await seal.launchRun(target);

      const [completion] = await Promise.all([
        seal.complete(target, run),
        Bun.sleep(iteration % RACE_STAGGER_STEPS).then(() =>
          seal.disconnect(target),
        ),
      ]);

      const stored = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).get({
          headers: target.owner.authHeaders,
        }),
      );
      const comments = await seal.commentsOn(run.workItemId);
      const lost = (await seal.authorityLostEvents(target.connectionId)).filter(
        (event) => event.taskRunId === run.taskRunId,
      );
      expect(completion.error).toBeNull();
      expect(completion.data?.status).toBe(stored.status);
      if (stored.status === "succeeded") {
        outcomes.completedFirst += 1;
        expect(comments).toEqual([{ body: "From the run" }]);
        expect(lost).toEqual([]);
      } else {
        outcomes.disconnectedFirst += 1;
        expect(stored).toMatchObject({
          status: "failed",
          errorJson: authorityLost("disconnected"),
        });
        expect(comments).toEqual([]);
        expect(lost).toHaveLength(1);
      }
      expect(
        await appContext.managedLaunchRepo.listOpenForRun(
          run.taskRunId,
          getDb(),
        ),
      ).toEqual([]);
    }
    expect(outcomes.completedFirst + outcomes.disconnectedFirst).toBe(
      RACE_ITERATIONS,
    );
  }, 120_000);
});
