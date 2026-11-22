import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

describe("step definition MCP server refs", () => {
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnApiClient(app);
    const owner = await createTestUserAndSession({
      email: `step-definition-mcp-refs-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition MCP Refs Project",
          description: "Project for MCP server ref tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  concurrentTest(
    "stores MCP server ref entries unchanged alongside inline entries",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const opencodeMcpJson = {
        postgres: { type: "ref" as const },
        warehouse: {
          type: "ref" as const,
          name: "postgres-warehouse",
          codemode: true,
          disabled: false,
        },
        playwright: {
          type: "local" as const,
          command: ["npx", "-y", "@playwright/mcp@0.0.68"],
        },
      };

      const created = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            projectId: parseUuidV7(project.id),
            key: `mcp_refs_${crypto.randomUUID()}`,
            name: "MCP refs",
            description: null,
            prompt: "Use the referenced servers.",
            version: 1,
            kind: "user_defined" as const,
            inputSchemaJson: { type: "object" },
            resultSchemaJson: { type: "object" },
            status: "draft" as const,
            opencodeMcpJson,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(created.opencodeMcpJson).toEqual(opencodeMcpJson);

      const reloaded = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId: created.id }).get(
          { headers: { ...authHeaders } },
        ),
      );
      expect(reloaded.opencodeMcpJson).toEqual(opencodeMcpJson);
    },
  );
});
