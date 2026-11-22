"use client";

import { useEffect, useState } from "react";
import { Alert, CircularProgress, Stack, Typography } from "@mui/material";
import type { UsageMeterContract } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { PageHeader } from "@/components/page-header";
import { OrganizationUsagePanel } from "@/components/settings/organization-usage-panel";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; usage: UsageMeterContract };

export function OrganizationSettingsPageClient({
  orgId,
}: {
  orgId: string;
}) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadState({ status: "loading" });

      try {
        const scarnApiClient = getBrowserScarnApiClient();
        const { data } = await scarnApiClient.api
          .orgs({ orgId })
          .usage.get();

        if (cancelled) return;

        if (!data) {
          throw new Error("Failed to load organization usage");
        }

        setLoadState({ status: "ready", usage: data });
      } catch (error) {
        if (cancelled) return;

        setLoadState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to load organization usage",
        });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <Stack spacing={4}>
      <PageHeader
        title="Organization"
        description="Track this organization's usage against its plan limits."
      />
      <Stack spacing={2}>
        <Typography variant="h6">Usage</Typography>
        <Typography variant="body2" color="text.secondary">
          Your organization&apos;s current usage as a percentage of your plan
          limits.
        </Typography>
        {loadState.status === "loading" ? (
          <Stack
            spacing={2}
            alignItems="center"
            justifyContent="center"
            sx={{ minHeight: 160 }}
          >
            <CircularProgress size={24} />
            <Typography color="text.secondary">Loading usage...</Typography>
          </Stack>
        ) : loadState.status === "error" ? (
          <Alert severity="error">{loadState.message}</Alert>
        ) : (
          <OrganizationUsagePanel usage={loadState.usage} />
        )}
      </Stack>
    </Stack>
  );
}
