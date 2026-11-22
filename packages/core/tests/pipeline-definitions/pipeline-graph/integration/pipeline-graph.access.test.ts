import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  addProjectMember,
  createEnvironmentsTestClient,
  createEnvironmentsTestProject,
  createEnvironmentsTestUser,
  type EnvironmentsTestUser,
} from "../../environment/integration/environment-test-support";
import {
  buildAgentStepDefinitionPayload,
  singleStepPipelineDocument,
} from "../../pipeline-test-support";

describe("pipeline definition access", () => {
  const apiClient = createEnvironmentsTestClient();
  let owner: EnvironmentsTestUser;
  let writer: EnvironmentsTestUser;
  let admin: EnvironmentsTestUser;
  let projectId: UuidV7;
  let stepKey: string;

  const pushPipeline = (user: EnvironmentsTestUser) => {
    const document = singleStepPipelineDocument(
      `pipeline-${crypto.randomUUID()}`,
      stepKey,
    );
    return apiClient.api["pipeline-definitions"].post(
      { projectId, key: document.key, name: "Access pipeline", document },
      { headers: user.authHeaders },
    );
  };

  beforeAll(async () => {
    owner = await createEnvironmentsTestUser("pipeline-owner");
    writer = await createEnvironmentsTestUser("pipeline-writer");
    admin = await createEnvironmentsTestUser("pipeline-admin");
    projectId = await createEnvironmentsTestProject(apiClient, owner);
    await addProjectMember(apiClient, projectId, owner, writer, "write");
    await addProjectMember(apiClient, projectId, owner, admin, "admin");
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildAgentStepDefinitionPayload(projectId),
        { headers: owner.authHeaders },
      ),
    );
    stepKey = stepDefinition.key;
  });

  concurrentTest("a write member cannot push a pipeline", async () => {
    const { data, error } = await pushPipeline(writer);

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.value).toMatchObject({
      code: "PROJECT_FORBIDDEN",
      detail: "You do not have the pipelines:write permission on this project",
    });
  });

  concurrentTest("a write member cannot create a step definition", async () => {
    const { error } = await apiClient.api["step-definitions"].post(
      buildAgentStepDefinitionPayload(projectId),
      { headers: writer.authHeaders },
    );

    expect(error?.status).toBe(403);
  });

  concurrentTest("an admin can push a pipeline", async () => {
    const created = await unwrapAsync(pushPipeline(admin));

    expect(created.name).toBe("Access pipeline");
  });
});
