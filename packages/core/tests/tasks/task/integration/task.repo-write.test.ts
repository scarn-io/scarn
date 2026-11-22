import { describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { useEnvironmentSelectionProject } from "./task-environment-selection-test-support";

describe('"Allow commits" on prompt Tasks', () => {
  const { publish, postTask, configOf, claim, workerContext } =
    useEnvironmentSelectionProject("repo-write");

  const repoAtStartup = async (source: Parameters<typeof postTask>[0]) => {
    const { task, run } = await unwrapAsync(postTask(source));
    if (!run || task.workItemId === null) throw new Error("Expected a run");
    const context = await unwrapAsync(
      workerContext(run.id, await claim(task.workItemId, run.id)),
    );
    return { task, repo: context.runtime.repo };
  };

  concurrentTest(
    "without the toggle the agent gets a readOnly repo, so it can't push",
    async () => {
      const { task, repo } = await repoAtStartup({ prompt: "Look around" });
      expect(task.taskExecutionConfigId).not.toBeNull();
      expect(repo).toMatchObject({ mode: "readOnly" });
      expect(repo).not.toHaveProperty("workBranch");
    },
  );

  concurrentTest(
    "repoWrite: false is the same readOnly config as leaving it out",
    async () => {
      const left = await unwrapAsync(postTask({ prompt: "One" }));
      const off = await unwrapAsync(
        postTask({ prompt: "Two", repoWrite: false }),
      );
      expect(off.task.taskExecutionConfigId).toBe(
        left.task.taskExecutionConfigId,
      );
    },
  );

  concurrentTest(
    "with the toggle the agent gets readWrite with a new work branch",
    async () => {
      const { task, repo } = await repoAtStartup({
        prompt: "Fix it",
        repoWrite: true,
      });
      expect(task.taskExecutionConfigId).toBeNull();
      expect(repo).toMatchObject({
        mode: "readWrite",
        workBranch: { kind: "create" },
      });
    },
  );

  concurrentTest(
    "an environment override keeps the Task's repo access",
    async () => {
      const name = await publish();
      const readOnly = await unwrapAsync(
        postTask({ prompt: "Look" }, { name }),
      );
      const readWrite = await unwrapAsync(
        postTask({ prompt: "Fix", repoWrite: true }, { name }),
      );
      expect(await configOf(readOnly.task.taskExecutionConfigId)).toMatchObject(
        { environment: { kind: "named", name }, git: { mode: "readOnly" } },
      );
      expect(
        await configOf(readWrite.task.taskExecutionConfigId),
      ).toMatchObject({ environment: { kind: "named", name }, git: null });
    },
  );
});
