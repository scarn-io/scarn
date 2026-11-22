import { OrganizationSettingsPageClient } from "@/components/settings/organization-settings-page-client";

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return <OrganizationSettingsPageClient orgId={orgId} />;
}
