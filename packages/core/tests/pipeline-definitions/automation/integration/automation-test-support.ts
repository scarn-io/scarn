import type { ProjectRole } from "@/projects/project/domain/project-role";
import { createApp } from "@scarn/api/app";
import type { AnyJsonObject } from "@/common/contracts/json";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { createAppContext } from "@/lib/di";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  buildAgentStepDefinitionPayload,
  createPipelineFromDocument,
  singleStepPipelineDocument,
} from "../../pipeline-test-support";

export type ApiClient = ReturnType<typeof createScarnTreaty>;
export type AuthHeaders = { authorization: string };

export type AutomationFixture = {
  apiClient: ApiClient;
  headers: AuthHeaders;
  ownerUserId: UuidV7;
  projectId: UuidV7;
  /** A step taking `{ question: string }` (required) and `{ tags: string[] }`. */
  researchStepKey: string;
  /** A step taking no inputs. */
  planStepKey: string;
  pipelineKey: string;
};

/** A project with two steps and a pipeline, for automations to route to. */
export const createAutomationFixture = async (
  label: string,
): Promise<AutomationFixture> => {
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-11-01T09:00:00.000Z")),
      }),
    ),
  );
  const owner = await createTestUserAndSession({
    email: `automation-${label}-${crypto.randomUUID()}@example.com`,
  });
  const headers = owner.authHeaders;
  const project = await unwrapAsync(
    apiClient.api.projects.post(
      {
        name: `Automation ${label} project`,
        description: "Project for automation tests",
        gitUrl: "https://github.com/example/test-project.git",
      },
      { headers: { ...headers } },
    ),
  );
  const projectId = parseUuidV7(project.id);
  const research = await unwrapAsync(
    apiClient.api["step-definitions"].post(
      {
        ...buildAgentStepDefinitionPayload(projectId, "research"),
        inputSchemaJson: {
          type: "object",
          properties: {
            question: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
      { headers: { ...headers } },
    ),
  );
  const plan = await unwrapAsync(
    apiClient.api["step-definitions"].post(
      buildAgentStepDefinitionPayload(projectId, "plan"),
      { headers: { ...headers } },
    ),
  );
  const pipeline = await createPipelineFromDocument(
    apiClient,
    headers,
    projectId,
    singleStepPipelineDocument("bugfix", plan.key),
  );
  return {
    apiClient,
    headers,
    ownerUserId: parseUuidV7(owner.userId),
    projectId,
    researchStepKey: research.key,
    planStepKey: plan.key,
    pipelineKey: pipeline.key,
  };
};

export const workItemAutomationDocument = (
  key: string,
  rules: readonly object[],
): AnyJsonObject => ({
  kind: "automation",
  schemaVersion: 1,
  key,
  title: `Automation ${key}`,
  scope: "workItem",
  rules: rules as AnyJsonObject[],
});

export const projectAutomationDocument = (
  key: string,
  rules: readonly object[],
): AnyJsonObject => ({
  kind: "automation",
  schemaVersion: 1,
  key,
  scope: "project",
  rules: rules as AnyJsonObject[],
});

export const publishAutomationRequest = (
  fixture: Pick<AutomationFixture, "apiClient" | "projectId">,
  document: AnyJsonObject,
  headers: AuthHeaders,
  key = document["key"] as string,
) =>
  fixture.apiClient.api
    .projects({ projectId: fixture.projectId })
    .automations({ key })
    .put({ document }, { headers: { ...headers } });

export const createWorkItem = async (
  { apiClient, projectId }: Pick<AutomationFixture, "apiClient" | "projectId">,
  headers: AuthHeaders,
) =>
  await unwrapAsync(
    apiClient.api["work-items"].post(
      {
        projectId,
        platform: "scarn",
        platformId: null,
        platformKey: `manual-${crypto.randomUUID()}`,
        url: null,
        title: "Parent work item",
        description: "Description",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: null,
      },
      { headers: { ...headers } },
    ),
  );

/** A project member with `role`. */
export const createMember = async (
  { apiClient, projectId, headers }: AutomationFixture,
  role: ProjectRole,
) => {
  const member = await createTestUserAndSession({
    email: `automation-member-${crypto.randomUUID()}@example.com`,
  });
  await unwrapAsync(
    apiClient.api
      .projects({ projectId })
      .members({ userId: member.userId })
      .role.put({ role }, { headers: { ...headers } }),
  );
  return member.authHeaders;
};
