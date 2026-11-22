import { describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  environmentContent,
  uniqueEnvironmentName,
} from "tests/pipeline-definitions/environment/integration/environment-test-support";
import {
  expect422,
  fromStep,
  useEnvironmentSelectionProject,
} from "./task-environment-selection-test-support";

describe("starting a Task in a chosen environment", () => {
  const { publish, deleteEnvironment, putStep, postTask, configOf } =
    useEnvironmentSelectionProject("environment-override");

  describe("prompt Tasks", () => {
    concurrentTest(
      "without an environment run on the repo default, read-only, with no selection",
      async () => {
        const { task } = await unwrapAsync(postTask({ prompt: "Look around" }));
        expect(await configOf(task.taskExecutionConfigId)).toMatchObject({
          environment: null,
          git: { mode: "readOnly" },
          mcp: null,
        });
        expect(task.environmentSelection).toBeNull();
      },
    );

    concurrentTest(
      "with an override run in a derived config naming the environment",
      async () => {
        const name = await publish();
        const { task } = await unwrapAsync(
          postTask({ prompt: "Look around" }, { name }),
        );
        expect(await configOf(task.taskExecutionConfigId)).toMatchObject({
          environment: { kind: "named", name },
          git: { mode: "readOnly" },
          mcp: null,
        });
      },
    );

    concurrentTest(
      "two Tasks with the same override share one derived config",
      async () => {
        const name = await publish();
        const first = await unwrapAsync(postTask({ prompt: "One" }, { name }));
        const second = await unwrapAsync(postTask({ prompt: "Two" }, { name }));
        expect(first.task.taskExecutionConfigId).not.toBeNull();
        expect(second.task.taskExecutionConfigId).toBe(
          first.task.taskExecutionConfigId,
        );
      },
    );

    concurrentTest("an unknown environment is a 422", async () => {
      expect422(
        await postTask(
          { prompt: "Look around" },
          { name: uniqueEnvironmentName() },
        ),
        "ENVIRONMENT_NOT_FOUND",
      );
    });

    concurrentTest("a deleted environment is a 422", async () => {
      const name = await publish();
      await deleteEnvironment(name);
      expect422(
        await postTask({ prompt: "Look around" }, { name }),
        "ENVIRONMENT_NOT_FOUND",
      );
    });
  });

  describe("step Tasks", () => {
    concurrentTest(
      "without an environment keep the step's config",
      async () => {
        const name = await publish();
        const step = await putStep({ environment: { kind: "named", name } });
        const { task } = await unwrapAsync(postTask(fromStep(step)));
        expect(await configOf(task.taskExecutionConfigId)).toMatchObject({
          environment: { kind: "named", name },
        });
        expect(task.environmentSelection).toBeNull();
      },
    );

    concurrentTest(
      "with an override keep the step's repo and mcps in the derived config",
      async () => {
        const stepEnvironment = await publish();
        const override = await publish();
        const step = await putStep({
          environment: { kind: "named", name: stepEnvironment },
          repo: { mode: "readOnly" },
          opencodeMcpJson: {
            docs: { type: "remote", url: "https://docs.example.com/mcp" },
          },
        });
        const { task } = await unwrapAsync(
          postTask(fromStep(step), { name: override }),
        );
        expect(await configOf(task.taskExecutionConfigId)).toMatchObject({
          environment: { kind: "named", name: override },
          git: { mode: "readOnly" },
          mcp: { docs: { type: "remote" } },
        });
      },
    );

    concurrentTest(
      "an inline step environment can't be overridden",
      async () => {
        const name = await publish();
        const step = await putStep({
          environment: { kind: "inline", runtime: { kind: "devcontainer" } },
        });
        expect422(
          await postTask(fromStep(step), { name }),
          "ENVIRONMENT_OVERRIDE_INLINE",
        );
      },
    );

    concurrentTest("a code step can't get a host environment", async () => {
      const name = await publish(
        environmentContent({ runtime: { kind: "host" }, vars: [] }),
      );
      const step = await putStep({
        kind: "code",
        prompt: undefined,
        entrypointJson: { sourceFile: ".scarn/steps/lookup.ts" },
        resultSchemaJson: { type: "object" },
      });
      const result = await postTask(fromStep(step), { name });
      expect422(result, "ENVIRONMENT_OVERRIDE_INCOMPATIBLE");
      expect(result.error?.value).toMatchObject({
        meta: { reason: "code_step_host_runtime" },
      });
    });

    concurrentTest(
      "a step mcps key can't collide with an environment connector",
      async () => {
        const name = await publish(
          environmentContent({ connectors: ["playwright"] }),
        );
        const step = await putStep({
          opencodeMcpJson: {
            playwright: { type: "local", command: ["npx", "playwright-mcp"] },
          },
        });
        const result = await postTask(fromStep(step), { name });
        expect422(result, "ENVIRONMENT_OVERRIDE_INCOMPATIBLE");
        expect(result.error?.value).toMatchObject({
          meta: { reason: "connector_mcp_collision" },
        });
      },
    );

    concurrentTest(
      "every {{env.X}} in the step's base branch must be a non-secret var of the environment",
      async () => {
        const fits = await publish(
          environmentContent({
            vars: [
              { name: "TICKET", source: "value", value: "main", secret: false },
            ],
          }),
        );
        const secret = await publish(
          environmentContent({
            vars: [{ name: "TICKET", source: "secret", secretName: "TICKET" }],
          }),
        );
        const undeclared = await publish();
        const step = await putStep({
          environment: { kind: "named", name: fits },
          repo: { mode: "readOnly", baseBranch: "{{env.TICKET}}" },
        });
        await unwrapAsync(postTask(fromStep(step), { name: fits }));
        for (const name of [secret, undeclared]) {
          const result = await postTask(fromStep(step), { name });
          expect422(result, "ENVIRONMENT_OVERRIDE_INCOMPATIBLE");
          expect(result.error?.value).toMatchObject({
            meta: { reason: "base_branch_env" },
          });
        }
      },
    );
  });
});
