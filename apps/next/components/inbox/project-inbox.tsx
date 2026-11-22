"use client";

/**
 * The project Inbox: what waits on the viewer (agent Tasks and pipeline
 * waits, each answerable in place), the work items waiting on them that
 * nothing has started, their agent work that stopped, and their other
 * notifications. A footnote points at the agents waiting on other people.
 */

import type { ReactNode } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  Link as MuiLink,
  Stack,
  Typography,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import Link from "next/link";
import type { UserNotificationContract } from "@scarn/api/frontend-contracts";
import { RecordList } from "@/components/common/record-list/record-list";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { ProjectNotificationsPanel } from "@/components/notifications/project-notifications-panel";
import { useProjectPath } from "@/components/project-route-context";
import { INBOX_POLL_MS, notifyInboxChanged } from "./inbox-api";
import {
  InboxFailedTaskRow,
  InboxTaskRow,
  InboxWaitRow,
  InboxWorkItemRow,
} from "./inbox-rows";
import { useProjectInbox } from "./use-project-inbox";

function Rows({ rows }: { rows: { key: string; node: ReactNode }[] }) {
  return rows.map((row, index) => (
    <Box
      key={row.key}
      sx={{ borderTop: index ? 1 : 0, borderColor: "divider" }}
    >
      {row.node}
    </Box>
  ));
}

export function ProjectInbox({
  projectId,
  initialNotifications,
  pollIntervalMs,
}: {
  projectId: string;
  initialNotifications: UserNotificationContract[];
  pollIntervalMs?: number;
}) {
  const projectPath = useProjectPath();
  const inbox = useProjectInbox(projectId, pollIntervalMs);
  const waitingRows = [
    ...inbox.waitingTasks.map((task) => ({
      key: task.id,
      node: <InboxTaskRow task={task} onChanged={notifyInboxChanged} />,
    })),
    ...inbox.waits.map((wait) => ({
      key: wait.visitId,
      node: <InboxWaitRow wait={wait} onChanged={notifyInboxChanged} />,
    })),
  ];
  const waitingOnOthers = inbox.summary?.waitingOnOthers ?? 0;

  return (
    <Stack spacing={3}>
      {inbox.error ? <Alert severity="error">{inbox.error}</Alert> : null}

      <Box component="section" aria-label="Waiting on your reply">
        <RecordList
          title="Waiting on your reply"
          {...(inbox.loading ? {} : { count: waitingRows.length })}
        >
          {inbox.loading ? (
            <Stack alignItems="center" sx={{ py: 4 }}>
              <CircularProgress size={20} />
            </Stack>
          ) : waitingRows.length === 0 ? (
            <RecordListEmpty
              icon={<CheckCircleOutlineIcon fontSize="medium" />}
              title="Nothing is waiting on you"
              description="Agents and pipeline runs that need your reply or decision show up here."
            />
          ) : (
            <Rows rows={waitingRows} />
          )}
        </RecordList>
      </Box>

      {inbox.workItems.length > 0 ? (
        <Box component="section" aria-label="Work items waiting on you">
          <RecordList
            title="Work items waiting on you"
            count={inbox.workItems.length}
          >
            <Rows
              rows={inbox.workItems.map((workItem) => ({
                key: workItem.id,
                node: <InboxWorkItemRow workItem={workItem} />,
              }))}
            />
          </RecordList>
        </Box>
      ) : null}

      {inbox.failedTasks.length > 0 ? (
        <Box component="section" aria-label="Agent work that stopped">
          <RecordList
            title="Agent work that stopped"
            count={inbox.failedTasks.length}
          >
            <Rows
              rows={inbox.failedTasks.map((task) => ({
                key: task.id,
                node: <InboxFailedTaskRow task={task} />,
              }))}
            />
          </RecordList>
        </Box>
      ) : null}

      <Box component="section" aria-label="Other notifications">
        <ProjectNotificationsPanel
          projectId={projectId}
          initialNotifications={initialNotifications}
          title="Other notifications"
          pollIntervalMs={pollIntervalMs ?? INBOX_POLL_MS}
        />
      </Box>

      {waitingOnOthers > 0 ? (
        <Typography variant="body2" color="text.secondary">
          <MuiLink
            component={Link}
            href={`${projectPath("runs")}?status=needs-you`}
            underline="hover"
          >
            {waitingOnOthers === 1
              ? "1 agent is waiting on other people"
              : `${String(waitingOnOthers)} agents are waiting on other people`}
          </MuiLink>
        </Typography>
      ) : null}
    </Stack>
  );
}
