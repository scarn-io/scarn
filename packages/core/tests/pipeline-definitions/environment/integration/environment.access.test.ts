import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  addProjectMember,
  createEnvironmentsTestClient,
  createEnvironmentsTestProject,
  createEnvironmentsTestUser,
  environmentContent,
  uniqueEnvironmentName,
  type EnvironmentsTestUser,
} from "./environment-test-support";

describe("environment access", () => {
  const apiClient = createEnvironmentsTestClient();
  let owner: EnvironmentsTestUser;
  let writer: EnvironmentsTestUser;
  let admin: EnvironmentsTestUser;
  let reader: EnvironmentsTestUser;
  let outsider: EnvironmentsTestUser;
  let projectId: UuidV7;
  let otherProjectId: UuidV7;

  const environmentsOf = (id: UuidV7) =>
    apiClient.api.projects({ projectId: id }).environments;

  const publish = async (id: UuidV7 = projectId) => {
    const name = uniqueEnvironmentName();
    await unwrapAsync(
      environmentsOf(id)({ name }).put(
        { content: environmentContent() },
        { headers: owner.authHeaders },
      ),
    );
    return name;
  };

  beforeAll(async () => {
    owner = await createEnvironmentsTestUser("owner");
    writer = await createEnvironmentsTestUser("writer");
    admin = await createEnvironmentsTestUser("admin");
    reader = await createEnvironmentsTestUser("reader");
    outsider = await createEnvironmentsTestUser("outsider");
    projectId = await createEnvironmentsTestProject(apiClient, owner);
    otherProjectId = await createEnvironmentsTestProject(apiClient, owner);
    await addProjectMember(apiClient, projectId, owner, writer, "write");
    await addProjectMember(apiClient, projectId, owner, admin, "admin");
    await addProjectMember(apiClient, projectId, owner, reader, "read");
  });

  concurrentTest("a reader can list and get environments", async () => {
    const name = await publish();

    const listed = await unwrapAsync(
      environmentsOf(projectId).get({ headers: reader.authHeaders }),
    );
    const fetched = await unwrapAsync(
      environmentsOf(projectId)({ name }).get({
        headers: reader.authHeaders,
      }),
    );

    expect(listed.map((environment) => environment.name)).toContain(name);
    expect(fetched.environment.name).toBe(name);
  });

  concurrentTest("a reader cannot publish or delete", async () => {
    const name = await publish();
    const one = environmentsOf(projectId)({ name });

    const publishAttempt = await one.put(
      { content: environmentContent({ description: "hijacked" }) },
      { headers: reader.authHeaders },
    );
    const deleteAttempt = await one.delete(undefined, {
      headers: reader.authHeaders,
    });

    expect(publishAttempt.error?.status).toBe(403);
    expect(deleteAttempt.error?.status).toBe(403);
    const fetched = await unwrapAsync(one.get({ headers: owner.authHeaders }));
    expect(fetched.version.version).toBe(1);
  });

  concurrentTest(
    "a writer without settings:write cannot publish or delete",
    async () => {
      const name = await publish();
      const one = environmentsOf(projectId)({ name });

      const publishAttempt = await one.put(
        { content: environmentContent({ description: "hijacked" }) },
        { headers: writer.authHeaders },
      );
      const deleteAttempt = await one.delete(undefined, {
        headers: writer.authHeaders,
      });

      expect(publishAttempt.error?.status).toBe(403);
      expect(deleteAttempt.error?.status).toBe(403);
    },
  );

  concurrentTest("an admin can publish and delete", async () => {
    const name = uniqueEnvironmentName();
    const one = environmentsOf(projectId)({ name });

    const published = await unwrapAsync(
      one.put(
        { content: environmentContent() },
        { headers: admin.authHeaders },
      ),
    );
    const deleted = await unwrapAsync(
      one.delete(undefined, { headers: admin.authHeaders }),
    );

    expect(published.version.version).toBe(1);
    expect(deleted).toEqual({ deleted: true });
  });

  concurrentTest("a non-member can neither read nor write", async () => {
    const name = await publish();
    const one = environmentsOf(projectId)({ name });

    const list = await environmentsOf(projectId).get({
      headers: outsider.authHeaders,
    });
    const get = await one.get({ headers: outsider.authHeaders });
    const put = await one.put(
      { content: environmentContent() },
      { headers: outsider.authHeaders },
    );
    const remove = await one.delete(undefined, {
      headers: outsider.authHeaders,
    });

    for (const { data, error } of [list, get, put, remove]) {
      expect(data).toBeNull();
      expect(error?.status).toBe(403);
    }
  });

  concurrentTest("an unauthenticated request is a 401", async () => {
    const { error } = await environmentsOf(projectId).get();

    expect(error?.status).toBe(401);
  });

  concurrentTest("one project cannot see another's environments", async () => {
    const name = await publish(otherProjectId);

    const listed = await unwrapAsync(
      environmentsOf(projectId).get({ headers: owner.authHeaders }),
    );
    const fetched = await environmentsOf(projectId)({ name }).get({
      headers: owner.authHeaders,
    });
    const deleted = await environmentsOf(projectId)({ name }).delete(
      undefined,
      { headers: owner.authHeaders },
    );

    expect(listed.map((environment) => environment.name)).not.toContain(name);
    expect(fetched.error?.status).toBe(404);
    expect(deleted.error?.status).toBe(404);
    const stillThere = await unwrapAsync(
      environmentsOf(otherProjectId)({ name }).get({
        headers: owner.authHeaders,
      }),
    );
    expect(stillThere.environment.projectId).toBe(otherProjectId);
  });
});
