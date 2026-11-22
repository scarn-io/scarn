import { Box } from "@mui/material";
import { redirect } from "next/navigation";
import {
  DrizzleAuthUserRepo,
  usernameSuggestionCandidates,
} from "@scarn/identity";
import { getServerSession } from "@/app/_lib/auth";
import { getSafeCallbackUrl, loginRedirectPath } from "@/app/_lib/callback-url";
import { ChooseUsernameCard } from "@/components/auth/choose-username-card";

export const dynamic = "force-dynamic";

async function suggestAvailableUsername(user: {
  githubLogin?: string | null;
  name: string;
  email: string;
}): Promise<string> {
  const repo = new DrizzleAuthUserRepo();
  try {
    for (const candidate of usernameSuggestionCandidates(user)) {
      if (!(await repo.isUsernameTaken(candidate))) {
        return candidate;
      }
    }
  } catch {
    return "";
  }
  return "";
}

export default async function ChooseUsernamePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const callbackUrl = getSafeCallbackUrl(params["callbackUrl"]);
  const session = await getServerSession();

  // Onboarding requires a session (the user already exists post-OAuth) but not
  // a chosen username — that's the whole point of this screen. `loginRedirectPath`
  // captures this page's own URL (including its `callbackUrl`), so signing in
  // lands back here with the original destination still intact.
  if (!session) {
    redirect(await loginRedirectPath());
  }

  // Already onboarded: nothing left to do here — send them wherever they were
  // originally headed (defaults to "/" when there's no destination to return to).
  if (session.user.usernameChosen) {
    redirect(callbackUrl);
  }

  const initialUsername = await suggestAvailableUsername(session.user);

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 2,
      }}
    >
      <ChooseUsernameCard
        callbackUrl={callbackUrl}
        initialUsername={initialUsername}
      />
    </Box>
  );
}
