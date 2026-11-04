import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushFromDirectory } from "../src/push/push-from-directory";
import {
  BASE_URL,
  makeMockFetch,
  STEP_A_JS,
  STEP_AND_PIPELINE_JS,
  PIPELINE_DOCUMENT,
  type CapturedRequest,
} from "./push-from-directory-fixtures";

const isPipelineWrite = (r: CapturedRequest) =>
  r.method === "POST" && r.url.includes("/api/pipeline-definitions");

describe("pushFromDirectory", () => {
  const previousFetch = globalThis.fetch;
  let dir: string;
  const captured: CapturedRequest[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scarn-pfd-test-"));
    writeFileSync(
      join(dir, "investigation.js"),
      STEP_AND_PIPELINE_JS("investigation"),
    );

    globalThis.fetch = makeMockFetch(captured);
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test("upserts the steps discovered in the directory and ignores unbuilt pipeline sources", async () => {
    const result = await pushFromDirectory(dir, {
      baseUrl: BASE_URL,
      projectId: "proj-1",
      accessToken: "abc123",
      log: () => undefined,
    });

    expect(result.pushedSteps).toBe(1);
    expect(result.publishedPipelines).toEqual([]);

    const stepUpsert = captured.find(
      (r) => r.method === "PUT" && r.url.endsWith("/api/step-definitions"),
    );
    expect(stepUpsert).toBeDefined();
    if (!stepUpsert) throw new Error("expected stepUpsert");
    expect(stepUpsert.body).toMatchObject({
      projectId: "proj-1",
      key: "step-a",
      version: 1,
    });

    expect(
      captured.filter((r) => r.url.includes("/pipeline-definitions")),
    ).toEqual([]);
  });

  test("skips push.ts even when present", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "scarn-pfd-skip-"));
    const previous2 = globalThis.fetch;
    globalThis.fetch = makeMockFetch([]);
    try {
      writeFileSync(
        join(dir2, "push.ts"),
        `throw new Error("should not be loaded");`,
      );
      writeFileSync(
        join(dir2, "investigation.js"),
        STEP_AND_PIPELINE_JS("investigation-2"),
      );
      const result = await pushFromDirectory(dir2, {
        baseUrl: BASE_URL,
        projectId: "proj-2",
        accessToken: "tok",
        log: () => undefined,
      });
      expect(result.pushedSteps).toBe(1);
    } finally {
      globalThis.fetch = previous2;
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// Publishing a pipeline needs its steps on the server: one push has to do
// both, in that order.
describe("pushFromDirectory publishing built pipelines", () => {
  const previousFetch = globalThis.fetch;
  let dir: string;
  const captured: CapturedRequest[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scarn-pfd-publish-"));
    writeFileSync(join(dir, "steps.js"), STEP_A_JS);
    writeFileSync(
      join(dir, "triage.json"),
      JSON.stringify(PIPELINE_DOCUMENT("triage", "Triage")),
    );
    writeFileSync(
      join(dir, "escalate.json"),
      JSON.stringify(PIPELINE_DOCUMENT("escalate", "Escalate")),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ rows: [] }));
    globalThis.fetch = makeMockFetch(captured);
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const push = () =>
    pushFromDirectory(dir, {
      baseUrl: BASE_URL,
      projectId: "proj-5",
      accessToken: "tok",
      log: () => undefined,
    });

  test("creates every built pipeline after the steps, on a fresh project", async () => {
    const result = await push();

    expect(result).toEqual({
      pushedSteps: 1,
      publishedPipelines: ["escalate", "triage"],
      unchangedPipelines: [],
      publishedAutomations: [],
      unchangedAutomations: [],
    });

    const order = captured
      .filter((r) => r.method !== "GET")
      .map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(order).toEqual([
      "PUT /api/step-definitions",
      "POST /api/pipeline-definitions",
      "POST /api/pipeline-definitions",
    ]);
    expect(captured.filter(isPipelineWrite).map((r) => r.body)).toEqual([
      {
        projectId: "proj-5",
        key: "escalate",
        name: "Escalate",
        document: PIPELINE_DOCUMENT("escalate", "Escalate"),
      },
      {
        projectId: "proj-5",
        key: "triage",
        name: "Triage",
        document: PIPELINE_DOCUMENT("triage", "Triage"),
      },
    ]);
  });

  test("a second push publishes existing pipelines as versions and reports unchanged ones", async () => {
    writeFileSync(
      join(dir, "triage.json"),
      JSON.stringify(PIPELINE_DOCUMENT("triage", "Triage, revised")),
    );
    captured.length = 0;

    const result = await push();

    expect(result.publishedPipelines).toEqual(["triage"]);
    expect(result.unchangedPipelines).toEqual(["escalate"]);
    expect(
      captured
        .filter(isPipelineWrite)
        .map((r) => new URL(r.url).pathname)
        .every((path) => path.endsWith("/versions")),
    ).toBe(true);
  });
});

// The validator has to run for real users at push time, not only in fixtures,
// and it has to run before the first write — a batch that half-pushes and then
// rejects is worse than one that rejects.
describe("pushFromDirectory offline validation", () => {
  const previousFetch = globalThis.fetch;
  let dir: string;
  const captured: CapturedRequest[] = [];

  const STEP_WITH_ARTIFACT_IN_ARRAY = `
    export const step = {
      key: "step-a",
      name: "Step A",
      description: null,
      version: 1,
      kind: "user_defined",
      status: "active",
      prompt: null,
      inputSchemaJson: null,
      resultSchemaJson: {
        type: "object",
        properties: {
          shots: {
            type: "array",
            items: { type: "string", "x-scarn-artifact": { accept: [".png"] } },
          },
        },
        required: ["shots"],
      },
      opencodeMcpJson: null,
    };
  `;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scarn-pfd-validate-"));
    writeFileSync(join(dir, "steps.js"), STEP_WITH_ARTIFACT_IN_ARRAY);
    globalThis.fetch = makeMockFetch(captured);
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects an invalid step without writing anything", async () => {
    let caught: unknown;
    try {
      await pushFromDirectory(dir, {
        baseUrl: BASE_URL,
        projectId: "proj-4",
        accessToken: "tok",
        log: () => undefined,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('Step "step-a"');
    expect(message).toContain('artifact field "shots[]"');

    expect(captured.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("rejects a pipeline document with no key without writing anything", async () => {
    const badDir = mkdtempSync(join(tmpdir(), "scarn-pfd-nokey-"));
    const requests: CapturedRequest[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = makeMockFetch(requests);
    try {
      writeFileSync(join(badDir, "steps.js"), STEP_A_JS);
      writeFileSync(
        join(badDir, "broken.json"),
        JSON.stringify({ schemaVersion: 1, nodes: {} }),
      );
      let caught: unknown;
      try {
        await pushFromDirectory(badDir, {
          baseUrl: BASE_URL,
          projectId: "proj-6",
          accessToken: "tok",
          log: () => undefined,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('broken.json has no "key"');
      expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    } finally {
      globalThis.fetch = previous;
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});
