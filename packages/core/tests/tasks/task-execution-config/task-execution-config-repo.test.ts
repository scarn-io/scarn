/**
 * DB-backed coverage for `task_execution_configs`: content-hash dedup per
 * project (D7), the resolver's null-for-empty rule (D3) and the versioned
 * read path (D6).
 *
 * Placement: it hits Postgres, so it is not a unit test, and the module has
 * no HTTP surface, so it cannot go through the API client as `integration/`
 * tests must.
 */
import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projects, taskExecutionConfigs } from "@/lib/db/schema";
import { PersistenceError } from "@/lib/errors";
import { resolveTaskExecutionConfig } from "@/tasks/task-execution-config/application/resolve-task-execution-config";
import type { ResolveTaskExecutionConfigInput } from "@/tasks/task-execution-config/contracts/task-execution-config-contracts";
import { TaskExecutionConfigEntity } from "@/tasks/task-execution-config/domain/task-execution-config-entity";
import {
  DrizzleTaskExecutionConfigRepo,
  taskExecutionConfigFromRow,
} from "@/tasks/task-execution-config/infra/drizzle-task-execution-config-repo";
import { concurrentTest } from "tests/utils";
import v1GitCredentialsFixture from "./fixtures/v1-git-credentials.json";
import v1Fixture from "./fixtures/v1.json";

const taskExecutionConfigRepo = new DrizzleTaskExecutionConfigRepo();
const deps = { taskExecutionConfigRepo };

const createProject = async (): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id: projectId,
      name: "Task execution config test project",
      slug: `task-execution-config-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return projectId;
};

const inlineConfig = (projectId: UuidV7): ResolveTaskExecutionConfigInput => ({
  projectId,
  environment: {
    kind: "inline",
    runtime: {
      kind: "devcontainer",
      config: ".devcontainer/devcontainer.json",
    },
    envJson: [
      { name: "LOG_LEVEL", source: "value", value: "debug", secret: false },
    ],
  },
  opencodeMcpJson: {
    github: { type: "remote", url: "https://example.com/mcp" },
  },
  healthChecksJson: [
    { kind: "tool", tool: "list_issues", mcp: "github" },
    { kind: "cli", command: ["gh", "--version"] },
  ],
  repo: { mode: "readOnly" },
});

const rowsFor = (projectId: UuidV7) =>
  getDb()
    .select()
    .from(taskExecutionConfigs)
    .where(eq(taskExecutionConfigs.projectId, projectId));

const insertRawRow = async (
  projectId: UuidV7,
  columns: Partial<typeof taskExecutionConfigs.$inferInsert>,
): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(taskExecutionConfigs)
    .values({
      id,
      projectId,
      schemaVersion: 3,
      contentHash: crypto.randomUUID(),
      ...columns,
    });
  return id;
};

const rejectionOf = async (promise: Promise<object | null>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
};

describe("task execution config repo", () => {
  concurrentTest("the same content resolves to the same row", async () => {
    const projectId = await createProject();

    const first = await resolveTaskExecutionConfig(
      inlineConfig(projectId),
      deps,
    );
    const second = await resolveTaskExecutionConfig(
      inlineConfig(projectId),
      deps,
    );

    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(await rowsFor(projectId)).toHaveLength(1);

    const loaded = await taskExecutionConfigRepo.load(
      first?.id ?? createUuidV7(),
    );
    expect(loaded?.toJSON()).toEqual(first?.toJSON());
  });

  concurrentTest("different content resolves to a different row", async () => {
    const projectId = await createProject();

    const first = await resolveTaskExecutionConfig(
      inlineConfig(projectId),
      deps,
    );
    const second = await resolveTaskExecutionConfig(
      {
        ...inlineConfig(projectId),
        repo: { mode: "readWrite", onPushFailure: "warn" },
      },
      deps,
    );

    expect(second?.id).not.toBe(first?.id);
    expect(await rowsFor(projectId)).toHaveLength(2);
  });

  concurrentTest("a different project gets its own row", async () => {
    const [projectA, projectB] = await Promise.all([
      createProject(),
      createProject(),
    ]);

    const first = await resolveTaskExecutionConfig(
      inlineConfig(projectA),
      deps,
    );
    const second = await resolveTaskExecutionConfig(
      inlineConfig(projectB),
      deps,
    );

    expect(second?.id).not.toBe(first?.id);
    expect(second?.contentHash()).toBe(first?.contentHash());
    expect(second?.projectId).toBe(projectB);
  });

  concurrentTest("concurrent findOrCreate stores one row", async () => {
    const projectId = await createProject();
    const candidates = Array.from({ length: 8 }, () =>
      TaskExecutionConfigEntity.create({
        projectId,
        content: {
          environment: {
            kind: "inline",
            runtime: { kind: "managed", id: "bun1" },
          },
          git: { mode: "readOnly" },
          mcp: null,
          healthChecks: null,
        },
      }),
    );

    const results = await Promise.all(
      candidates.map((candidate) =>
        getDb().transaction(
          async (tx) =>
            await taskExecutionConfigRepo.findOrCreate(candidate, tx),
        ),
      ),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await rowsFor(projectId)).toHaveLength(1);
  });

  concurrentTest("an all-default config resolves to null", async () => {
    const projectId = await createProject();

    const resolved = await resolveTaskExecutionConfig(
      {
        projectId,
        environment: null,
        repo: { mode: "readWrite" },
        opencodeMcpJson: {},
        healthChecksJson: [],
      },
      deps,
    );

    expect(resolved).toBeNull();
    expect(await rowsFor(projectId)).toHaveLength(0);
  });

  concurrentTest("loadMany returns every requested row", async () => {
    const projectId = await createProject();
    const first = await resolveTaskExecutionConfig(
      inlineConfig(projectId),
      deps,
    );
    const second = await resolveTaskExecutionConfig(
      { projectId, environment: { kind: "inline", runtime: { kind: "host" } } },
      deps,
    );
    const ids = [first?.id, second?.id].filter((id) => id !== undefined);

    const loaded = await taskExecutionConfigRepo.loadMany(ids);

    expect(loaded.map((config) => config.id).sort()).toEqual([...ids].sort());
    expect(await taskExecutionConfigRepo.loadMany([])).toEqual([]);
  });

  concurrentTest(
    "a read rejects a malformed row with a clear error",
    async () => {
      const projectId = await createProject();
      const id = await insertRawRow(projectId, {
        environmentJson: { kind: "inline", runtime: { kind: "kubernetes" } },
      });

      const error = await rejectionOf(taskExecutionConfigRepo.load(id));

      expect(error).toBeInstanceOf(PersistenceError);
      expect(error).toMatchObject({
        code: "TASK_EXECUTION_CONFIG_ROW_UNREADABLE",
      });
      expect((error as PersistenceError).message).toContain(
        `task execution config ${id} is unreadable`,
      );
      expect((error as PersistenceError).message).toContain("runtime");
    },
  );

  concurrentTest("a read rejects an unknown schema version", async () => {
    const projectId = await createProject();
    const id = await insertRawRow(projectId, { schemaVersion: 99 });

    const error = await rejectionOf(taskExecutionConfigRepo.load(id));

    expect((error as PersistenceError).message).toContain(
      "unknown schema_version 99",
    );
  });
});

describe("task execution config stored versions", () => {
  concurrentTest(
    "reads the v1 fixture through the versioned row mapper",
    async () => {
      const projectId = await createProject();
      const loaded = taskExecutionConfigFromRow({
        ...v1Fixture,
        id: createUuidV7(),
        projectId,
        contentHash: crypto.randomUUID(),
        createdAt: new Date(),
      });

      expect<object>(loaded.content()).toEqual({
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: v1Fixture.runtimeJson.configPath,
          },
          vars: v1Fixture.envJson,
        },
        git: {
          ...v1Fixture.gitJson,
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        mcp: v1Fixture.mcpJson,
        healthChecks: v1Fixture.healthChecksJson,
      });
    },
  );

  concurrentTest(
    "reads the v1 fixture with gitCredentials through the versioned row mapper",
    async () => {
      const projectId = await createProject();
      const loaded = taskExecutionConfigFromRow({
        ...v1GitCredentialsFixture,
        id: createUuidV7(),
        projectId,
        contentHash: crypto.randomUUID(),
        createdAt: new Date(),
      });

      expect<object>(loaded.content()).toEqual({
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: v1GitCredentialsFixture.runtimeJson.configPath,
          },
          vars: v1GitCredentialsFixture.envJson,
        },
        git: {
          ...v1GitCredentialsFixture.gitJson,
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        mcp: v1GitCredentialsFixture.mcpJson,
        healthChecks: v1GitCredentialsFixture.healthChecksJson,
      });
    },
  );

  concurrentTest(
    "gitCredentials none survives resolve, store and load",
    async () => {
      const projectId = await createProject();

      const resolved = await resolveTaskExecutionConfig(
        {
          ...inlineConfig(projectId),
          repo: { mode: "readOnly", gitCredentials: "none" },
        },
        deps,
      );
      const loaded = await taskExecutionConfigRepo.load(
        resolved?.id ?? createUuidV7(),
      );

      expect(resolved?.git).toEqual({
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      });
      expect(loaded?.toJSON()).toEqual(resolved?.toJSON());
      expect(loaded?.contentHash()).toBe(resolved?.contentHash());

      const withoutCredentials = await resolveTaskExecutionConfig(
        inlineConfig(projectId),
        deps,
      );
      expect(withoutCredentials?.id).not.toBe(resolved?.id);
    },
  );
});
