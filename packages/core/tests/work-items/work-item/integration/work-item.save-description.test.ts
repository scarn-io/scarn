import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import { WorkItemDescriptionConflict } from "@/work-items/work-item/domain/work-item-description-conflict";

/**
 * `DrizzleWorkItemRepo.saveDescription` is a compare-and-set on
 * `descriptionVersion`, so of two writers that read the same version exactly
 * one lands. `save` leaves an existing row's description alone.
 */
describe("DrizzleWorkItemRepo.saveDescription", () => {
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-11-02T12:00:00.000Z")),
  });
  const apiClient = createScarnTreaty(createApp(appContext));
  const { workItemRepo } = appContext;
  let project: ProjectContract | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-save-description-${crypto.randomUUID()}@example.com`,
    });
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "saveDescription Project",
          description: "Project for the description compare-and-set test",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  const createNativeItem = async () => {
    if (!project) throw new Error("Expected project setup to complete");
    return await workItemRepo.create(
      WorkItemEntity.create({
        projectId: parseUuidV7(project.id),
        platform: "scarn",
        platformKey: `manual-${uuidv7()}`,
        title: "Map",
        description: "Original",
      }),
    );
  };

  concurrentTest(
    "of two concurrent writes naming the same version, exactly one wins",
    async () => {
      const item = await createNativeItem();

      const results = await Promise.allSettled([
        workItemRepo.saveDescription(item.describeByTask("First"), 1),
        workItemRepo.saveDescription(item.describeByTask("Second"), 1),
      ]);

      const won = results.filter((result) => result.status === "fulfilled");
      const lost = results.filter((result) => result.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.reason).toBeInstanceOf(WorkItemDescriptionConflict);
      const stored = await workItemRepo.load(item.id);
      expect(stored?.descriptionVersion).toBe(2);
      expect(stored?.description).toBe(won[0]?.value.description ?? "");
    },
  );

  concurrentTest(
    "a write naming a stale version is refused and changes nothing",
    async () => {
      const item = await createNativeItem();
      await workItemRepo.saveDescription(item.describeByTask("Newer"), 1);

      const refusal = await workItemRepo
        .saveDescription(item.describeByTask("Stale"), 1)
        .then(
          () => null,
          // eslint-disable-next-line local/no-unknown-parameter-type
          (error: unknown) => error,
        );

      expect(refusal).toBeInstanceOf(WorkItemDescriptionConflict);
      expect(refusal).toMatchObject({
        status: 409,
        code: "WORK_ITEM_DESCRIPTION_CONFLICT",
      });
      expect(await workItemRepo.load(item.id)).toMatchObject({
        description: "Newer",
        descriptionVersion: 2,
      });
    },
  );

  concurrentTest(
    "save leaves an existing row's description and version alone",
    async () => {
      const item = await createNativeItem();

      await workItemRepo.save(item.edit("Retitled", "Ignored"));

      expect(await workItemRepo.load(item.id)).toMatchObject({
        title: "Retitled",
        description: "Original",
        descriptionVersion: 1,
      });
    },
  );
});
