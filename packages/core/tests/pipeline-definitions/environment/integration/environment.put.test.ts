import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import type { EnvironmentContentInput } from "@/common/contracts/environment";
import { concurrentTest } from "tests/utils";
import {
  createEnvironmentsTestClient,
  createEnvironmentsTestProject,
  createEnvironmentsTestUser,
  environmentContent,
  uniqueEnvironmentName,
  type EnvironmentsTestUser,
} from "./environment-test-support";

describe("environment publication validation", () => {
  const apiClient = createEnvironmentsTestClient();
  let owner: EnvironmentsTestUser;
  let projectId: UuidV7;

  const put = async (name: string, content: EnvironmentContentInput) =>
    await apiClient.api
      .projects({ projectId })
      .environments({ name })
      .put({ content }, { headers: owner.authHeaders });

  beforeAll(async () => {
    owner = await createEnvironmentsTestUser("validation");
    projectId = await createEnvironmentsTestProject(apiClient, owner);
  });

  concurrentTest("an invalid name is rejected", async () => {
    const { data, error } = await put("Not_Valid", environmentContent());

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "VALIDATION" });
  });

  const invalidContents: [string, EnvironmentContentInput, string][] = [
    [
      "an invalid runtime",
      environmentContent({
        runtime: {
          kind: "kubernetes",
        } as unknown as EnvironmentContentInput["runtime"],
      }),
      "runtime",
    ],
    [
      "an unknown connector",
      environmentContent({ connectors: ["not-a-connector"] }),
      "connectors",
    ],
    [
      "a connector missing a required variable",
      environmentContent({
        connectors: ["datadog"],
        vars: [
          { name: "DD_API_KEY", source: "secret", secretName: "DD_API_KEY" },
        ],
      }),
      "DD_APPLICATION_KEY",
    ],
    [
      "a secret variable with a default",
      environmentContent({
        vars: [
          {
            name: "API_TOKEN",
            source: "inherit",
            from: "API_TOKEN",
            secret: true,
            optional: false,
            default: "plaintext",
          },
        ],
      }),
      "default",
    ],
    [
      "a setup variable on a host runtime",
      environmentContent({
        runtime: { kind: "host" },
        vars: [
          {
            name: "NPM_TOKEN",
            source: "secret",
            secretName: "NPM_TOKEN",
            applies: "setup",
          },
        ],
      }),
      "runtime 'host' has no container",
    ],
  ];

  for (const [label, content, mentions] of invalidContents) {
    concurrentTest(`content with ${label} is rejected`, async () => {
      const name = uniqueEnvironmentName();

      const { data, error } = await put(name, content);

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({ code: "VALIDATION" });
      expect(JSON.stringify(error?.value)).toContain(mentions);
      const { error: getError } = await apiClient.api
        .projects({ projectId })
        .environments({ name })
        .get({ headers: owner.authHeaders });
      expect(getError?.status).toBe(404);
    });
  }

  concurrentTest(
    "a version query that isn't a positive integer is rejected",
    async () => {
      const { error } = await apiClient.api
        .projects({ projectId })
        .environments({ name: uniqueEnvironmentName() })
        .get({ headers: owner.authHeaders, query: { version: 0 } });

      expect(error?.status).toBe(422);
    },
  );
});
