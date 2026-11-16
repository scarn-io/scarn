/**
 * Environment connectors on the launch path: `planStepMcpServers` adds each
 * catalog connector under its id beside the step's own servers, a step key
 * that reuses a connector id fails the launch, and a repository server that
 * shares a connector's name is replaced rather than counted as a collision.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CONNECTOR_CATALOG,
  ConnectorMcpCollision,
} from "@scarn/sdk/connectors";
import { planStepMcpServers } from "../../../../src/work/task-run/infra/resolve-launch-mcp-servers";

describe("planStepMcpServers with connectors", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "connectors-ws-"));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  test("merges catalog connectors with the step's servers", async () => {
    const plan = await planStepMcpServers({
      servers: { mine: { type: "local", command: ["mine"] } },
      connectors: ["datadog", "playwright"],
      workspacePath,
      sessionId: "s",
    });
    expect(Object.keys(plan.servers ?? {}).sort()).toEqual([
      "datadog",
      "mine",
      "playwright",
    ]);
    expect(plan.servers?.["datadog"]).toEqual(
      CONNECTOR_CATALOG["datadog"]?.mcp,
    );
  });

  test("a step mcps key that reuses a connector id fails", async () => {
    let error: Error | undefined;
    try {
      await planStepMcpServers({
        servers: { datadog: { type: "remote", url: "https://x.test/mcp" } },
        connectors: ["datadog"],
        workspacePath,
        sessionId: "s",
      });
    } catch (caught) {
      if (caught instanceof Error) error = caught;
    }
    expect(error).toBeInstanceOf(ConnectorMcpCollision);
    expect(error?.message).toContain('step mcps "datadog" collide');
  });

  test("a repository server named like a connector is replaced by it", async () => {
    await writeFile(
      path.join(workspacePath, ".mcp.json"),
      JSON.stringify({
        mcpServers: { playwright: { command: "repo-playwright" } },
      }),
    );
    const plan = await planStepMcpServers({
      servers: null,
      connectors: ["playwright"],
      workspacePath,
      sessionId: "s",
    });
    expect(plan.servers?.["playwright"]).toEqual(
      CONNECTOR_CATALOG["playwright"]?.mcp,
    );
  });
});
