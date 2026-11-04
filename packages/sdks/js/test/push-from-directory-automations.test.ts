import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushFromDirectory } from "../src/push/push-from-directory";
import {
  BASE_URL,
  json,
  makeMockFetch,
  PIPELINE_DOCUMENT,
  STEP_A_JS,
  type CapturedRequest,
} from "./push-from-directory-fixtures";

const AUTOMATION_DOCUMENT = (
  key: string,
  scope: "workItem" | "project",
  title = key,
) => ({
  kind: "automation",
  schemaVersion: 1,
  key,
  title,
  scope,
  rules: [],
});

const isAutomationWrite = (r: CapturedRequest) =>
  r.method === "PUT" && r.url.includes("/automations/");

// A project automation's `attach` targets must exist before it publishes, so
// work-item automations go first, whatever their file names.
describe("pushFromDirectory publishing built automations", () => {
  const previousFetch = globalThis.fetch;
  let dir: string;
  const captured: CapturedRequest[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scarn-pfd-automations-"));
    writeFileSync(join(dir, "steps.js"), STEP_A_JS);
    writeFileSync(
      join(dir, "triage.json"),
      JSON.stringify(PIPELINE_DOCUMENT("triage", "Triage")),
    );
    writeFileSync(
      join(dir, "attach-wayfinder.json"),
      JSON.stringify(AUTOMATION_DOCUMENT("attach-wayfinder", "project")),
    );
    writeFileSync(
      join(dir, "wayfinder.json"),
      JSON.stringify(AUTOMATION_DOCUMENT("wayfinder", "workItem")),
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
      projectId: "proj-7",
      accessToken: "tok",
      log: () => undefined,
    });

  test("publishes automations after the pipelines, work-item ones first", async () => {
    const result = await push();

    expect(result.publishedPipelines).toEqual(["triage"]);
    expect(result.publishedAutomations).toEqual([
      "wayfinder",
      "attach-wayfinder",
    ]);
    expect(result.unchangedAutomations).toEqual([]);

    const order = captured
      .filter((r) => r.method !== "GET")
      .map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(order).toEqual([
      "PUT /api/step-definitions",
      "POST /api/pipeline-definitions",
      "PUT /api/projects/proj-7/automations/wayfinder",
      "PUT /api/projects/proj-7/automations/attach-wayfinder",
    ]);
    expect(captured.filter(isAutomationWrite).map((r) => r.body)).toEqual([
      { document: AUTOMATION_DOCUMENT("wayfinder", "workItem") },
      { document: AUTOMATION_DOCUMENT("attach-wayfinder", "project") },
    ]);
  });

  test("a second push reports unchanged automations and publishes changed ones", async () => {
    writeFileSync(
      join(dir, "wayfinder.json"),
      JSON.stringify(
        AUTOMATION_DOCUMENT("wayfinder", "workItem", "Wayfinder, revised"),
      ),
    );

    const result = await push();

    expect(result.publishedAutomations).toEqual(["wayfinder"]);
    expect(result.unchangedAutomations).toEqual(["attach-wayfinder"]);
  });

  test("a rejected automation document fails the push with its issues", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const req = input as Request;
      if (req.method === "PUT" && req.url.includes("/automations/")) {
        return json(
          {
            title: "Validation failed",
            detail: "Automation document is invalid",
            code: "AUTOMATION_DOCUMENT_INVALID",
            meta: {
              errors: [
                {
                  code: "unknown_pipeline",
                  path: "/rules/0/next/routes/0/to",
                  message: 'No pipeline "nope"',
                  hint: "Publish it first",
                },
              ],
            },
          },
          422,
        );
      }
      return previous(input);
    }) as unknown as typeof globalThis.fetch;
    try {
      let message: string | undefined;
      try {
        await push();
      } catch (error) {
        message = error instanceof Error ? error.message : undefined;
      }
      expect(message).toBe(
        [
          "Could not publish wayfinder.json: Automation document is invalid",
          '  /rules/0/next/routes/0/to: No pipeline "nope". Publish it first',
        ].join("\n"),
      );
    } finally {
      globalThis.fetch = previous;
    }
  });
});
