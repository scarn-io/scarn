import { beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createApp } from "@scarn/api/app";
import {
  createStepDefinitionsClient,
  defineMcp,
  mcpTool,
  mcpToolCatalog,
  toStepSpec,
} from "@scarn/sdk/definitions/steps";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

const BASE_URL = "http://scarn.test";

const searchInputJsonSchema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
};
const searchOutputJsonSchema = {
  type: "object",
  properties: { results: { type: "array" } },
  required: ["results"],
};

const docsTools = mcpToolCatalog({
  source: { server: "docs", lockHash: "sha256:abc" },
  tools: {
    search: mcpTool({
      name: "search",
      input: z.object({ query: z.string() }),
      inputJsonSchema: searchInputJsonSchema,
      output: z.object({ results: z.array(z.string()) }),
      outputJsonSchema: searchOutputJsonSchema,
    }),
  },
});

const docs = defineMcp({
  type: "remote",
  name: "docs",
  url: "https://docs.example.test/mcp",
}).withTools(docsTools);

/**
 * Pushes an `mcp_tool` step through the SDK's `upsertFromSpec` against the
 * real API, so the SDK body, the server contract and the stored
 * `tool_call_json` column are checked together.
 */
describe("mcp_tool step definitions pushed from the SDK", () => {
  let app: ReturnType<typeof createApp>;
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  const push = async (
    step: Parameters<
      ReturnType<typeof createStepDefinitionsClient>["upsertFromSpec"]
    >[1],
  ) => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    const prevFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      app.handle(new Request(input, init))) as typeof fetch;
    try {
      return await createStepDefinitionsClient(BASE_URL).upsertFromSpec(
        project.id,
        step,
        { headers: authHeaders },
      );
    } finally {
      globalThis.fetch = prevFetch;
    }
  };

  beforeAll(async () => {
    app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-11-19T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnApiClient(app);
    const owner = await createTestUserAndSession({
      email: `step-definition-mcp-tool-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "MCP Tool Step Project",
          description: "Project for MCP tool step tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  test("push then GET round-trips toolCallJson", async () => {
    const step = docs.tools.search.step({
      key: `docs-search-${crypto.randomUUID()}`,
    });
    const pushed = await push(step);

    const reloaded = await unwrapAsync(
      apiClient.api["step-definitions"]({ stepDefinitionId: pushed.id }).get({
        headers: { ...authHeaders },
      }),
    );
    expect({
      kind: reloaded.kind,
      prompt: reloaded.prompt,
      entrypointJson: reloaded.entrypointJson,
      toolCallJson: reloaded.toolCallJson,
      resultSchemaJson: reloaded.resultSchemaJson,
      mcpServers: Object.keys(reloaded.opencodeMcpJson ?? {}),
    }).toEqual({
      kind: "mcp_tool",
      prompt: null,
      entrypointJson: null,
      toolCallJson: {
        server: "docs",
        tool: "search",
        argsTemplate: step.toolCall?.argsTemplate ?? null,
        toolSchemas: {
          input: searchInputJsonSchema,
          output: searchOutputJsonSchema,
        },
      },
      resultSchemaJson: searchOutputJsonSchema,
      mcpServers: ["docs"],
    });
  });

  test("rejects an mcp_tool step whose tool call names a server it doesn't declare", async () => {
    const spec = toStepSpec(
      docs.tools.search.step({ key: `docs-search-${crypto.randomUUID()}` }),
    );
    const wrongServer = {
      ...spec,
      toolCall: spec.toolCall && { ...spec.toolCall, server: "elsewhere" },
    };
    let failure = "";
    try {
      await push(wrongServer);
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toMatch(/exactly one MCP server/);
  });
});
