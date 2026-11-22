import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import {
  createStepDefinitionsClient,
  defineStep,
} from "@scarn/sdk/definitions/steps";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

const BASE_URL = "http://scarn.test";

/**
 * Pushes a `defineStep` through the SDK's `upsertFromSpec` against the real
 * API, so the SDK's request body and the server contract are checked
 * together.
 */
describe("step definition task settings pushed from the SDK", () => {
  let app: ReturnType<typeof createApp>;
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnApiClient(app);
    const owner = await createTestUserAndSession({
      email: `step-definition-sdk-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition SDK Project",
          description: "Project for SDK push tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  test("push then GET returns maxTurns, concurrency, grants, errors and retry", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const step = defineStep({
      key: `wayfinder_${crypto.randomUUID()}`,
      name: "Wayfinder",
      agentPrompt: "Find the way.",
      errors: ["MapMissing"],
      retry: [{ on: ["MapMissing", "Scarn.Timeout"], maxAttempts: 2 }],
      maxTurns: 40,
      concurrency: { max: 1, waiting: 1 },
    });

    const prevFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      app.handle(new Request(input, init))) as typeof fetch;
    let pushed: { id: string } | undefined;
    try {
      pushed = await createStepDefinitionsClient(BASE_URL).upsertFromSpec(
        project.id,
        step,
        { headers: authHeaders },
      );
    } finally {
      globalThis.fetch = prevFetch;
    }

    const reloaded = await unwrapAsync(
      apiClient.api["step-definitions"]({ stepDefinitionId: pushed.id }).get({
        headers: { ...authHeaders },
      }),
    );
    expect({
      maxTurns: reloaded.maxTurns,
      concurrency: reloaded.concurrency,
      grants: reloaded.grants,
      errors: reloaded.errors,
      retry: reloaded.retry,
    }).toEqual({
      maxTurns: 40,
      concurrency: { max: 1, waiting: 1 },
      grants: [],
      errors: ["MapMissing"],
      retry: [{ on: ["MapMissing", "Scarn.Timeout"], maxAttempts: 2 }],
    });
  });
});
