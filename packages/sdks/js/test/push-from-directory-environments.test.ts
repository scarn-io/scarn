import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pushFromDirectory } from "../src/push/push-from-directory";
import {
  AUTHORED_ENVIRONMENTS_JS,
  BASE_URL,
  CONFLICTING_FRONTEND_JS,
  FRONTEND_ENVIRONMENT_JS,
  HANDLE_STEPS_JS,
  makeMockFetch,
  type CapturedRequest,
} from "./push-from-directory-fixtures";

describe("pushFromDirectory environments", () => {
  const setup = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "scarn-pfd-environments-"));
    const dir = join(root, ".scarn/pipeline-builder");
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return { root, dir };
  };

  const run = async (
    files: Record<string, string>,
    serverEnvironments: readonly string[] = [],
  ) => {
    const { root, dir } = setup(files);
    const previousFetch = globalThis.fetch;
    const requests: CapturedRequest[] = [];
    const messages: string[] = [];
    globalThis.fetch = makeMockFetch(requests, { serverEnvironments });
    const push = () =>
      pushFromDirectory(relative(process.cwd(), dir), {
        baseUrl: BASE_URL,
        projectId: "proj-env",
        accessToken: "tok",
        log: (message) => {
          messages.push(message);
        },
      });
    try {
      let result: Awaited<ReturnType<typeof push>> | undefined;
      let error: unknown;
      try {
        result = await push();
      } catch (caught) {
        error = caught;
      }
      return { result, error, requests, messages };
    } finally {
      globalThis.fetch = previousFetch;
      rmSync(root, { recursive: true, force: true });
    }
  };

  const writes = (requests: readonly CapturedRequest[]) =>
    requests
      .filter((r) => r.method !== "GET")
      .map((r) => `${r.method} ${new URL(r.url).pathname}`);

  test("uploads exported and step-only environments before the steps", async () => {
    const { result, error, requests, messages } = await run({
      "environments.js": FRONTEND_ENVIRONMENT_JS,
      "steps.js": HANDLE_STEPS_JS("frontend"),
    });
    expect(error).toBeUndefined();
    expect(result?.publishedEnvironments).toEqual(["frontend", "hidden"]);
    expect(result?.unchangedEnvironments).toEqual([]);
    expect(result?.pushedSteps).toBe(3);
    expect(writes(requests)).toEqual([
      "PUT /api/projects/proj-env/environments/frontend",
      "PUT /api/projects/proj-env/environments/hidden",
      "PUT /api/step-definitions",
      "PUT /api/step-definitions",
      "PUT /api/step-definitions",
    ]);
    expect(
      requests.find((r) => r.url.endsWith("/environments/hidden"))?.body,
    ).toEqual({ content: { description: "develop" } });
    expect(requests.map((r) => r.body)).toContainEqual(
      expect.objectContaining({
        key: "fix-ui",
        environment: { kind: "named", name: "frontend" },
      }),
    );
    expect(messages).toContain(
      "Found 2 environment(s), 3 step(s), 0 pipeline document(s) and 0 automation document(s).",
    );
    expect(messages).toContain(
      "✓ environment frontend v1 → published (environments.js)",
    );
    expect(messages).toContain(
      "✓ environment hidden v1 → published (steps.js)",
    );
    expect(
      requests.some(
        (r) => r.method === "GET" && r.url.endsWith("/environments"),
      ),
    ).toBe(false);
  });

  test("reports environments matching their latest version as unchanged", async () => {
    const { root, dir } = setup({
      "environments.js": FRONTEND_ENVIRONMENT_JS,
      "steps.js": HANDLE_STEPS_JS("frontend"),
    });
    const previousFetch = globalThis.fetch;
    const messages: string[] = [];
    globalThis.fetch = makeMockFetch([]);
    try {
      const push = () =>
        pushFromDirectory(relative(process.cwd(), dir), {
          baseUrl: BASE_URL,
          projectId: "proj-env",
          accessToken: "tok",
          log: (message) => {
            messages.push(message);
          },
        });
      await push();
      messages.length = 0;
      const result = await push();
      expect(result.publishedEnvironments).toEqual([]);
      expect(result.unchangedEnvironments).toEqual(["frontend", "hidden"]);
      expect(messages).toContain(
        "✓ environment frontend v1 → unchanged (environments.js)",
      );
    } finally {
      globalThis.fetch = previousFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects two environments with one name before any request", async () => {
    const { error, requests } = await run({
      "environments.js": FRONTEND_ENVIRONMENT_JS,
      "other.js": CONFLICTING_FRONTEND_JS,
    });
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Environment "frontend" is defined twice');
    expect(message).toContain("environments.js");
    expect(message).toContain("other.js");
    expect(requests).toEqual([]);
  });

  test("fails without uploading when a string name is unknown locally and on the server", async () => {
    const { error, requests } = await run(
      {
        "environments.js": FRONTEND_ENVIRONMENT_JS,
        "steps.js": HANDLE_STEPS_JS("shared-build"),
      },
      ["other"],
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('"shared-build" (used by by-name)');
    expect(message).toContain("Nothing was uploaded");
    expect(writes(requests)).toEqual([]);
    expect(
      requests.filter((r) => r.url.endsWith("/environments")),
    ).toHaveLength(1);
  });

  test("passes when a string name exists only on the server", async () => {
    const { result, error, requests } = await run(
      {
        "environments.js": FRONTEND_ENVIRONMENT_JS,
        "steps.js": HANDLE_STEPS_JS("shared-build"),
      },
      ["shared-build"],
    );
    expect(error).toBeUndefined();
    expect(result?.pushedSteps).toBe(3);
    expect(result?.publishedEnvironments).toEqual(["frontend", "hidden"]);
    expect(
      requests.some((r) => r.url.endsWith("/environments/shared-build")),
    ).toBe(false);
  });

  test("pushes named, inline and default steps when the server has the named environment", async () => {
    const { result, error, requests } = await run(
      { "steps.js": AUTHORED_ENVIRONMENTS_JS },
      ["shared-build"],
    );
    expect(error).toBeUndefined();
    expect(result?.pushedSteps).toBe(4);
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(4);
  });
});
