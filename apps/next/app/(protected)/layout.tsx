import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getServerSession } from "@/app/_lib/auth";
import { loginRedirectPath, onboardingRedirectPath } from "@/app/_lib/callback-url";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession();

  if (!session) {
    redirect(await loginRedirectPath());
  }

  // Every new user — social signup and dev login alike — is created with a
  // null username and `usernameChosen: false`. That flag, not the username
  // value, is the source of truth, so send them to onboarding until they
  // confirm one.
  if (!session.user.usernameChosen) {
    redirect(await onboardingRedirectPath());
  }

  return <AppShell initialUser={session.user}>{children}</AppShell>;
}
