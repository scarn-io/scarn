import { beforeAll, describe, expect, test } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { unwrapAsync } from "tests/utils";
import {
  createEnvironmentsTestClient,
  createEnvironmentsTestProject,
  createEnvironmentsTestUser,
  environmentContent,
  type EnvironmentsTestUser,
} from "./environment-test-support";

describe("environment lifecycle", () => {
  const apiClient = createEnvironmentsTestClient();
  const name = "frontend";
  let owner: EnvironmentsTestUser;
  let projectId: UuidV7;

  const environments = () => apiClient.api.projects({ projectId }).environments;
  const one = () => environments()({ name });

  beforeAll(async () => {
    owner = await createEnvironmentsTestUser("lifecycle");
    projectId = await createEnvironmentsTestProject(apiClient, owner);
  });

  test("publishing a new name creates version 1", async () => {
    const result = await unwrapAsync(
      one().put(
        { content: environmentContent() },
        { headers: owner.authHeaders },
      ),
    );

    expect(result.published).toBe(true);
    expect(result.environment).toMatchObject({
      projectId,
      name,
      description: "Frontend app",
      latestVersion: 1,
    });
    expect(result.version.version).toBe(1);
    expect(result.version.content).toEqual({
      description: "Frontend app",
      runtime: { kind: "devcontainer" },
      vars: [
        {
          name: "LOG_LEVEL",
          source: "value",
          value: "debug",
          secret: false,
          applies: "both",
        },
      ],
    });
  });

  test("publishing identical content adds no version", async () => {
    const result = await unwrapAsync(
      one().put(
        { content: environmentContent() },
        { headers: owner.authHeaders },
      ),
    );

    expect(result.published).toBe(false);
    expect(result.version.version).toBe(1);
    expect(result.environment.latestVersion).toBe(1);
  });

  test("publishing changed content creates version 2", async () => {
    const result = await unwrapAsync(
      one().put(
        { content: environmentContent({ description: "develop" }) },
        { headers: owner.authHeaders },
      ),
    );

    expect(result.published).toBe(true);
    expect(result.version.version).toBe(2);
    expect(result.version.content.description).toBe("develop");
  });

  test("the environment is listed with its latest version", async () => {
    const listed = await unwrapAsync(
      environments().get({ headers: owner.authHeaders }),
    );

    expect(
      listed.map((environment) => [
        environment.name,
        environment.latestVersion,
      ]),
    ).toEqual([[name, 2]]);
  });

  test("get returns the latest version, or the one asked for", async () => {
    const latest = await unwrapAsync(one().get({ headers: owner.authHeaders }));
    const first = await unwrapAsync(
      one().get({ headers: owner.authHeaders, query: { version: 1 } }),
    );

    expect(latest.version.version).toBe(2);
    expect(first.version.version).toBe(1);
    expect(first.version.content.description).toBe("Frontend app");
    expect(first.environment.latestVersion).toBe(2);
  });

  test("a version the environment doesn't have is not found", async () => {
    const { data, error } = await one().get({
      headers: owner.authHeaders,
      query: { version: 3 },
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  test("deleting removes it from list and get", async () => {
    const deleted = await unwrapAsync(
      one().delete(undefined, { headers: owner.authHeaders }),
    );
    const listed = await unwrapAsync(
      environments().get({ headers: owner.authHeaders }),
    );
    const { error } = await one().get({ headers: owner.authHeaders });

    expect(deleted).toEqual({ deleted: true });
    expect(listed).toEqual([]);
    expect(error?.status).toBe(404);
  });

  test("republishing after a delete carries on the version numbers", async () => {
    const result = await unwrapAsync(
      one().put(
        { content: environmentContent({ description: "release" }) },
        { headers: owner.authHeaders },
      ),
    );

    expect(result.published).toBe(true);
    expect(result.version.version).toBe(3);
    expect(result.environment.latestVersion).toBe(3);
  });
});
