import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { automations, projectMemberships, taskRuns } from "@/lib/db/schema";
import { AutomationScheduleEntity } from "@/pipeline-definitions/automation/domain/automation-schedule-entity";
import type { Grant } from "@/tasks/task/domain/grants";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { DrizzleWorkItemRepo } from "@/work-items/work-item/infra/drizzle-work-item-repo";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import { grant } from "tests/tasks/task/grants-test-support";
import { RecordingWorkItemEvents } from "tests/work-items/work-item/integration/work-item-events-test-support";
import {
  expectRefused,
  type Claim,
} from "./task-run-create-work-item-test-support";

const NOW = new Date("2026-11-02T12:00:00.000Z");

/**
 * A `project` create (`POST /task-runs/:id/work-item-creates` with
 * `scope: "project"`): a scheduled Task with no work item adds top-level
 * items to its project, deduped by `platformKey`.
 */
describe("task run project work item create", () => {
  let recorder: RecordingWorkItemEvents | undefined;
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(NOW),
    workItemEvents: (inner) => (recorder = new RecordingWorkItemEvents(inner)),
  });
  const apiClient = createScarnTreaty(createApp(appContext));
  const workItemRepo = new DrizzleWorkItemRepo();
  let projectId: UuidV7 | undefined;
  let ownerUserId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-run-create-project-work-item-${crypto.randomUUID()}@example.com`,
    });
    ownerUserId = parseUuidV7(owner.userId);
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Run Create Project Work Item Project",
          description: "Project for project-scoped work item create tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const requireSetup = () => {
    if (!projectId || !ownerUserId || !recorder) {
      throw new Error("Expected setup to complete");
    }
    return { projectId, ownerUserId, recorder };
  };

  const seedSchedule = async () => {
    const { projectId } = requireSetup();
    const automationId = createUuidV7();
    await getDb()
      .insert(automations)
      .values({
        id: automationId,
        projectId,
        key: `scheduled-${crypto.randomUUID()}`,
        scope: "project",
        enabled: true,
      });
    const schedule = await appContext.automationScheduleRepo.insert(
      AutomationScheduleEntity.create(
        automationId,
        {
          key: "poll",
          cron: "*/15 * * * *",
          timezone: "UTC",
          concurrency: { max: 1, waiting: 0 },
        },
        NOW,
      ),
    );
    return schedule.id;
  };

  /**
   * A running run of a Task with `grants`, scheduled unless `workItemId` is
   * given, claimed by the project owner unless `claimedByUserId` is given.
   */
  const startClaimedRun = async (
    grants: Grant[],
    owner: { workItemId: UuidV7 } | { scheduled: true } = { scheduled: true },
    claimedByUserId?: UuidV7,
  ): Promise<Claim> => {
    const { projectId, ownerUserId } = requireSetup();
    const task = await appContext.taskRepo.create(
      TaskEntity.create({
        projectId,
        kind: "agent",
        prompt: "Poll the API.",
        status: "running",
        grants,
        createdAt: NOW,
        ...("workItemId" in owner
          ? { workItemId: owner.workItemId }
          : {
              workItemId: null,
              startedByScheduleId: await seedSchedule(),
              scheduledFor: NOW,
            }),
      }),
    );
    const runId = createUuidV7();
    const claimToken = `claim-${crypto.randomUUID()}`;
    await getDb()
      .insert(taskRuns)
      .values({
        id: runId,
        taskId: task.id,
        number: 1,
        reason: "initial",
        projectId,
        workItemId: task.workItemId,
        status: "running",
        claimedBy: "create-project-work-item",
        claimedByUserId: claimedByUserId ?? ownerUserId,
        claimToken,
        claimedAt: NOW,
        lastHeartbeatAt: NOW,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        startedAt: NOW,
      });
    return { task: { id: runId }, claimToken };
  };

  const projectInput = (
    claim: Claim,
    extra: { platformKey?: string; labels?: string[] } = {},
  ) => ({
    claimToken: claim.claimToken,
    workItemId: parseWorkItemId(createUuidV7()),
    scope: "project" as const,
    platformKey: extra.platformKey ?? `ticket-${crypto.randomUUID()}`,
    url: "https://tickets.example.com/1",
    title: "A polled ticket",
    description: "Found by the poller.",
    ...(extra.labels ? { labels: extra.labels } : {}),
  });

  const create = async (claim: Claim, input: ReturnType<typeof projectInput>) =>
    await apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
      "work-item-creates"
    ].post(input);

  const createdEventsFor = (id: string) =>
    requireSetup()
      .recorder.about([id])
      .filter((each) => each.event === "created");

  concurrentTest(
    "a scheduled Task creates a top-level item it spawned",
    async () => {
      const { projectId, ownerUserId } = requireSetup();
      const claim = await startClaimedRun([
        grant("create", "project", ["intake"]),
      ]);
      const input = projectInput(claim, { labels: ["intake"] });

      const response = await create(claim, input);

      expect(response.status).toBe(201);
      expect(response.data).toEqual({
        workItemId: input.workItemId,
        created: true,
      });
      const item = await workItemRepo.load(input.workItemId);
      const run = await appContext.taskRunRepo.load(parseUuidV7(claim.task.id));
      expect(item).toMatchObject({
        projectId,
        parentWorkItemId: null,
        spawnedByTaskId: run?.taskId,
        createdByUserId: ownerUserId,
        platform: "custom",
        platformKey: input.platformKey,
        url: input.url,
        labels: ["intake"],
        title: "A polled ticket",
      });
    },
  );

  concurrentTest(
    "the same platformKey again returns the existing item, untouched, and fires created once",
    async () => {
      const claim = await startClaimedRun([
        grant("create", "project", ["intake"]),
      ]);
      const first = projectInput(claim);
      await unwrapAsync(create(claim, first));

      const again = await create(claim, {
        ...projectInput(claim, { platformKey: first.platformKey }),
        title: "A changed title",
      });

      expect(again.status).toBe(200);
      expect(again.data).toEqual({
        workItemId: first.workItemId,
        created: false,
      });
      expect((await workItemRepo.load(first.workItemId))?.title).toBe(
        "A polled ticket",
      );
      expect(createdEventsFor(first.workItemId)).toHaveLength(1);
    },
  );

  describe("refusals", () => {
    concurrentTest("a label outside the grant is refused", async () => {
      const claim = await startClaimedRun([
        grant("create", "project", ["intake"]),
      ]);
      const input = projectInput(claim, { labels: ["intake", "bug"] });

      expectRefused(await create(claim, input));
      expect(await workItemRepo.load(input.workItemId)).toBeNull();
    });

    concurrentTest(
      "a scheduled Task with no create grant on project is refused",
      async () => {
        const claim = await startClaimedRun([]);
        const input = projectInput(claim);

        expectRefused(await create(claim, input), "no create grant on project");
        expect(await workItemRepo.load(input.workItemId)).toBeNull();
      },
    );

    concurrentTest(
      "a work item's Task with only create on children can't create top-level",
      async () => {
        const workItemId = await seedWorkItem(requireSetup().projectId);
        const claim = await startClaimedRun(
          [grant("create", "children", ["intake"])],
          { workItemId },
        );
        const input = projectInput(claim);

        expectRefused(await create(claim, input), "no create grant on project");
        expect(await workItemRepo.load(input.workItemId)).toBeNull();
      },
    );
  });

  describe("the claiming user's permissions", () => {
    const readMember = async () => {
      const { projectId } = requireSetup();
      const member = await createTestUserAndSession({
        email: `task-run-create-project-reader-${crypto.randomUUID()}@example.com`,
      });
      const userId = parseUuidV7(member.userId);
      await getDb()
        .insert(projectMemberships)
        .values({ projectId, userId, role: "read" });
      return userId;
    };

    concurrentTest(
      "a run claimed by a read member is denied, even with a create grant",
      async () => {
        const claim = await startClaimedRun(
          [grant("create", "project", ["intake"])],
          { scheduled: true },
          await readMember(),
        );
        const input = projectInput(claim, { labels: ["intake"] });

        const response = await create(claim, input);

        expect(response.error?.status).toBe(403);
        expect(response.error?.value).toMatchObject({
          code: "PROJECT_FORBIDDEN",
        });
        expect(await workItemRepo.load(input.workItemId)).toBeNull();
      },
    );

    concurrentTest(
      "a read member's run can't see an existing key through a repeat create",
      async () => {
        const owners = await startClaimedRun([
          grant("create", "project", ["intake"]),
        ]);
        const first = projectInput(owners);
        await unwrapAsync(create(owners, first));
        const claim = await startClaimedRun(
          [grant("create", "project", ["intake"])],
          { scheduled: true },
          await readMember(),
        );

        const response = await create(
          claim,
          projectInput(claim, { platformKey: first.platformKey }),
        );

        expect(response.error?.status).toBe(403);
      },
    );
  });
});
