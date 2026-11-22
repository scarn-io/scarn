import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { createAppContext } from "@/lib/di";
import { createScarnApiClient } from "tests/treaty";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  environmentContent,
  uniqueEnvironmentName,
} from "../../environment/integration/environment-test-support";

const vars = [
  {
    name: "TICKET",
    source: "inherit",
    from: "TICKET",
    secret: false,
    optional: false,
    applies: "agent",
  },
  {
    name: "HIDDEN",
    source: "inherit",
    from: "HIDDEN",
    secret: true,
    optional: false,
    applies: "agent",
  },
  { name: "TOKEN", source: "secret", secretName: "TOKEN", applies: "agent" },
] as const;

describe("step definition repo.baseBranch env tokens at publish", () => {
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let projectId: UuidV7;
  let headers: { authorization: string };

  beforeAll(async () => {
    apiClient = createScarnApiClient(createApp(createAppContext()));
    const owner = await createTestUserAndSession({
      email: `base-branch-env-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Base branch env project",
          description: null,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const putStep = async (
    environment:
      | { kind: "named"; name: string }
      | { kind: "inline"; envJson: typeof vars }
      | null,
    baseBranch: string,
  ) =>
    await apiClient.api["step-definitions"].put(
      {
        projectId,
        key: `base-branch-${crypto.randomUUID()}`,
        name: "Base branch",
        kind: "user_defined",
        version: 1,
        description: null,
        prompt: "Do the thing",
        inputSchemaJson: { type: "object", properties: {} },
        resultSchemaJson: null,
        status: "active",
        environment: environment as never,
        repo: { mode: "readOnly", baseBranch },
      },
      { headers },
    );

  const publishNamed = async (): Promise<string> => {
    const name = uniqueEnvironmentName();
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .environments({ name })
        .put({ content: environmentContent({ vars: [...vars] }) }, { headers }),
    );
    return name;
  };

  const expectRejected = (
    result: Awaited<ReturnType<typeof putStep>>,
    token: string,
    reason: "undeclared" | "secret",
  ) => {
    expect(result.data).toBeNull();
    expect(result.error?.status).toBe(400);
    expect(result.error?.value).toMatchObject({
      code: "REPO_BASE_BRANCH_INVALID",
    });
    expect(JSON.stringify(result.error?.value)).toContain(
      reason === "secret"
        ? `{{${token}}} names a secret var`
        : `{{${token}}} names a var the environment does not declare`,
    );
  };

  concurrentTest("by name: a declared non-secret var passes", async () => {
    const name = await publishNamed();
    const created = await unwrapAsync(
      putStep({ kind: "named", name }, "feature/{{env.TICKET}}"),
    );
    expect(created.repo).toMatchObject({
      baseBranch: "feature/{{env.TICKET}}",
    });
  });

  concurrentTest("by name: an undeclared var is rejected", async () => {
    const name = await publishNamed();
    expectRejected(
      await putStep({ kind: "named", name }, "{{env.MISSING}}"),
      "env.MISSING",
      "undeclared",
    );
  });

  concurrentTest(
    "by name: secret and secret inherit vars are rejected",
    async () => {
      const name = await publishNamed();
      expectRejected(
        await putStep({ kind: "named", name }, "{{env.TOKEN}}"),
        "env.TOKEN",
        "secret",
      );
      expectRejected(
        await putStep({ kind: "named", name }, "{{env.HIDDEN}}"),
        "env.HIDDEN",
        "secret",
      );
    },
  );

  concurrentTest(
    "by name: the check uses the environment's latest version",
    async () => {
      const name = await publishNamed();
      await unwrapAsync(
        apiClient.api
          .projects({ projectId })
          .environments({ name })
          .put({ content: environmentContent() }, { headers }),
      );
      expectRejected(
        await putStep({ kind: "named", name }, "{{env.TICKET}}"),
        "env.TICKET",
        "undeclared",
      );
    },
  );

  concurrentTest("inline: valid, undeclared and secret", async () => {
    const inline = { kind: "inline", envJson: vars } as const;
    const created = await unwrapAsync(putStep(inline, "{{env.TICKET}}"));
    expect(created.repo).toMatchObject({ baseBranch: "{{env.TICKET}}" });
    expectRejected(
      await putStep(inline, "{{env.NOPE}}"),
      "env.NOPE",
      "undeclared",
    );
    expectRejected(
      await putStep(inline, "{{env.TOKEN}}"),
      "env.TOKEN",
      "secret",
    );
  });

  concurrentTest("no environment: an env token is undeclared", async () => {
    expectRejected(await putStep(null, "{{env.X}}"), "env.X", "undeclared");
  });
});
