import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushFromDirectory } from "../src/push/push-from-directory";

type CapturedRequest = {
  url: string;
  method: string;
  body: unknown;
};

async function readRequest(
  input: string | URL | Request,
): Promise<CapturedRequest> {
  const req = input as Request;
  const text = await req.clone().text();
  return {
    url: req.url,
    method: req.method,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
}

const BASE_URL = "https://scarn.example.com";

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ServerPipeline = {
  id: string;
  key: string;
  versions: string[];
};

/**
 * Mock fetch that records every request and keeps just enough server state
 * for a push: upserted steps, and pipelines whose versions are compared by
 * serialized document, the way the server compares content hashes.
 */
function makeMockFetch(captured: CapturedRequest[]): typeof globalThis.fetch {
  const upsertedSteps: Array<{ id: string; key: string; version: number }> = [];
  const pipelines: ServerPipeline[] = [];
  let nextId = 1;

  const versionContract = (pipeline: ServerPipeline) => ({
    id: `${pipeline.id}-v${String(pipeline.versions.length)}`,
    pipelineDefinitionId: pipeline.id,
    version: pipeline.versions.length,
  });
  const pipelineContract = (pipeline: ServerPipeline) => ({
    id: pipeline.id,
    key: pipeline.key,
    currentVersion: versionContract(pipeline),
  });

  return (async (input: string | URL | Request) => {
    const req = await readRequest(input);
    captured.push(req);
    const path = new URL(req.url).pathname;

    if (req.method === "GET" && path === "/api/step-definitions") {
      return json(upsertedSteps);
    }
    if (req.method === "PUT" && path === "/api/step-definitions") {
      const body = req.body as { key: string; version: number };
      const id = `step-${String(nextId++)}`;
      upsertedSteps.push({ id, key: body.key, version: body.version });
      return json({ id, key: body.key, version: body.version });
    }
    if (req.method === "GET" && path.endsWith("/pipeline-definitions")) {
      return json(pipelines.map(pipelineContract));
    }
    if (req.method === "POST" && path === "/api/pipeline-definitions") {
      const body = req.body as { key: string; document: unknown };
      const pipeline: ServerPipeline = {
        id: `pipe-${String(nextId++)}`,
        key: body.key,
        versions: [JSON.stringify(body.document)],
      };
      pipelines.push(pipeline);
      return json(pipelineContract(pipeline));
    }
    const versions = /^\/api\/pipeline-definitions\/([^/]+)\/versions$/.exec(
      path,
    );
    if (req.method === "POST" && versions) {
      const pipeline = pipelines.find((p) => p.id === versions[1]);
      if (!pipeline) return json({ title: "Not found" }, 404);
      const document = JSON.stringify(
        (req.body as { document: unknown }).document,
      );
      const published = pipeline.versions.at(-1) !== document;
      if (published) pipeline.versions.push(document);
      return json({
        published,
        version: versionContract(pipeline),
        pipelineDefinition: pipelineContract(pipeline),
      });
    }
    if (req.method === "GET") {
      return json([]);
    }
    return json({ id: "x" });
  }) as unknown as typeof globalThis.fetch;
}

const STEP_A_JS = `
export const stepA = {
  key: "step-a",
  name: "Step A",
  description: null,
  version: 1,
  kind: "user_defined",
  status: "active",
  prompt: null,
  inputSchemaJson: null,
  resultSchemaJson: null,
  opencodeMcpJson: null,
};
`;

const STEP_AND_PIPELINE_JS = (key: string) => `
${STEP_A_JS}
export default {
  key: ${JSON.stringify(key)},
  name: ${JSON.stringify(key)},
  start: "step-a",
  nodes: { "step-a": { type: "step", step: "step-a" } },
};
`;

const PIPELINE_DOCUMENT = (key: string, title: string) => ({
  schemaVersion: 1,
  key,
  title,
  start: { node: "a" },
  nodes: { a: { kind: "step", step: "step-a" } },
});

/** A built assignment spec; the real file imports `defaultPipelineAssignment`. */
const ASSIGNMENT_JS = (defaultKey: string, ruleKey: string) => `
export default {
  _tag: "default_pipeline_assignment",
  default: { _tag: "assign", pipelineKey: ${JSON.stringify(defaultKey)} },
  rules: [
    {
      _tag: "assignment_rule",
      mode: "all",
      conditions: [{ _tag: "leaf", fact: "workItem", path: "$.fields.demo", operator: "equal", value: "x" }],
      outcome: { _tag: "assign", pipelineKey: ${JSON.stringify(ruleKey)} },
    },
  ],
};
`;

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

// On a fresh project the assignment needs its pipelines on the server, and
// publishing a pipeline needs its steps there: one push has to do all three,
// in that order.
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
    writeFileSync(
      join(dir, "default-pipeline-assignment.ts"),
      ASSIGNMENT_JS("triage", "escalate"),
    );
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

  test("creates every built pipeline after the steps and before the assignment, on a fresh project", async () => {
    const result = await push();

    expect(result).toEqual({
      pushedSteps: 1,
      publishedPipelines: ["escalate", "triage"],
      unchangedPipelines: [],
      syncedDefaultPipelineAssignment: true,
    });

    const order = captured
      .filter((r) => r.method !== "GET")
      .map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(order).toEqual([
      "PUT /api/step-definitions",
      "POST /api/pipeline-definitions",
      "POST /api/pipeline-definitions",
      "PUT /api/projects/proj-5/default-pipeline-assignment",
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
