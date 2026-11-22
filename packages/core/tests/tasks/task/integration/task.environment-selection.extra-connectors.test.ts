import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { environmentContent } from "tests/pipeline-definitions/environment/integration/environment-test-support";
import {
  expect422,
  fromStep,
  useEnvironmentSelectionProject,
} from "./task-environment-selection-test-support";

const DATADOG_VARS = {
  DD_API_KEY: { secret: "DATADOG_STAGING_KEY" },
  DD_APPLICATION_KEY: { secret: "DATADOG_STAGING_APP_KEY" },
};

const playwright = { connectorId: "playwright", vars: {} };

describe("starting a Task with extra connectors", () => {
  const { publish, putStep, postTask, getTask } =
    useEnvironmentSelectionProject("extra-connectors");

  concurrentTest("extra connectors are stored on the Task", async () => {
    const extraConnectors = [
      { connectorId: "datadog", vars: DATADOG_VARS },
      playwright,
    ];
    const { task } = await unwrapAsync(
      postTask({ prompt: "Look around" }, { extraConnectors }),
    );
    expect(task.environmentSelection).toEqual({ extraConnectors });

    const [row] = await getDb()
      .select({ selection: tasks.environmentSelectionJson })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(row?.selection).toEqual({ schemaVersion: 1, extraConnectors });

    const loaded = await getTask(task.id);
    expect(loaded.environmentSelection).toEqual({ extraConnectors });
  });

  concurrentTest("an unknown connector is a 422", async () => {
    expect422(
      await postTask(
        { prompt: "Look around" },
        { extraConnectors: [{ connectorId: "nope", vars: {} }] },
      ),
      "CONNECTOR_NOT_FOUND",
    );
  });

  concurrentTest(
    "a connector already in the override environment is a 422",
    async () => {
      const name = await publish(
        environmentContent({ connectors: ["playwright"] }),
      );
      expect422(
        await postTask(
          { prompt: "Look around" },
          { name, extraConnectors: [playwright] },
        ),
        "CONNECTOR_ALREADY_PRESENT",
      );
    },
  );

  concurrentTest(
    "a connector already in the step's environment is a 422",
    async () => {
      const name = await publish(
        environmentContent({ connectors: ["playwright"] }),
      );
      const step = await putStep({ environment: { kind: "named", name } });
      expect422(
        await postTask(fromStep(step), { extraConnectors: [playwright] }),
        "CONNECTOR_ALREADY_PRESENT",
      );
    },
  );

  concurrentTest("a connector matching a step mcps key is a 422", async () => {
    const step = await putStep({
      opencodeMcpJson: {
        playwright: { type: "local", command: ["npx", "playwright-mcp"] },
      },
    });
    expect422(
      await postTask(fromStep(step), { extraConnectors: [playwright] }),
      "CONNECTOR_ALREADY_PRESENT",
    );
  });

  concurrentTest("a connector listed twice is a 422", async () => {
    expect422(
      await postTask(
        { prompt: "Look around" },
        { extraConnectors: [playwright, playwright] },
      ),
      "CONNECTOR_ALREADY_PRESENT",
    );
  });

  concurrentTest("a required var with no secret is a 422", async () => {
    expect422(
      await postTask(
        { prompt: "Look around" },
        {
          extraConnectors: [
            {
              connectorId: "datadog",
              vars: { DD_API_KEY: DATADOG_VARS.DD_API_KEY },
            },
          ],
        },
      ),
      "CONNECTOR_VAR_MISSING",
    );
  });

  concurrentTest(
    "a required var the environment already provides needs no secret",
    async () => {
      const name = await publish(
        environmentContent({
          vars: [
            { name: "DD_API_KEY", source: "secret", secretName: "DD_API_KEY" },
          ],
        }),
      );
      const { task } = await unwrapAsync(
        postTask(
          { prompt: "Look around" },
          {
            name,
            extraConnectors: [
              {
                connectorId: "datadog",
                vars: {
                  DD_APPLICATION_KEY: DATADOG_VARS.DD_APPLICATION_KEY,
                },
              },
            ],
          },
        ),
      );
      expect(task.environmentSelection?.extraConnectors).toHaveLength(1);
    },
  );
});
