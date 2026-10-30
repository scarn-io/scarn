import { describe, expect, test } from "bun:test";
import {
  createPipelineDefinitionsClient,
  PipelineDefinitionsApiError,
} from "../src/definitions/pipelines/pipeline-definitions-client";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

type MockResponse = { status: number; body: unknown };

async function readRequestDetails(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}> {
  if (input instanceof Request) {
    const text = await input.clone().text();
    return {
      url: input.url,
      method: input.method,
      headers: Object.fromEntries(input.headers.entries()),
      body: text.length > 0 ? JSON.parse(text) : undefined,
    };
  }
  const url = input instanceof URL ? input.toString() : input;
  const rawHeaders = init?.headers;
  const headers =
    rawHeaders instanceof Headers
      ? Object.fromEntries(rawHeaders.entries())
      : Object.fromEntries(
          Object.entries(
            (rawHeaders as Record<string, string> | undefined) ?? {},
          ),
        );
  const rawBody = init?.body;
  const body =
    typeof rawBody === "string" && rawBody.length > 0
      ? (JSON.parse(rawBody) as unknown)
      : undefined;
  return { url, method: init?.method ?? "GET", headers, body };
}

function createMockFetch(responses: MockResponse[]): {
  mockFetch: typeof globalThis.fetch;
  captured: CapturedRequest[];
} {
  let callIndex = 0;
  const captured: CapturedRequest[] = [];

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.push(await readRequestDetails(input, init));

    const resp = responses[callIndex++] ?? { status: 200, body: null };
    if (resp.body !== null && resp.body !== undefined) {
      return new Response(JSON.stringify(resp.body), {
        status: resp.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("", { status: resp.status });
  };

  return { mockFetch: mockFetch as typeof globalThis.fetch, captured };
}

const AUTH_HEADER = { Authorization: "Bearer test-token" };
const BASE_URL = "https://scarn.example.com";

const DOCUMENT = {
  schemaVersion: 1,
  key: "investigation",
  start: "investigate",
  nodes: { investigate: { kind: "step", step: "investigate" } },
};

async function withMockFetch<T>(
  responses: MockResponse[],
  run: (captured: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const { mockFetch, captured } = createMockFetch(responses);
  const prev = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await run(captured);
  } finally {
    globalThis.fetch = prev;
  }
}

describe("createPipelineDefinitionsClient", () => {
  describe("listByProjectId", () => {
    test("sends GET to /api/projects/{projectId}/pipeline-definitions", async () => {
      const { mockFetch, captured } = createMockFetch([
        { status: 200, body: [] },
      ]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.listByProjectId("proj-1", { headers: AUTH_HEADER });

        expect(captured).toHaveLength(1);
        expect(captured[0]?.method).toBe("GET");
        expect(captured[0]?.url).toBe(
          `${BASE_URL}/api/projects/proj-1/pipeline-definitions`,
        );
        // Headers.entries() lowercases header names per the WHATWG spec.
        expect(captured[0]?.headers["authorization"]).toBe("Bearer test-token");
      } finally {
        globalThis.fetch = prev;
      }
    });

    test("returns empty array when the server responds with an empty list", async () => {
      const { mockFetch } = createMockFetch([{ status: 200, body: [] }]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        const result = await client.listByProjectId("proj-1", {
          headers: AUTH_HEADER,
        });
        expect(result).toEqual([]);
      } finally {
        globalThis.fetch = prev;
      }
    });
  });

  describe("create", () => {
    test("sends POST to /api/pipeline-definitions with the document", async () => {
      await withMockFetch(
        [{ status: 200, body: { id: "pipeline-id" } }],
        async (captured) => {
          const client = createPipelineDefinitionsClient(BASE_URL);
          await client.create(
            {
              projectId: "proj-1",
              key: "investigation",
              name: "Investigation",
              document: DOCUMENT,
            },
            { headers: AUTH_HEADER },
          );

          expect(captured).toHaveLength(1);
          expect(captured[0]?.method).toBe("POST");
          expect(captured[0]?.url).toBe(`${BASE_URL}/api/pipeline-definitions`);
          expect(captured[0]?.body).toEqual({
            projectId: "proj-1",
            key: "investigation",
            name: "Investigation",
            document: DOCUMENT,
          });
        },
      );
    });
  });

  describe("publishVersion", () => {
    test("sends POST to /api/pipeline-definitions/{id}/versions", async () => {
      await withMockFetch(
        [{ status: 200, body: { published: true } }],
        async (captured) => {
          const client = createPipelineDefinitionsClient(BASE_URL);
          const result = await client.publishVersion("pipe-1", DOCUMENT, {
            headers: AUTH_HEADER,
          });

          expect(result.published).toBe(true);
          expect(captured[0]?.method).toBe("POST");
          expect(captured[0]?.url).toBe(
            `${BASE_URL}/api/pipeline-definitions/pipe-1/versions`,
          );
          expect(captured[0]?.body).toEqual({ document: DOCUMENT });
        },
      );
    });

    test("throws PipelineDefinitionsApiError carrying the document issues", async () => {
      const issue = {
        code: "unknown_step",
        path: "/nodes/investigate/step",
        message: "Unknown step 'investigate'",
        hint: "Push the step first",
      };
      const caught = await withMockFetch(
        [
          {
            status: 422,
            body: {
              title: "Validation failed",
              detail: "Pipeline document is invalid",
              code: "PIPELINE_DOCUMENT_INVALID",
              meta: { errors: [issue, { unrelated: true }] },
            },
          },
        ],
        async () => {
          const client = createPipelineDefinitionsClient(BASE_URL);
          try {
            await client.publishVersion("pipe-1", DOCUMENT);
            return undefined;
          } catch (err) {
            return err;
          }
        },
      );

      expect(caught).toBeInstanceOf(PipelineDefinitionsApiError);
      const error = caught as PipelineDefinitionsApiError;
      expect(error.message).toBe("Pipeline document is invalid");
      expect(error.code).toBe("PIPELINE_DOCUMENT_INVALID");
      expect(error.issues).toEqual([issue]);
    });
  });

  describe("activateVersion", () => {
    test("sends PUT to /api/pipeline-definitions/{id}/versions/{version}/activate", async () => {
      await withMockFetch(
        [{ status: 200, body: { id: "pipe-1" } }],
        async (captured) => {
          const client = createPipelineDefinitionsClient(BASE_URL);
          await client.activateVersion("pipe-1", 3, { headers: AUTH_HEADER });

          expect(captured[0]?.method).toBe("PUT");
          expect(captured[0]?.url).toBe(
            `${BASE_URL}/api/pipeline-definitions/pipe-1/versions/3/activate`,
          );
        },
      );
    });
  });

  describe("versions", () => {
    test("listVersions sends GET to /api/pipeline-definitions/{id}/versions", async () => {
      await withMockFetch([{ status: 200, body: [] }], async (captured) => {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.listVersions("pipe-1");

        expect(captured[0]?.method).toBe("GET");
        expect(captured[0]?.url).toBe(
          `${BASE_URL}/api/pipeline-definitions/pipe-1/versions`,
        );
      });
    });

    test("getVersion sends GET to /api/pipeline-definitions/{id}/versions/{version}", async () => {
      await withMockFetch(
        [{ status: 200, body: { version: 2 } }],
        async (captured) => {
          const client = createPipelineDefinitionsClient(BASE_URL);
          await client.getVersion("pipe-1", 2);

          expect(captured[0]?.method).toBe("GET");
          expect(captured[0]?.url).toBe(
            `${BASE_URL}/api/pipeline-definitions/pipe-1/versions/2`,
          );
        },
      );
    });
  });
});
