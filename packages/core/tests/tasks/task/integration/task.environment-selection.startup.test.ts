import { describe, expect } from "bun:test";
import type { EnvironmentContentInput } from "@/common/contracts/environment";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { environmentContent } from "tests/pipeline-definitions/environment/integration/environment-test-support";
import {
  expect422,
  fromStep,
  useEnvironmentSelectionProject,
} from "./task-environment-selection-test-support";

const TICKET_VALUE = {
  name: "TICKET",
  source: "value" as const,
  value: "main",
  secret: false,
};

describe("starting a run of a Task with an environment selection", () => {
  const {
    publish,
    deleteEnvironment,
    putStep,
    postTask,
    claim,
    workerContext,
  } = useEnvironmentSelectionProject("selection-startup");

  /**
   * Starts a Task from `source` in a new environment published as
   * `created`, publishes `changed` as its next version, then builds the
   * run's worker context.
   */
  const contextAfterChange = async (
    source: Parameters<typeof postTask>[0],
    created: EnvironmentContentInput,
    changed: EnvironmentContentInput | "deleted",
    extraConnectors: {
      connectorId: string;
      vars: Record<string, never>;
    }[] = [],
  ) => {
    const name = await publish(created);
    const { task, run } = await unwrapAsync(
      postTask(source, { name, extraConnectors }),
    );
    if (!run || task.workItemId === null) throw new Error("Expected a run");
    if (changed === "deleted") await deleteEnvironment(name);
    else await publish(changed, name);
    return {
      name,
      result: await workerContext(run.id, await claim(task.workItemId, run.id)),
    };
  };

  const expectMisfit = (
    result: Awaited<ReturnType<typeof workerContext>>,
    reason: string,
  ) => {
    expect422(result, "ENVIRONMENT_OVERRIDE_INCOMPATIBLE");
    expect(result.error?.value).toMatchObject({ meta: { reason } });
  };

  concurrentTest("an environment that still fits starts the run", async () => {
    const { name, result } = await contextAfterChange(
      { prompt: "Look around" },
      environmentContent(),
      environmentContent({ description: "v2" }),
    );
    expect(result.data?.runtime.environment).toMatchObject({
      kind: "named",
      name,
      version: 2,
    });
  });

  concurrentTest(
    "a code step whose environment became host fails to start",
    async () => {
      const step = await putStep({
        kind: "code",
        prompt: undefined,
        entrypointJson: { sourceFile: ".scarn/steps/lookup.ts" },
        resultSchemaJson: { type: "object" },
      });
      const { result } = await contextAfterChange(
        fromStep(step),
        environmentContent(),
        environmentContent({ runtime: { kind: "host" }, vars: [] }),
      );
      expectMisfit(result, "code_step_host_runtime");
    },
  );

  concurrentTest(
    "an environment that gained a connector a step mcps key uses fails to start",
    async () => {
      const step = await putStep({
        opencodeMcpJson: {
          playwright: { type: "local", command: ["npx", "playwright-mcp"] },
        },
      });
      const { result } = await contextAfterChange(
        fromStep(step),
        environmentContent(),
        environmentContent({ connectors: ["playwright"] }),
      );
      expectMisfit(result, "connector_mcp_collision");
    },
  );

  concurrentTest(
    "an environment whose base branch var became secret fails to start",
    async () => {
      const stepEnvironment = await publish(
        environmentContent({ vars: [TICKET_VALUE] }),
      );
      const step = await putStep({
        environment: { kind: "named", name: stepEnvironment },
        repo: { mode: "readOnly", baseBranch: "{{env.TICKET}}" },
      });
      const { result } = await contextAfterChange(
        fromStep(step),
        environmentContent({ vars: [TICKET_VALUE] }),
        environmentContent({
          vars: [{ name: "TICKET", source: "secret", secretName: "TICKET" }],
        }),
      );
      expectMisfit(result, "base_branch_env");
    },
  );

  concurrentTest(
    "a deleted environment reaches the worker as not found",
    async () => {
      const { name, result } = await contextAfterChange(
        { prompt: "Look around" },
        environmentContent(),
        "deleted",
      );
      expect(result.data?.runtime.environment).toEqual({
        kind: "named",
        name,
        notFound: true,
      });
    },
  );

  concurrentTest(
    "an extra connector the environment now has fails to start",
    async () => {
      const { result } = await contextAfterChange(
        { prompt: "Look around" },
        environmentContent(),
        environmentContent({ connectors: ["playwright"] }),
        [{ connectorId: "playwright", vars: {} }],
      );
      expect422(result, "CONNECTOR_ALREADY_PRESENT");
    },
  );
});
