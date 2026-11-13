import { describe, expect, test } from "bun:test";
import { formatPipelineShow } from "../src/format-pipeline";
import { gatherPipelineShow } from "../src/gather-pipeline";
import type { PipelineVersion } from "../src/lib/pipeline-api-types";
import type { PipelineReadClient } from "../src/lib/pipeline-read-client";

const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const PIPELINE_ID = "0196a000-0000-7000-8000-0000000000d1";
const STEP_ID = "0196a000-0000-7000-8000-0000000000e1";
const headers = { Authorization: "Bearer test" };

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
          title: "Build it",
          step: "build",
          maxRuns: 3,
          next: {
            routes: [
              {
                when: { path: "build.result.ok", op: "equal", value: true },
                to: "approve",
              },
            ],
            otherwise: { to: "failed" },
          },
          catch: [{ on: ["Timeout"], to: "failed" }],
        },
        approve: {
          kind: "wait",
          for: "decision",
          actions: [
            { key: "ship", label: "Ship" },
            { key: "stop", label: "Stop" },
          ],
          next: { routes: [{ to: "done" }] },
        },
        done: { kind: "succeed" },
        failed: { kind: "fail", error: "BuildFailed" },
      },
    },
    steps: [{ stepKey: "build", stepDefinitionId: STEP_ID }],
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

type Calls = { versionPaths: unknown[] };

function fakeClient(calls: Calls): PipelineReadClient {
  return {
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
        calls.versionPaths.push(path);
        return ok(pipelineVersion(path.version));
      },
    },
    stepDefinitions: {
      getStepDefinition: ({ path }) =>
        ok({
          id: path.stepDefinitionId,
          key: "build",
          name: "Build",
          version: 4,
          kind: "user_defined",
        }),
    },
  };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the promise to reject");
}

describe("pipelines show", () => {
  test("shows the active version's nodes and edges", async () => {
    const calls: Calls = { versionPaths: [] };
    const gathered = await gatherPipelineShow({
      client: fakeClient(calls),
      headers,
      projectId: PROJECT_ID,
      pipeline: "ship-it",
    });

    expect(calls.versionPaths).toEqual([]);
    expect(gathered.isActive).toBe(true);
    expect(formatPipelineShow(gathered)).toMatchInlineSnapshot(`
      "Pipeline ship-it  "Ship it"
      Id:      0196a000-0000-7000-8000-0000000000d1
      Version: 2 (active)  published 2026-01-02T00:00:00.000Z  hash abcdef012345

      Start  → build

      Nodes (4)
        step    build  "Build it"
                step build v4 "Build" (user_defined, 0196a000-0000-7000-8000-0000000000e1)  maxRuns 3
                → approve  when (first match)
                → failed  otherwise
                → failed  catch Timeout
        wait    approve
                wait for decision  actions ship, stop
                → done
        succeed done
                succeed
        fail    failed
                fail with BuildFailed

      → scarn runs list --pipeline ship-it
      → scarn pipelines show ship-it --json"
    `);
  });

  test("--version fetches that version, found by id", async () => {
    const calls: Calls = { versionPaths: [] };
    const gathered = await gatherPipelineShow({
      client: fakeClient(calls),
      headers,
      projectId: PROJECT_ID,
      pipeline: PIPELINE_ID,
      version: 1,
    });

    expect(calls.versionPaths).toEqual([
      { pipelineDefinitionId: PIPELINE_ID, version: 1 },
    ]);
    expect(gathered.isActive).toBe(false);
    const text = formatPipelineShow(gathered);
    expect(text).toContain("Version: 1 (not active)");
    expect(text).toContain("→ scarn pipelines show ship-it --version 1 --json");
  });

  test("an unknown pipeline names the known ones", async () => {
    const calls: Calls = { versionPaths: [] };
    expect(
      await rejectionMessage(
        gatherPipelineShow({
          client: fakeClient(calls),
          headers,
          projectId: PROJECT_ID,
          pipeline: "nope",
        }),
      ),
    ).toBe('No pipeline "nope" in this project. Pipelines: ship-it.');
  });

  test("a pinned step that fails to load is marked unavailable", async () => {
    const calls: Calls = { versionPaths: [] };
    const client = fakeClient(calls);
    client.stepDefinitions.getStepDefinition = () =>
      Promise.resolve({
        data: undefined,
        error: { title: "Forbidden", status: 403 },
      });
    const gathered = await gatherPipelineShow({
      client,
      headers,
      projectId: PROJECT_ID,
      pipeline: "ship-it",
    });

    expect(formatPipelineShow(gathered)).toContain(
      "step build 0196a000…00e1 (unavailable: Forbidden)",
    );
  });
});
