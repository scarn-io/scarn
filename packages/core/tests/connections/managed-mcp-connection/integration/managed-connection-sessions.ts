import { randomBytes } from "node:crypto";
import {
  AuthSessionEntity,
  createAuthId,
  DrizzleAuthSessionRepo,
} from "@scarn/identity";
import type { ProjectSecretsTestUser } from "tests/secrets/secret/integration/project-secret-test-support";

/** A second signed-in browser session for an existing user. */
export const createSecondSession = async (
  user: ProjectSecretsTestUser,
): Promise<ProjectSecretsTestUser> => {
  const sessionToken = randomBytes(32).toString("hex");
  await new DrizzleAuthSessionRepo().save(
    new AuthSessionEntity(
      createAuthId(),
      user.userId,
      sessionToken,
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    ),
  );
  return {
    ...user,
    sessionToken,
    authHeaders: { authorization: `Bearer ${sessionToken}` },
  };
};
