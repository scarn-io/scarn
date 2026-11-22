"use client";

import {
  Alert,
  Checkbox,
  FormControlLabel,
  Stack,
  Typography,
} from "@mui/material";
import {
  autoSyncConsent,
  type AutoSyncIntegration,
} from "@/components/integrations/auto-sync-text";

/**
 * The opt-in "Auto-sync with this key" box offered when a saved Jira key or
 * GitHub token is chosen, with the consent text the owner agrees to.
 */
export function AutoSyncConsentField({
  integration,
  githubAppConfigured,
  checked,
  onChange,
}: {
  integration: AutoSyncIntegration;
  githubAppConfigured: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const consent = autoSyncConsent(integration, githubAppConfigured);
  return (
    <Stack spacing={1}>
      <FormControlLabel
        control={
          <Checkbox
            checked={checked}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
        }
        label="Auto-sync with this key"
      />
      <Typography variant="caption" color="text.secondary">
        {consent.text}
      </Typography>
      {consent.appHint ? (
        <Alert severity="info">{consent.appHint}</Alert>
      ) : null}
    </Stack>
  );
}
