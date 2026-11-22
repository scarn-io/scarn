import { redirect } from "next/navigation";
import { getServerSession } from "@/app/_lib/auth";
import { AccountSettingsPageClient } from "@/components/settings/account-settings-page-client";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const session = await getServerSession();

  // The protected layout already redirects unauthenticated users, but read the
  // session here so we can hand the current username to the client component
  // without an extra round-trip.
  if (!session) {
    redirect("/login?callbackUrl=/account/settings");
  }

  // The protected layout guarantees onboarded users here (non-null username),
  // but narrow explicitly so the client contract stays non-null.
  if (session.user.username == null) {
    redirect("/onboarding/username");
  }

  return (
    <AccountSettingsPageClient currentUsername={session.user.username} />
  );
}
