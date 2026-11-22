import { beforeAll, describe, expect, test } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { ProjectSecretContract } from "@/secrets/secret/contracts/project-secret-contracts";
import { unwrapAsync } from "tests/utils";
import {
  createSecretsTestClient,
  SECRETS_TEST_NOW,
} from "./secret-test-support";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "./project-secret-test-support";

describe("project secret lifecycle", () => {
  const apiClient = createSecretsTestClient();
  let owner: ProjectSecretsTestUser;
  let projectId: UuidV7;
  let secret: ProjectSecretContract;
  const secrets = () => apiClient.api.projects({ projectId }).secrets;
  const oneSecret = () =>
    apiClient.api
      .projects({ projectId })
      .secrets({ secretId: parseUuidV7(secret.id) });

  beforeAll(async () => {
    owner = await createProjectSecretsTestUser("owner");
    projectId = await createProjectSecretsTestProject(apiClient, owner);
  });

  test("creates a project secret without echoing its value", async () => {
    secret = await unwrapAsync(
      secrets().post(
        { name: "  STRIPE_KEY  ", value: "sk-live-abcd1234" },
        { headers: owner.authHeaders },
      ),
    );

    expect(secret).toMatchObject({
      projectId,
      name: "STRIPE_KEY",
      lastFour: "1234",
      updatedBy: {
        userId: parseUuidV7(owner.userId),
        username: owner.username,
      },
      lastUsedAt: null,
      createdAt: SECRETS_TEST_NOW.toISOString(),
      updatedAt: SECRETS_TEST_NOW.toISOString(),
    });
    expect(JSON.stringify(secret)).not.toContain("sk-live-abcd1234");
  });

  test("lists it", async () => {
    const listed = await unwrapAsync(
      secrets().get({ headers: owner.authHeaders }),
    );

    expect(listed).toEqual([secret]);
  });

  test("renames it", async () => {
    const renamed = await unwrapAsync(
      oneSecret().patch(
        { name: "STRIPE_API_KEY" },
        { headers: owner.authHeaders },
      ),
    );

    expect(renamed.name).toBe("STRIPE_API_KEY");
    expect(renamed.lastFour).toBe("1234");
  });

  test("replaces its value", async () => {
    const replaced = await unwrapAsync(
      oneSecret().patch(
        { value: "sk-live-wxyz9876" },
        { headers: owner.authHeaders },
      ),
    );

    expect(replaced.name).toBe("STRIPE_API_KEY");
    expect(replaced.lastFour).toBe("9876");
    expect(JSON.stringify(replaced)).not.toContain("sk-live-wxyz9876");
  });

  test("renames and replaces in one request", async () => {
    const updated = await unwrapAsync(
      oneSecret().patch(
        { name: "STRIPE_SECRET", value: "sk-live-last5555" },
        { headers: owner.authHeaders },
      ),
    );

    expect(updated.name).toBe("STRIPE_SECRET");
    expect(updated.lastFour).toBe("5555");
  });

  test("deletes it", async () => {
    const deleted = await unwrapAsync(
      oneSecret().delete(undefined, { headers: owner.authHeaders }),
    );

    expect(deleted).toEqual({ deleted: true });
  });

  test("no longer lists it", async () => {
    const listed = await unwrapAsync(
      secrets().get({ headers: owner.authHeaders }),
    );

    expect(listed).toEqual([]);
  });

  test("a second delete is a 404", async () => {
    const { error } = await oneSecret().delete(undefined, {
      headers: owner.authHeaders,
    });

    expect(error?.status).toBe(404);
  });
});
