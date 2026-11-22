import { Box } from "@mui/material";
import { redirect } from "next/navigation";
import {
  getDevLoginEnabled,
  getEmailPasswordLoginEnabled,
  getGitHubAppOAuthConfig,
  getGoogleOAuthConfig,
} from "@scarn/identity";
import { LoginCard } from "@/components/auth/login-card";
import { getServerSession } from "@/app/_lib/auth";
import { isDemoProjectEnabled } from "@/app/_lib/demo-project";
import { getSafeCallbackUrl, getSingleValue } from "@/app/_lib/callback-url";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const callbackUrl = getSafeCallbackUrl(params["callbackUrl"]);
  const session = await getServerSession();

  if (session) {
    redirect(callbackUrl);
  }

  const error = getSingleValue(params["error"]) ?? null;
  const githubEnabled = getGitHubAppOAuthConfig() !== null;
  const googleEnabled = getGoogleOAuthConfig() !== null;
  const emailPasswordEnabled = getEmailPasswordLoginEnabled();
  const devLoginEnabled = getDevLoginEnabled();

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
      <LoginCard
        callbackUrl={callbackUrl}
        error={error}
        githubEnabled={githubEnabled}
        googleEnabled={googleEnabled}
        emailPasswordEnabled={emailPasswordEnabled}
        devLoginEnabled={devLoginEnabled}
        showProviderSetupHint={process.env.NODE_ENV !== "production"}
        showDemoLink={isDemoProjectEnabled()}
      />
    </Box>
  );
}
