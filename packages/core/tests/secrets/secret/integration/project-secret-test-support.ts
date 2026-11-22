import type { ProjectRole } from "@/projects/project/domain/project-role";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { unwrapAsync } from "tests/utils";
import {
  createTestUserAndSession,
  type TestUserAndSession,
} from "tests/projects/project/integration/auth-test-utils";
import type { createSecretsTestClient } from "./secret-test-support";

type SecretsTestClient = ReturnType<typeof createSecretsTestClient>;

export type ProjectSecretsTestUser = TestUserAndSession & {
  email: string;
  username: string;
};

export const createProjectSecretsTestUser = async (
  label: string,
): Promise<ProjectSecretsTestUser> => {
  const email = `project-secrets-${label}-${crypto.randomUUID()}@example.com`;
  const username = `ps-${label}-${crypto.randomUUID().slice(0, 8)}`;
  const user = await createTestUserAndSession({ email, username });
  return { ...user, email, username };
};

/** A project created by `owner` (an admin), so it holds `secrets:write`. */
export const createProjectSecretsTestProject = async (
  apiClient: SecretsTestClient,
  owner: TestUserAndSession,
): Promise<UuidV7> => {
  const project = await unwrapAsync(
    apiClient.api.projects.post(
      {
        name: `Project Secrets ${crypto.randomUUID()}`,
        description: null,
        gitUrl: "https://github.com/example/project-secrets.git",
      },
      { headers: owner.authHeaders },
    ),
  );
  return parseUuidV7(project.id);
};

/** Invites and accepts `member` with the `write` role: `secrets:read` but not `secrets:write`. */
export const addWriteMember = async (
  apiClient: SecretsTestClient,
  projectId: UuidV7,
  owner: TestUserAndSession,
  member: ProjectSecretsTestUser,
): Promise<void> => {
  await addProjectMember(apiClient, projectId, owner, member, "write");
};

export const addProjectMember = async (
  apiClient: SecretsTestClient,
  projectId: UuidV7,
  owner: TestUserAndSession,
  member: ProjectSecretsTestUser,
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

export const projectSecretValue = (): string =>
  `sk-live-${crypto.randomUUID()}`;
