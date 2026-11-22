import type { ProjectRole } from "@/projects/project/domain/project-role";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { EnvironmentContentInput } from "@/common/contracts/environment";
import { createAppContext } from "@/lib/di";
import { createScarnApiClient } from "tests/treaty";
import { unwrapAsync } from "tests/utils";
import {
  createTestUserAndSession,
  type TestUserAndSession,
} from "tests/projects/project/integration/auth-test-utils";

export type EnvironmentsTestClient = ReturnType<typeof createScarnApiClient>;

export type EnvironmentsTestUser = TestUserAndSession & { email: string };

export const createEnvironmentsTestClient = (): EnvironmentsTestClient =>
  createScarnApiClient(createApp(createAppContext()));

export const createEnvironmentsTestUser = async (
  label: string,
): Promise<EnvironmentsTestUser> => {
  const email = `environments-${label}-${crypto.randomUUID()}@example.com`;
  const user = await createTestUserAndSession({ email });
  return { ...user, email };
};

/** A project created by `owner`, who becomes its admin. */
export const createEnvironmentsTestProject = async (
  apiClient: EnvironmentsTestClient,
  owner: TestUserAndSession,
): Promise<UuidV7> => {
  const project = await unwrapAsync(
    apiClient.api.projects.post(
      {
        name: `Environments ${crypto.randomUUID()}`,
        description: null,
        gitUrl: "https://github.com/example/environments.git",
      },
      { headers: owner.authHeaders },
    ),
  );
  return parseUuidV7(project.id);
};

/** A `read` member holds `executions:read` but not `executions:write`. */
export const addProjectMember = async (
  apiClient: EnvironmentsTestClient,
  projectId: UuidV7,
  owner: TestUserAndSession,
  member: EnvironmentsTestUser,
  role: ProjectRole,
): Promise<void> => {
  const { inviteUrl } = await unwrapAsync(
    apiClient.api
      .projects({ projectId })
      .invites.post(
        { email: member.email, role, restriction: "specific_email" },
        { headers: owner.authHeaders },
      ),
  );
  const token = inviteUrl.split("/invite/")[1] ?? "";
  await unwrapAsync(
    apiClient.api["project-invites"]({ token }).accept.post(undefined, {
      headers: member.authHeaders,
    }),
  );
};

export const uniqueEnvironmentName = (): string =>
  `env-${crypto.randomUUID().slice(0, 8)}`;

export const environmentContent = (
  overrides: Partial<EnvironmentContentInput> = {},
): EnvironmentContentInput => ({
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
  ...overrides,
});

/** Upserts an active agent step definition whose environment is `name`. */
export const putStepUsingEnvironment = async (
  apiClient: EnvironmentsTestClient,
  headers: TestUserAndSession["authHeaders"],
  projectId: UuidV7,
  key: string,
  environment: string,
) =>
  await unwrapAsync(
    apiClient.api["step-definitions"].put(
      {
        projectId,
        key,
        name: `Step ${key}`,
        kind: "user_defined",
        version: 1,
        description: null,
        prompt: "Do the thing",
        inputSchemaJson: { type: "object", properties: {} },
        resultSchemaJson: null,
        status: "active",
        environment: { kind: "named", name: environment },
      },
      { headers },
    ),
  );
