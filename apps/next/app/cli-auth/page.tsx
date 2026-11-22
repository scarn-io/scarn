import { Box } from "@mui/material";
import { redirect } from "next/navigation";
import { getServerSession } from "@/app/_lib/auth";
import { loginRedirectPath } from "@/app/_lib/callback-url";
import { CliAuthCard } from "@/components/auth/cli-auth-card";

const getSingleValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const getSafeUserCode = (value: string | string[] | undefined) => {
  const userCode = getSingleValue(value)?.trim().toUpperCase() ?? "";
  const normalizedUserCode = userCode.replace(/[^A-Z0-9]/gu, "");
  return normalizedUserCode.length > 0 ? normalizedUserCode : null;
};

export default async function CliAuthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const userCode = getSafeUserCode(params["user_code"]);
  const session = await getServerSession();

  if (!session) {
    redirect(await loginRedirectPath());
  }

  // Pick the username before approving, so it isn't sprung on the user midway
  // through the CLI hand-off. The code rides along and comes back here.
  if (!session.user.usernameChosen) {
    const callbackUrl = userCode
      ? `/cli-auth?user_code=${encodeURIComponent(userCode)}`
      : "/cli-auth";
    redirect(`/onboarding/username?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

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
      <CliAuthCard initialUserCode={userCode} />
    </Box>
  );
}
