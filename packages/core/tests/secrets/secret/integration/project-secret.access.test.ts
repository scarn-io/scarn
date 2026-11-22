import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createSecretsTestClient } from "./secret-test-support";
import {
  addWriteMember,
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  projectSecretValue,
  type ProjectSecretsTestUser,
} from "./project-secret-test-support";

describe("project secret access", () => {
  const apiClient = createSecretsTestClient();
  let owner: ProjectSecretsTestUser;
  let writer: ProjectSecretsTestUser;
  let projectId: UuidV7;
  let otherProjectId: UuidV7;

  const secretsOf = (id: UuidV7) =>
    apiClient.api.projects({ projectId: id }).secrets;

  const createSecret = async (id: UuidV7 = projectId) =>
    await unwrapAsync(
      secretsOf(id).post(
        {
          name: `KEY_${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
          value: projectSecretValue(),
        },
        { headers: owner.authHeaders },
      ),
    );

  beforeAll(async () => {
    owner = await createProjectSecretsTestUser("owner");
    writer = await createProjectSecretsTestUser("writer");
    projectId = await createProjectSecretsTestProject(apiClient, owner);
    otherProjectId = await createProjectSecretsTestProject(apiClient, owner);
    await addWriteMember(apiClient, projectId, owner, writer);
  });

  concurrentTest("a writer can list the project's secrets", async () => {
    const secret = await createSecret();

    const listed = await unwrapAsync(
      secretsOf(projectId).get({ headers: writer.authHeaders }),
    );

    expect(listed.map((s) => s.id)).toContain(secret.id);
  });

  concurrentTest("a writer cannot create a secret", async () => {
    const value = projectSecretValue();

    const { data, error } = await secretsOf(projectId).post(
      { name: "WRITER_KEY", value },
      { headers: writer.authHeaders },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(JSON.stringify(error?.value)).not.toContain(value);
  });

  concurrentTest("a writer cannot rename, replace or delete", async () => {
    const secret = await createSecret();
    const one = secretsOf(projectId)({ secretId: parseUuidV7(secret.id) });

    const rename = await one.patch(
      { name: "HIJACKED" },
      { headers: writer.authHeaders },
    );
    const replace = await one.patch(
      { value: projectSecretValue() },
      { headers: writer.authHeaders },
    );
    const remove = await one.delete(undefined, {
      headers: writer.authHeaders,
    });

    expect(rename.error?.status).toBe(403);
    expect(replace.error?.status).toBe(403);
    expect(remove.error?.status).toBe(403);
  });

  concurrentTest("a non-member cannot list", async () => {
    const outsider = await createProjectSecretsTestUser("outsider");

    const { error } = await secretsOf(projectId).get({
      headers: outsider.authHeaders,
    });

    expect(error?.status).toBe(403);
  });

  concurrentTest(
    "a secret of another project is a 404 through this project's id",
    async () => {
      const foreign = await createSecret(otherProjectId);
      const viaWrongProject = secretsOf(projectId)({
        secretId: parseUuidV7(foreign.id),
      });

      const patch = await viaWrongProject.patch(
        { name: "STOLEN" },
        { headers: owner.authHeaders },
      );
      const remove = await viaWrongProject.delete(undefined, {
        headers: owner.authHeaders,
      });
      const listed = await unwrapAsync(
        secretsOf(projectId).get({ headers: owner.authHeaders }),
      );

      expect(patch.error?.status).toBe(404);
      expect(patch.error?.value).toMatchObject({ code: "SECRET_NOT_FOUND" });
      expect(remove.error?.status).toBe(404);
      expect(listed.map((s) => s.id)).not.toContain(foreign.id);
    },
  );
});
