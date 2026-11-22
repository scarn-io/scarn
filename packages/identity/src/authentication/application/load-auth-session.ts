import { authSessionWithUserEntityToContract } from "./auth-entity-to-contract";
import type { AuthSessionRepo } from "./auth-session-repo";
import type { AuthUserRepo } from "./auth-user-repo";
import type { AuthSessionWithUser } from "../contracts/auth-contracts";

export async function loadAuthSessionByToken(
  token: string,
  deps: {
    authSessionRepo: AuthSessionRepo;
    authUserRepo: AuthUserRepo;
  },
): Promise<AuthSessionWithUser | null> {
  const session = await deps.authSessionRepo.loadByToken(token);

  if (!session || session.isExpired()) {
    return null;
  }

  const user = await deps.authUserRepo.load(session.userId);

  if (!user) {
    return null;
  }

  return authSessionWithUserEntityToContract(session, user);
}
