"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import type {
  NotificationRuleContract,
  UserNotificationKind,
  NotificationChannel,
  NotificationPriority,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { useHasProjectPermission } from "@/components/project-route-context";

const KIND_LABELS: Record<UserNotificationKind, string> = {
  feedback_request: "Feedback Request",
  status_update: "Status Update",
  blocked: "Blocked",
  result_ready: "Result Ready",
  warning: "Warning",
  integration_auto_sync_paused: "Auto-sync Paused",
};

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: "In-App",
  work_item_platform_comment: "Work Item Comment",
  email: "Email",
  slack: "Slack",
};

const PRIORITY_OPTIONS: Array<{ value: NotificationPriority | ""; label: string }> = [
  { value: "", label: "Any priority" },
  { value: "low", label: "Low and above" },
  { value: "normal", label: "Normal and above" },
  { value: "high", label: "High and above" },
  { value: "urgent", label: "Urgent only" },
];

const NOTIFICATION_KINDS: UserNotificationKind[] = [
  "feedback_request",
  "status_update",
  "blocked",
  "result_ready",
  "warning",
  "integration_auto_sync_paused",
];

const NOTIFICATION_CHANNELS: NotificationChannel[] = [
  "in_app",
  "email",
  "slack",
];

const IN_APP_ALWAYS_ON_NOTE =
  "In-app is always enabled regardless of rules. It is the platform's escape hatch.";

function getRuleKey(kind: UserNotificationKind, channel: NotificationChannel) {
  return `${kind}:${channel}`;
}

type RuleMap = Map<string, NotificationRuleContract>;

function buildRuleMap(rules: NotificationRuleContract[]): RuleMap {
  return new Map(rules.map((r) => [getRuleKey(r.kind, r.channel), r]));
}

type RuleRowProps = {
  kind: UserNotificationKind;
  channel: NotificationChannel;
  rule: NotificationRuleContract | undefined;
  projectId: string;
  onUpdated: (rule: NotificationRuleContract) => void;
};

function RuleRow({ kind, channel, rule, projectId, onUpdated }: RuleRowProps) {
  const isInApp = channel === "in_app";
  const canEdit = useHasProjectPermission("settings:write");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const enabled = isInApp ? true : (rule?.enabled ?? false);
  const minPriority = rule?.minPriority ?? null;
  const minPrioritySelectValue: NotificationPriority | "" = minPriority ?? "";

  const upsert = (patch: {
    enabled?: boolean;
    minPriority?: NotificationPriority | null;
  }) => {
    if (isInApp) return; // in_app is always on — no user control
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api
        .projects({ projectId })
        ["notification-rules"].put({
          kind,
          channel,
          enabled: patch.enabled ?? enabled,
          minPriority: patch.minPriority !== undefined ? patch.minPriority : minPriority,
          conditionsJson: rule?.conditionsJson ?? null,
        });
      if (err) {
        setError(parseApiError(err, "Could not save rule. Try again."));
        return;
      }
      onUpdated(data);
    });
  };

  return (
    <Box>
      {error ? (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      ) : null}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        alignItems={{ sm: "center" }}
      >
        <Box sx={{ minWidth: 80 }}>
          <Chip
            label={CHANNEL_LABELS[channel]}
            size="small"
            variant={enabled ? "filled" : "outlined"}
            color={enabled ? "primary" : "default"}
          />
        </Box>

        <FormControlLabel
          control={
            <Switch
              checked={enabled}
              disabled={isInApp || isPending || !canEdit}
              onChange={(e) => {
                upsert({ enabled: e.target.checked });
              }}
              size="small"
            />
          }
          label={
            <Typography variant="body2">
              {isInApp ? "Always on" : enabled ? "Enabled" : "Disabled"}
            </Typography>
          }
        />

        {!isInApp ? (
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Min priority</InputLabel>
            <Select
              value={minPrioritySelectValue}
              label="Min priority"
              disabled={isPending || !enabled || !canEdit}
              onChange={(e) => {
                const val = e.target.value as NotificationPriority | "";
                upsert({
                  minPriority: val === "" ? null : val,
                });
              }}
            >
              {PRIORITY_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : null}

        {isPending ? (
          <Typography variant="caption" color="text.secondary">
            Saving…
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}

type NotificationRulesPanelProps = {
  projectId: string;
  initialRules: NotificationRuleContract[];
};

export function NotificationRulesPanel({
  projectId,
  initialRules,
}: NotificationRulesPanelProps) {
  const [ruleMap, setRuleMap] = useState<RuleMap>(() => buildRuleMap(initialRules));

  const handleUpdated = (rule: NotificationRuleContract) => {
    setRuleMap((prev) => {
      const next = new Map(prev);
      next.set(getRuleKey(rule.kind, rule.channel), rule);
      return next;
    });
  };

  return (
    <Stack spacing={2}>
      <Alert severity="info" sx={{ maxWidth: 640 }}>
        {IN_APP_ALWAYS_ON_NOTE}
      </Alert>

      <Stack spacing={2}>
        {NOTIFICATION_KINDS.map((kind) => (
          <Card key={kind} variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {KIND_LABELS[kind]}
                </Typography>
                <Stack spacing={1.5}>
                  {NOTIFICATION_CHANNELS.map((channel) => (
                    <RuleRow
                      key={channel}
                      kind={kind}
                      channel={channel}
                      rule={ruleMap.get(getRuleKey(kind, channel))}
                      projectId={projectId}
                      onUpdated={handleUpdated}
                    />
                  ))}
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}
