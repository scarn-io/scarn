import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createEnvironmentsTestClient,
  createEnvironmentsTestProject,
  createEnvironmentsTestUser,
  environmentContent,
  putStepUsingEnvironment,
  uniqueEnvironmentName,
  type EnvironmentsTestUser,
} from "./environment-test-support";

describe("environment deletion", () => {
  const apiClient = createEnvironmentsTestClient();
  let owner: EnvironmentsTestUser;
  let projectId: UuidV7;

  const environment = (name: string) =>
    apiClient.api.projects({ projectId }).environments({ name });

  const publish = async (name: string) =>
    await unwrapAsync(
      environment(name).put(
        { content: environmentContent() },
        { headers: owner.authHeaders },
      ),
    );

  beforeAll(async () => {
    owner = await createEnvironmentsTestUser("delete");
    projectId = await createEnvironmentsTestProject(apiClient, owner);
  });

  concurrentTest(
    "an environment a step uses cannot be deleted until the step stops using it",
    async () => {
      const name = uniqueEnvironmentName();
      const key = `uses-${name}`;
      await publish(name);
      const step = await putStepUsingEnvironment(
        apiClient,
        owner.authHeaders,
        projectId,
        key,
        name,
      );

      const refused = await environment(name).delete(undefined, {
        headers: owner.authHeaders,
      });

      expect(refused.data).toBeNull();
      expect(refused.error?.status).toBe(409);
      expect(refused.error?.value).toMatchObject({
        code: "ENVIRONMENT_IN_USE",
      });
      expect(JSON.stringify(refused.error?.value)).toContain(key);

      await unwrapAsync(
        apiClient.api["step-definitions"]({
          stepDefinitionId: parseUuidV7(step.id),
        }).archive.put(undefined, { headers: owner.authHeaders }),
      );
      const deleted = await unwrapAsync(
        environment(name).delete(undefined, { headers: owner.authHeaders }),
      );
      expect(deleted).toEqual({ deleted: true });
    },
  );

  concurrentTest("deleting an unknown environment is not found", async () => {
    const { error } = await environment(uniqueEnvironmentName()).delete(
      undefined,
      { headers: owner.authHeaders },
    );

    expect(error?.status).toBe(404);
  });

  concurrentTest("deleting twice is not found the second time", async () => {
    const name = uniqueEnvironmentName();
    await publish(name);
    await unwrapAsync(
      environment(name).delete(undefined, { headers: owner.authHeaders }),
    );

    const { error } = await environment(name).delete(undefined, {
      headers: owner.authHeaders,
    });

    expect(error?.status).toBe(404);
  });
});
