import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { EnvironmentEntity } from "@/pipeline-definitions/environment/domain/environment-entity";
import { EnvironmentVersionEntity } from "@/pipeline-definitions/environment/domain/environment-version-entity";
import { DrizzleEnvironmentRepo } from "@/pipeline-definitions/environment/infra/drizzle-environment-repo";
import { StepDefinitionEntity } from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import { DrizzleStepDefinitionRepo } from "@/pipeline-definitions/step-definition/infra/drizzle-step-definition-repo";
import { TaskExecutionConfigEntity } from "@/tasks/task-execution-config/domain/task-execution-config-entity";
import { DrizzleTaskExecutionConfigRepo } from "@/tasks/task-execution-config/infra/drizzle-task-execution-config-repo";

/**
 * The repo queries the use cases rely on, against real Postgres: one row per
 * name, the latest version join, and finding the active steps that name an
 * environment.
 */
describe("drizzle environment repo", () => {
  const environmentRepo = new DrizzleEnvironmentRepo();
  const stepDefinitionRepo = new DrizzleStepDefinitionRepo();
  const taskExecutionConfigRepo = new DrizzleTaskExecutionConfigRepo();
  const userId = createUuidV7();
  let projectId: UuidV7;

  beforeAll(async () => {
    projectId = createUuidV7();
    await getDb()
      .insert(projects)
      .values({
        id: projectId,
        name: "Environment repo project",
        slug: `environment-repo-${crypto.randomUUID()}`,
        gitUrl: "https://github.com/example/test-project.git",
        createdByUserId: createUuidV7(),
        orgId: createUuidV7(),
      });
  });

  const publish = async (name: string, description: string) => {
    const now = new Date();
    return await getDb().transaction(async (tx) => {
      const locked = await environmentRepo.lockOrCreate(
        EnvironmentEntity.create({ projectId, name, now }),
        tx,
      );
      const version = await environmentRepo.insertVersion(
        EnvironmentVersionEntity.create({
          environmentId: locked.id,
          version: locked.nextVersion,
          content: { description },
          createdByUserId: userId,
          createdAt: now,
        }),
        tx,
      );
      return await environmentRepo.save(
        locked.publishVersion(version.version, now),
        tx,
      );
    });
  };

  const createStep = async (
    key: string,
    environmentName: string,
    status: "active" | "archived",
  ) => {
    const config = await taskExecutionConfigRepo.findOrCreate(
      TaskExecutionConfigEntity.create({
        projectId,
        content: {
          environment: { kind: "named", name: environmentName },
          git: null,
          mcp: null,
          healthChecks: null,
        },
      }),
    );
    await stepDefinitionRepo.create(
      StepDefinitionEntity.create({
        projectId,
        key,
        name: key,
        prompt: "Do the thing",
        version: 1,
        kind: "user_defined",
        inputSchemaJson: { type: "object" },
        resultSchemaJson: { type: "object" },
        taskExecutionConfigId: config.id,
        status,
      }),
    );
  };

  concurrentTest(
    "republishing a name reuses its row and numbers on",
    async () => {
      const name = `env-${crypto.randomUUID()}`;
      const first = await publish(name, "one");
      const second = await publish(name, "two");

      expect(second.id).toBe(first.id);
      expect(second.latestVersion).toBe(2);
      const listed = await environmentRepo.listLiveWithLatestVersion(projectId);
      const entry = listed.find((row) => row.environment.name === name);
      expect(entry?.latestVersion.version).toBe(2);
      expect(entry?.latestVersion.content).toEqual({ description: "two" });
    },
  );

  concurrentTest("a deleted environment is not listed", async () => {
    const name = `env-${crypto.randomUUID()}`;
    const published = await publish(name, "gone");
    await environmentRepo.save(published.delete(new Date()));

    const listed = await environmentRepo.listLiveWithLatestVersion(projectId);
    expect(listed.map((row) => row.environment.name)).not.toContain(name);
    expect((await environmentRepo.findByName(projectId, name))?.isDeleted).toBe(
      true,
    );
  });

  concurrentTest(
    "listActiveStepKeysUsing finds non-archived steps naming it",
    async () => {
      const name = `env-${crypto.randomUUID()}`;
      const suffix = crypto.randomUUID();
      await createStep(`b_active_${suffix}`, name, "active");
      await createStep(`a_active_${suffix}`, name, "active");
      await createStep(`archived_${suffix}`, name, "archived");
      await createStep(`other_${suffix}`, `${name}-other`, "active");

      expect(
        await environmentRepo.listActiveStepKeysUsing(projectId, name),
      ).toEqual([`a_active_${suffix}`, `b_active_${suffix}`]);
    },
  );
});
