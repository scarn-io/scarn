import { describe, expect, setDefaultTimeout, test } from "bun:test";
import yargs from "yargs/yargs";
import type { PipelineReadClient, PipelineVersion } from "@scarn/shared-core";
import {
  createShowCommand,
  type PipelineShowDependencies,
} from "../src/commands/pipelines-show";
import { runCli } from "./utils";

setDefaultTimeout(15_000);

const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const PIPELINE_ID = "0196a000-0000-7000-8000-0000000000d1";
const STEP_ID = "0196a000-0000-7000-8000-0000000000e1";

const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });

function pipelineVersion(version: number): PipelineVersion {
  return {
    id: `version-${String(version)}`,
    pipelineDefinitionId: PIPELINE_ID,
    version,
    schemaVersion: 1,
    contentHash: "abcdef0123456789",
    definition: {
      schemaVersion: 1,
      key: "ship-it",
      start: { to: "build" },
      nodes: {
        build: {
          kind: "step",
          step: "build",
          next: { routes: [{ to: "done" }] },
        },
        done: { kind: "succeed" },
      },
    },
    steps: [{ stepKey: "build", stepDefinitionId: STEP_ID }],
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

function fakeDependencies(versionPaths: unknown[]): PipelineShowDependencies {
  const client: PipelineReadClient = {
    pipelineDefinitions: {
      listPipelineDefinitions: () =>
        ok([
          {
            id: PIPELINE_ID,
            key: "ship-it",
            name: "Ship it",
            archivedAt: null,
            currentVersion: pipelineVersion(2),
          },
        ]),
      getPipelineDefinitionVersion: ({ path }) => {
        versionPaths.push(path);
        return ok(pipelineVersion(path.version));
      },
    },
    stepDefinitions: {
      getStepDefinition: () =>
        ok({
          id: STEP_ID,
          key: "build",
          name: "Build",
          version: 1,
          kind: "user_defined",
        }),
    },
  };
  return {
    connectProject: () =>
      Promise.resolve({
        client,
        headers: { Authorization: "Bearer test" },
        projectId: PROJECT_ID,
      }),
  };
}

async function runShow(
  args: readonly string[],
): Promise<{ stdout: string; versionPaths: unknown[] }> {
  const versionPaths: unknown[] = [];
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await yargs(["show", ...args])
      .command(createShowCommand(fakeDependencies(versionPaths)))
      .strict()
      .exitProcess(false)
      .showHelpOnFail(false)
      .fail((message, error) => {
        throw error instanceof Error ? error : new Error(message);
      })
      .parseAsync();
  } finally {
    process.stdout.write = originalWrite;
  }
  return { stdout: chunks.join(""), versionPaths };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

describe("scarn pipelines show", () => {
  test("pipelines --help lists show", async () => {
    const result = await runCli(["pipelines", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("show <pipeline>");
  });

  test("prints the active version's nodes and ends with the runs hint", async () => {
    const { stdout, versionPaths } = await runShow(["ship-it"]);

    expect(versionPaths).toEqual([]);
    expect(stdout).toContain("Version: 2 (active)");
    expect(stdout).toContain('step build v1 "Build"');
    expect(stdout).toContain("→ scarn runs list --pipeline ship-it");
  });

  test("--version --json prints only that version's body", async () => {
    const { stdout, versionPaths } = await runShow([
      "ship-it",
      "--version",
      "1",
      "--json",
    ]);
    const body = JSON.parse(stdout) as PipelineVersion;

    expect(versionPaths).toEqual([
      { pipelineDefinitionId: PIPELINE_ID, version: 1 },
    ]);
    expect(body.version).toBe(1);
    expect(body.definition["key"]).toBe("ship-it");
  });

  test("rejects a non-positive --version", async () => {
    expect(
      (await rejection(runShow(["ship-it", "--version", "0"]))).message,
    ).toBe("--version must be a positive whole number, got 0.");
  });
});
