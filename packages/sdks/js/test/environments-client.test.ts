import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createEnvironmentsClient,
  EnvironmentsApiError,
} from "../src/definitions/environments";
import {
  readRequest,
  type CapturedRequest,
} from "./push-from-directory-fixtures";

const BASE_URL = "https://scarn.example.com";
const HEADERS = { Authorization: "Bearer tok" };

describe("createEnvironmentsClient", () => {
  const previousFetch = globalThis.fetch;
  let captured: CapturedRequest[];
  let response: { status: number; body: unknown };

  beforeEach(() => {
    captured = [];
    response = { status: 200, body: {} };
    globalThis.fetch = (async (input: string | URL | Request) => {
      captured.push(await readRequest(input));
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("publish PUTs the content under the environment's name", async () => {
    response = { status: 200, body: { published: true } };
    const client = createEnvironmentsClient(BASE_URL);

    const result = await client.publish(
      "proj-1",
      "frontend",
      { description: "develop" },
      { headers: HEADERS },
    );

    expect(result.published).toBe(true);
    expect(captured).toEqual([
      {
        method: "PUT",
        url: `${BASE_URL}/api/projects/proj-1/environments/frontend`,
        body: { content: { description: "develop" } },
      },
    ]);
  });

  test("get asks for a given version when one is passed", async () => {
    const client = createEnvironmentsClient(BASE_URL);

    await client.get("proj-1", "frontend", { headers: HEADERS, version: 2 });
    await client.get("proj-1", "frontend", { headers: HEADERS });

    expect(captured.map((r) => r.url)).toEqual([
      `${BASE_URL}/api/projects/proj-1/environments/frontend?version=2`,
      `${BASE_URL}/api/projects/proj-1/environments/frontend`,
    ]);
  });

  test("a validation rejection carries each content error", async () => {
    response = {
      status: 422,
      body: {
        type: "about:blank",
        title: "Invalid environment",
        status: 422,
        code: "VALIDATION",
        errors: [{ path: "/connectors/0", message: "Unknown connector" }],
      },
    };
    const client = createEnvironmentsClient(BASE_URL);

    let caught: unknown;
    try {
      await client.publish("proj-1", "frontend", {}, { headers: HEADERS });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvironmentsApiError);
    const error = caught as EnvironmentsApiError;
    expect(error.code).toBe("VALIDATION");
    expect(error.status).toBe(422);
    expect(error.issues).toEqual([
      { path: "/connectors/0", message: "Unknown connector" },
    ]);
  });
});
