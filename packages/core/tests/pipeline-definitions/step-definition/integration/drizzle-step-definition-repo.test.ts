import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { concurrentTest } from "tests/utils";
import { getDb } from "@/lib/db";
import { projects, stepDefinitions } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { ResourceConflictError } from "@/lib/errors";
import { StepDefinitionEntity } from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import { DrizzleStepDefinitionRepo } from "@/pipeline-definitions/step-definition/infra/drizzle-step-definition-repo";
import { resolveTaskExecutionConfig } from "@/tasks/task-execution-config/application/resolve-task-execution-config";
import { DrizzleTaskExecutionConfigRepo } from "@/tasks/task-execution-config/infra/drizzle-task-execution-config-repo";

/**
 * Round-trips `taskExecutionConfigId` through `step_definitions`: the step
 * definition is saved through `DrizzleStepDefinitionRepo` against a config
 * written by the task execution config resolver, the row is read back raw,
 * and the entity is reloaded.
 */
describe("drizzle step definition repo: task execution config reference", () => {
  const stepDefinitionRepo = new DrizzleStepDefinitionRepo();
  const resolverDeps = {
    taskExecutionConfigRepo: new DrizzleTaskExecutionConfigRepo(),
  };
  let projectId: UuidV7;

  beforeAll(async () => {
    projectId = createUuidV7();
    await getDb()
      .insert(projects)
      .values({
        id: projectId,
        name: "Step definition repo project",
        slug: `step-definition-repo-${crypto.randomUUID()}`,
        gitUrl: "https://github.com/example/test-project.git",
        createdByUserId: createUuidV7(),
        orgId: createUuidV7(),
      });
  });

  const resolveConfigId = async (key: string): Promise<UuidV7> => {
    const config = await resolveTaskExecutionConfig(
      {
        projectId,
        environment: {
          kind: "inline",
          envJson: [
            { name: "STEP_KEY", source: "value", value: key, secret: false },
          ],
        },
      },
      resolverDeps,
    );
    if (!config) throw new Error("expected a task execution config");
    return config.id;
  };

  const createEntity = (key: string, taskExecutionConfigId: UuidV7 | null) =>
    StepDefinitionEntity.create({
      projectId,
      key,
      name: "Task execution config reference",
      prompt: "Do the thing",
      version: 1,
      kind: "user_defined",
      inputSchemaJson: { type: "object" },
      resultSchemaJson: { type: "object" },
      taskExecutionConfigId,
      status: "active",
    });

  const readTaskExecutionConfigId = async (id: UuidV7) => {
    const [row] = await getDb()
      .select({ taskExecutionConfigId: stepDefinitions.taskExecutionConfigId })
      .from(stepDefinitions)
      .where(eq(stepDefinitions.id, id));
    return row?.taskExecutionConfigId;
  };

  concurrentTest(
    "create stores the task execution config id and loads it back",
    async () => {
      const key = `config_ref_${crypto.randomUUID()}`;
      const taskExecutionConfigId = await resolveConfigId(key);
      const entity = createEntity(key, taskExecutionConfigId);

      const created = await stepDefinitionRepo.create(entity);

      expect(created.taskExecutionConfigId).toBe(taskExecutionConfigId);
      expect(await readTaskExecutionConfigId(entity.id)).toBe(
        taskExecutionConfigId,
      );
      expect(
        (await stepDefinitionRepo.load(entity.id))?.taskExecutionConfigId,
      ).toBe(taskExecutionConfigId);
    },
  );

  concurrentTest("create stores a null config reference", async () => {
    const key = `config_ref_${crypto.randomUUID()}`;
    const entity = createEntity(key, null);

    await stepDefinitionRepo.create(entity);

    expect(await readTaskExecutionConfigId(entity.id)).toBeNull();
    expect(
      (await stepDefinitionRepo.load(entity.id))?.taskExecutionConfigId,
    ).toBeNull();
  });

  concurrentTest(
    "save repoints the step at a new task execution config",
    async () => {
      const key = `config_ref_${crypto.randomUUID()}`;
      const first = await resolveConfigId(key);
      const entity = createEntity(key, first);
      await stepDefinitionRepo.create(entity);

      const second = await resolveConfigId(`${key}_changed`);
      const saved = await stepDefinitionRepo.save(
        StepDefinitionEntity.rehydrate({
          ...entity.toJSON(),
          taskExecutionConfigId: second,
        }),
      );

      expect(second).not.toBe(first);
      expect(saved.taskExecutionConfigId).toBe(second);
      expect(await readTaskExecutionConfigId(entity.id)).toBe(second);
    },
  );

  concurrentTest(
    "grantRequests round-trips through create and save",
    async () => {
      const key = `grant_requests_${crypto.randomUUID()}`;
      const entity = createEntity(key, null);
      expect(entity.grantRequests).toBe(false);
      expect((await stepDefinitionRepo.create(entity)).grantRequests).toBe(
        false,
      );

      const saved = await stepDefinitionRepo.save(
        StepDefinitionEntity.rehydrate({
          ...entity.toJSON(),
          grantRequests: true,
        }),
      );
      expect(saved.grantRequests).toBe(true);
      expect((await stepDefinitionRepo.load(entity.id))?.grantRequests).toBe(
        true,
      );
    },
  );

  concurrentTest("create rejects a duplicate key as a conflict", async () => {
    const key = `config_ref_${crypto.randomUUID()}`;
    const taskExecutionConfigId = await resolveConfigId(key);
    await stepDefinitionRepo.create(createEntity(key, taskExecutionConfigId));

    let error: unknown = null;
    try {
      await stepDefinitionRepo.create(createEntity(key, taskExecutionConfigId));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ResourceConflictError);
  });
});
