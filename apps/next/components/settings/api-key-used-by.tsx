"use client";

import { useState } from "react";
import { Button, Stack, Typography } from "@mui/material";
import type { SecretContract } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";

const STOP_USING_ERROR = "Couldn't stop using that API key. Try again.";

/**
 * "Used by" lines for a saved key that is lent to project integrations for
 * auto-sync, each with a "Stop using" action that turns auto-sync off there.
 */
export function ApiKeyUsedBy({
  apiKey,
  onStart,
  onUpdated,
  onError,
}: {
  apiKey: SecretContract;
  onStart: () => void;
  onUpdated: (secret: SecretContract) => void;
  onError: (message: string) => void;
}) {
  const [stopping, setStopping] = useState<string | null>(null);
  if (apiKey.usedBy.length === 0) return null;

  const stopUsing = (integrationId: string) => {
    onStart();
    setStopping(integrationId);
    void getBrowserScarnApiClient()
      .api.me.secrets({ secretId: parseUuidV7(apiKey.id) })
      .uses({ integrationId: parseUuidV7(integrationId) })
      .delete()
      .then(({ data, error }) => {
        if (error) {
          onError(parseApiError(error, STOP_USING_ERROR));
          return;
        }
        onUpdated(data);
      })
      .catch(() => {
        onError(STOP_USING_ERROR);
      })
      .finally(() => {
        setStopping(null);
      });
  };

  return (
    <Stack spacing={0.5} component="ul" sx={{ p: 0, m: 0 }}>
      {apiKey.usedBy.map((use) => (
        <Stack
          key={use.integrationId}
          component="li"
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ listStyle: "none" }}
        >
          <Typography variant="caption" color="text.secondary">
            {`Used by: ${use.projectName} auto-sync`}
          </Typography>
          <Button
            size="small"
            aria-label={`Stop using ${apiKey.name} for ${use.projectName} auto-sync`}
            loading={stopping === use.integrationId}
            disabled={stopping !== null && stopping !== use.integrationId}
            onClick={() => {
              stopUsing(use.integrationId);
            }}
          >
            Stop using
          </Button>
        </Stack>
      ))}
    </Stack>
  );
}
