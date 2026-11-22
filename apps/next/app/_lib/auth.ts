import { headers } from "next/headers";
import { getIdentityAuth } from "@scarn/identity";

// Reads through `session.cookieCache`. The onboarding gate in
// `(protected)/layout.tsx` and the `username` reads beneath it branch on
// `usernameChosen`/`username`, and every write to those fields now goes through
// Better Auth, which re-signs the snapshot in the same response that changes the
// row — so a cached read here cannot be stale. See `session.cookieCache` in
// `packages/identity/src/lib/auth.ts` for the full rationale.
export async function getServerSession() {
  return await getIdentityAuth().api.getSession({
    headers: await headers(),
  });
}

export async function canInvokeActions() {
  return (await getServerSession()) !== null;
}

export async function requireActionPermission() {
  const session = await getServerSession();

  if (!session) {
    throw new Error("Authentication required");
  }

  return session;
}
