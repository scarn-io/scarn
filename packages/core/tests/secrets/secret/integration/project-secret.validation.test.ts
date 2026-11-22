import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createSecretsTestClient } from "./secret-test-support";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  projectSecretValue,
  type ProjectSecretsTestUser,
} from "./project-secret-test-support";

const uniqueName = () => `KEY_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

describe("project secret validation", () => {
  const apiClient = createSecretsTestClient();
  let owner: ProjectSecretsTestUser;
  let projectId: UuidV7;
  const secrets = () => apiClient.api.projects({ projectId }).secrets;

  beforeAll(async () => {
    owner = await createProjectSecretsTestUser("owner");
    projectId = await createProjectSecretsTestProject(apiClient, owner);
  });

  concurrentTest(
    "a duplicate name is a 409 that does not echo the value",
    async () => {
      const name = uniqueName();
      await unwrapAsync(
        secrets().post(
          { name, value: projectSecretValue() },
          { headers: owner.authHeaders },
        ),
      );
      const value = projectSecretValue();

      const { error } = await secrets().post(
        { name, value },
        { headers: owner.authHeaders },
      );

      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ code: "SECRET_NAME_TAKEN" });
      expect(JSON.stringify(error?.value)).not.toContain(value);
    },
  );

  concurrentTest("renaming onto a taken name is a 409", async () => {
    const taken = uniqueName();
    await unwrapAsync(
      secrets().post(
        { name: taken, value: projectSecretValue() },
        { headers: owner.authHeaders },
      ),
    );
    const secret = await unwrapAsync(
      secrets().post(
        { name: uniqueName(), value: projectSecretValue() },
        { headers: owner.authHeaders },
      ),
    );

    const { error } = await apiClient.api
      .projects({ projectId })
      .secrets({ secretId: parseUuidV7(secret.id) })
      .patch({ name: taken }, { headers: owner.authHeaders });

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "SECRET_NAME_TAKEN" });
  });

  concurrentTest(
    "a name that is not an env var name is rejected without echoing the value",
    async () => {
      const value = projectSecretValue();

      const { error } = await secrets().post(
        { name: "not valid", value },
        { headers: owner.authHeaders },
      );

      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({ code: "SECRET_NAME_INVALID" });
      expect(JSON.stringify(error?.value)).not.toContain(value);
    },
  );

  concurrentTest("an empty patch is rejected", async () => {
    const secret = await unwrapAsync(
      secrets().post(
        { name: uniqueName(), value: projectSecretValue() },
        { headers: owner.authHeaders },
      ),
    );

    const { error } = await apiClient.api
      .projects({ projectId })
      .secrets({ secretId: parseUuidV7(secret.id) })
      .patch({}, { headers: owner.authHeaders });

    expect(error?.status).toBe(422);
  });

  concurrentTest(
    "a malformed body does not echo the value in the error",
    async () => {
      const value = projectSecretValue();

      const { error } = await secrets().post(
        // @ts-expect-error unknown field rejected by the strict schema
        { name: uniqueName(), value, extra: true },
        { headers: owner.authHeaders },
      );

      expect(error?.status).toBe(422);
      expect(JSON.stringify(error?.value)).not.toContain(value);
    },
  );
});
