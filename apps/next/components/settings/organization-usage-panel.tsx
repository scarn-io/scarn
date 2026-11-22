import { LinearProgress, Stack, Typography } from "@mui/material";
import type { UsageMeterContract } from "@scarn/api/frontend-contracts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

const formatBytes = (bytes: number): string => {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${bytes.toLocaleString()} B`;
};

const formatCount = (count: number): string => count.toLocaleString();

/**
 * Usage as a 0–100 percentage of the limit, clamped and guarding against a
 * zero/absent limit (which would otherwise divide by zero).
 */
const toPercent = (current: number, limit: number): number => {
  if (limit <= 0) return current > 0 ? 100 : 0;
  return Math.min(100, Math.round((current / limit) * 100));
};

const formatResetDate = (isoDate: string): string =>
  new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));

/**
 * Non-interactive sub-breakdown of the Storage bar's current value, split by
 * source (artifacts, archived task logs and saved agent sessions). This is a live
 * snapshot (see `usageStorageBreakdownSchema`), not a persisted counter, so it
 * is rendered as plain text rather than its own progress bar — there is no
 * separate "limit" for either source to bar against.
 */
function StorageBreakdown({
  artifactBytes,
  logBytes,
  sessionBytes,
}: {
  artifactBytes: number;
  logBytes: number;
  sessionBytes: number;
}) {
  return (
    <Stack direction="row" spacing={2} sx={{ pl: 0.25 }}>
      <Typography variant="caption" color="text.secondary">
        Artifacts: {formatBytes(artifactBytes)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Logs: {formatBytes(logBytes)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Sessions: {formatBytes(sessionBytes)}
      </Typography>
    </Stack>
  );
}

function UsageMetric({
  label,
  current,
  limit,
  format,
}: {
  label: string;
  current: number;
  limit: number | null;
  format: (value: number) => string;
}) {
  if (limit === null) {
    return (
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="baseline"
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {format(current)} (no limit)
        </Typography>
      </Stack>
    );
  }

  const percent = toPercent(current, limit);
  return (
    <Stack spacing={0.75}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="baseline"
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {format(current)} / {format(limit)} ({percent}%)
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={percent}
        aria-label={`${label} usage`}
        sx={{
          height: 8,
          borderRadius: 4,
          backgroundColor: "action.hover",
        }}
      />
    </Stack>
  );
}

export function OrganizationUsagePanel({
  usage,
}: {
  usage: UsageMeterContract;
}) {
  return (
    <Stack spacing={3}>
      <Stack spacing={2.5}>
        <UsageMetric
          label="Writes"
          current={usage.writes}
          limit={usage.limits.maxWritesPerMonth}
          format={formatCount}
        />
        <UsageMetric
          label="Reads"
          current={usage.reads}
          limit={usage.limits.maxReadsPerMonth}
          format={formatCount}
        />
        <Stack spacing={0.5}>
          <UsageMetric
            label="Push sessions"
            current={usage.signalTokens}
            limit={usage.limits.maxSignalTokensPerMonth}
            format={formatCount}
          />
          {usage.limits.maxSignalTokensPerMonth !== null && (
            <Typography variant="body2" color="text.secondary">
              Each <code>scarn work</code> worker uses about 5 push sessions per
              hour while running. Over the limit, workers keep running and check
              for work by polling instead; restart them after the reset to turn
              push back on.
            </Typography>
          )}
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Writes, reads and push sessions reset on{" "}
        {formatResetDate(usage.resetsAt)}.
      </Typography>
      <Stack spacing={0.5}>
        <UsageMetric
          label="Storage"
          current={usage.storageBytes}
          limit={usage.limits.maxStorageBytes}
          format={formatBytes}
        />
        <StorageBreakdown
          artifactBytes={usage.storageBreakdown.artifactBytes}
          logBytes={usage.storageBreakdown.logBytes}
          sessionBytes={usage.storageBreakdown.sessionBytes}
        />
        <Typography variant="body2" color="text.secondary">
          Storage does not reset each period — it reflects data your
          organization currently retains and only decreases when artifacts are
          deleted or logs expire.
        </Typography>
      </Stack>
    </Stack>
  );
}
