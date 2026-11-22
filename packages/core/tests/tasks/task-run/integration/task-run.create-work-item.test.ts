import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskRuns } from "@/lib/db/schema";
import type { Grant } from "@/tasks/task/domain/grants";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { DrizzleWorkItemRepo } from "@/work-items/work-item/infra/drizzle-work-item-repo";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import { grant } from "tests/tasks/task/grants-test-support";
import {
  childInput,
  expectRefused,
  seedChildren,
  type Claim,
} from "./task-run-create-work-item-test-support";

type AuthHeaders = { authorization: string };

const NOW = new Date("2026-05-01T12:00:00.000Z");
const MERGE_CONFLICT = { name: "MergeConflict", message: "rebase failed" };

/**
 * The direct create an agent's `scarn-create-work-item` makes
 * (`POST /task-runs/:id/work-item-creates`), authorized by the run's claim
 * token.
 */
describe("task run work item create", () => {
  const apiClient = createScarnTreaty(
    createApp(createAppContext({ timeProvider: fixedTimeProvider(NOW) })),
  );
  const workItemRepo = new DrizzleWorkItemRepo();
  let projectId: UuidV7 | undefined;
  let headers: AuthHeaders | undefined;
  let ownerUserId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-run-create-work-item-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    ownerUserId = parseUuidV7(owner.userId);
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Run Create Work Item Project",
          description: "Project for direct work item create tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const requireSetup = () => {
    if (!projectId || !headers || !ownerUserId) {
      throw new Error("Expected setup to complete");
    }
    return { projectId, headers: { ...headers }, ownerUserId };
  };

  const claimRun = async (workItemId: UuidV7, taskRunId: string) => {
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `create-work-item-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claim = claims.find((entry) => entry.task.id === taskRunId);
    if (!claim) {
      throw new Error(`Expected to claim run ${taskRunId}`);
    }
    return claim;
  };

  const startClaimedRun = async (
    labels: string[],
    options: { grants?: Grant[]; retryOnMergeConflict?: boolean } = {},
  ) => {
    const { projectId, headers } = requireSetup();
    const step = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `task_run_create_work_item_${crypto.randomUUID()}`,
          name: "Create step",
          description: "Step for direct work item create tests",
          prompt: "Plan the children.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
          grants: options.grants ?? [grant("create", "children", labels)],
          ...(options.retryOnMergeConflict
            ? {
                errors: [MERGE_CONFLICT.name],
                retry: [{ on: [MERGE_CONFLICT.name], maxAttempts: 1 }],
              }
            : {}),
        },
        { headers },
      ),
    );
    const workItemId = await seedWorkItem(projectId);
    const task = await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: parseUuidV7(step.id),
          stepDefinitionVersion: step.version,
        },
        { headers },
      ),
    );
    if (!task.run) {
      throw new Error("Expected the Task's first run");
    }
    const claim = await claimRun(workItemId, task.run.id);
    return { taskId: parseUuidV7(task.task.id), workItemId, claim };
  };

  const create = async (
    claim: Claim,
    input: ReturnType<typeof childInput> = childInput(claim),
  ) =>
    await apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
      "work-item-creates"
    ].post(input);

  const childrenOf = async (workItemId: UuidV7) =>
    await workItemRepo.listChildren(parseWorkItemId(workItemId));

  concurrentTest(
    "creates the child under the Task's item as the claiming user",
    async () => {
      const { ownerUserId } = requireSetup();
      const { taskId, workItemId, claim } = await startClaimedRun(["bug"]);
      const childId = createUuidV7();

      const created = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
          "work-item-creates"
        ].post({
          claimToken: claim.claimToken,
          workItemId: parseWorkItemId(childId),
          title: "Fix the login bug",
          description: "The login form rejects valid passwords.",
          labels: ["bug"],
        }),
      );

      expect(created).toEqual({
        workItemId: parseWorkItemId(childId),
        created: true,
      });
      const child = await workItemRepo.load(parseWorkItemId(childId));
      expect(child).toMatchObject({
        parentWorkItemId: workItemId,
        spawnedByTaskId: taskId,
        labels: ["bug"],
        createdByUserId: ownerUserId,
        platform: "scarn",
        platformKey: `manual-${childId}`,
        title: "Fix the login bug",
        state: "open",
      });
    },
  );

  describe("replays", () => {
    concurrentTest(
      "the same id again returns the item without a duplicate",
      async () => {
        const { workItemId, claim } = await startClaimedRun(["bug"]);
        const input = childInput(claim, { labels: ["bug"] });

        const first = await create(claim, input);
        const second = await create(claim, input);

        expect(first.status).toBe(201);
        expect(first.data).toEqual({
          workItemId: input.workItemId,
          created: true,
        });
        expect(second.status).toBe(200);
        expect(second.data).toEqual({
          workItemId: input.workItemId,
          created: false,
        });
        expect((await childrenOf(workItemId)).map((c) => c.id)).toEqual([
          input.workItemId,
        ]);
      },
    );

    concurrentTest("an id another item already uses is refused", async () => {
      const { projectId } = requireSetup();
      const { workItemId, claim } = await startClaimedRun(["bug"]);
      const taken = await seedWorkItem(projectId);

      expectRefused(
        await create(claim, childInput(claim, { workItemId: taken })),
        "already used",
      );
      expect(await childrenOf(workItemId)).toEqual([]);
    });
  });

  describe("refusals", () => {
    concurrentTest(
      "a Task with no create grant on children is refused",
      async () => {
        const { workItemId, claim } = await startClaimedRun(["bug"], {
          grants: [grant("read", "children")],
        });

        expectRefused(await create(claim), "no create grant");
        expect(await childrenOf(workItemId)).toEqual([]);
      },
    );

    concurrentTest("a label outside the grant is refused", async () => {
      const { workItemId, claim } = await startClaimedRun(["bug"]);

      expectRefused(
        await create(claim, childInput(claim, { labels: ["bug", "feature"] })),
      );
      expect(await childrenOf(workItemId)).toEqual([]);
    });

    concurrentTest(
      "a blocker that is neither the Task's item nor its child is refused",
      async () => {
        const { projectId } = requireSetup();
        const { workItemId, claim } = await startClaimedRun(["bug"]);
        const unrelated = await seedWorkItem(projectId);

        expectRefused(
          await create(claim, childInput(claim, { blockedBy: [unrelated] })),
          "neither the Task's work item nor one of its children",
        );
        expectRefused(
          await create(
            claim,
            childInput(claim, { blockedBy: [createUuidV7()] }),
          ),
          "doesn't exist in this project",
        );
        expect(await childrenOf(workItemId)).toEqual([]);
      },
    );

    concurrentTest(
      "a blocker that is the Task's item or its child is accepted",
      async () => {
        const { workItemId, claim } = await startClaimedRun(["bug"]);
        const sibling = childInput(claim);
        await unwrapAsync(create(claim, sibling));

        const blocked = await unwrapAsync(
          create(
            claim,
            childInput(claim, {
              blockedBy: [workItemId, parseUuidV7(sibling.workItemId)],
            }),
          ),
        );

        expect(blocked.created).toBe(true);
      },
    );

    concurrentTest("a wrong claim token is refused", async () => {
      const { workItemId, claim } = await startClaimedRun(["bug"]);

      const response = await create(claim, {
        ...childInput(claim),
        claimToken: "not-the-claim-token",
      });

      expect(response.error?.status).toBe(409);
      expect(await childrenOf(workItemId)).toEqual([]);
    });

    concurrentTest("an expired claim is refused", async () => {
      const { workItemId, claim } = await startClaimedRun(["bug"]);
      await getDb()
        .update(taskRuns)
        .set({ leaseExpiresAt: new Date(NOW.getTime() - 1000) })
        .where(eq(taskRuns.id, claim.task.id));

      const response = await create(claim);

      expect(response.error?.status).toBe(409);
      expect(await childrenOf(workItemId)).toEqual([]);
    });

    concurrentTest("a run that is no longer running is refused", async () => {
      const { headers } = requireSetup();
      const { workItemId, claim } = await startClaimedRun(["bug"]);
      await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: claim.task.id,
        }).completions.post(
          {
            claimToken: claim.claimToken,
            status: "succeeded",
            resultJson: {},
            errorJson: null,
          },
          { headers },
        ),
      );

      const response = await create(claim);

      expect(response.error?.status).toBe(409);
      expect(await childrenOf(workItemId)).toEqual([]);
    });
  });

  describe("caps", () => {
    concurrentTest("a Task may create at most 10 work items", async () => {
      const { workItemId, claim } = await startClaimedRun(["bug"]);
      for (let index = 0; index < 10; index += 1) {
        await unwrapAsync(create(claim));
      }

      expectRefused(await create(claim), "already created 10");
      expect(await childrenOf(workItemId)).toHaveLength(10);
    });

    concurrentTest(
      "the per-Task cap counts every run of the Task",
      async () => {
        const { headers } = requireSetup();
        const { taskId, workItemId, claim } = await startClaimedRun(["bug"], {
          retryOnMergeConflict: true,
        });
        for (let index = 0; index < 6; index += 1) {
          await unwrapAsync(create(claim));
        }
        await unwrapAsync(
          apiClient.api["task-runs"]({
            taskRunId: claim.task.id,
          }).completions.post(
            {
              claimToken: claim.claimToken,
              status: "failed",
              resultJson: null,
              errorJson: MERGE_CONFLICT,
            },
            { headers },
          ),
        );
        const runs = await unwrapAsync(
          apiClient.api.tasks({ taskId }).runs.get({ headers }),
        );
        const retry = runs.find((run) => run.number === 2);
        if (!retry) {
          throw new Error("Expected a retry run");
        }
        const retryClaim = await claimRun(workItemId, retry.id);

        for (let index = 0; index < 4; index += 1) {
          await unwrapAsync(create(retryClaim));
        }

        expectRefused(await create(retryClaim), "already created 10");
        expect(await childrenOf(workItemId)).toHaveLength(10);
      },
    );

    concurrentTest(
      "a work item with 50 open children gets no more",
      async () => {
        const { workItemId, claim } = await startClaimedRun(["bug"]);
        await seedChildren(requireSetup().projectId, workItemId, 50);

        expectRefused(await create(claim), "50 open children");
        expect(await childrenOf(workItemId)).toHaveLength(50);
      },
    );

    concurrentTest(
      "parallel creates past the per-Task cap: exactly the allowed number succeed",
      async () => {
        const { taskId, workItemId, claim } = await startClaimedRun(["bug"]);
        await seedChildren(requireSetup().projectId, workItemId, 5, taskId);

        const responses = await Promise.all(
          Array.from({ length: 10 }, async () => await create(claim)),
        );

        expect(
          responses.filter((response) => response.status === 201),
        ).toHaveLength(5);
        const refused = responses.filter((response) => response.error);
        expect(refused).toHaveLength(5);
        for (const response of refused) {
          expectRefused(response, "already created 10");
        }
        expect(await childrenOf(workItemId)).toHaveLength(10);
      },
    );
  });
});
