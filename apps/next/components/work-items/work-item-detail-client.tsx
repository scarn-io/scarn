"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Box, Stack, Tab, Tabs } from "@mui/material";
import type {
  UserNotificationContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import { authClient } from "@/app/_lib/auth-client";
import { RightDrawer } from "@/components/common/right-drawer";
import { ConversationSheet } from "@/components/conversations/conversation-sheet";
import {
  useWorkItemNotifications,
  type WorkItemNotificationsStatusFilter,
} from "@/components/notifications/use-work-item-notifications";
import {
  NotificationsStatusFilter,
  WorkItemNotificationsDrawerBody,
} from "@/components/notifications/work-item-notifications-drawer-body";
import { useWorkItemExecutions } from "@/components/executions/use-work-item-executions";
import {
  NewExecutionButton,
  WorkItemExecutionsDrawerBody,
} from "@/components/executions/work-item-executions-drawer-body";
import {
  useHasProjectPermission,
  useIsProjectMember,
} from "@/components/project-route-context";
import { isTaskActive, taskDisplayName } from "@/components/tasks/task-display";
import { useConversationParam } from "./use-conversation-param";
import { useWorkItemChildren } from "./use-work-item-children";
import { useWorkItemConversations } from "./use-work-item-conversations";
import { useWorkItemDecisionWaits } from "./use-work-item-decision-waits";
import { useWorkItemQuestions } from "./use-work-item-questions";
import { useWorkItemTasks } from "./use-work-item-tasks";
import { WorkItemAgentsPanel } from "./work-item-agents-panel";
import { WorkItemBodyEntry } from "./work-item-body-entry";
import { WorkItemChildrenSection } from "./work-item-children-section";
import { WorkItemCommentsSection } from "./work-item-comments-section";
import { WorkItemDetailHeader } from "./work-item-detail-header";
import { WorkItemProperties } from "./work-item-properties";
import { workItemRingStatus } from "./work-item-status-ring";
import { WorkItemTasksTab } from "./work-item-tasks-tab";

type ActiveDrawer = "none" | "notifications" | "executions";

export type WorkItemTab = "comments" | "tasks";

export function parseWorkItemTab(value: string | null): WorkItemTab {
  return value === "tasks" ? value : "comments";
}

/**
 * Client shell for the work item page: the header, the description, the
 * child work items, the agents panel and the Comments / Tasks tabs in the
 * main column, and the Properties panel beside it (below it under `lg`). Owns the data the
 * pieces share — Tasks, conversations, questions, runs, notifications — and
 * the drawer state (one drawer at a time), and the conversation sheet
 * (`?conversation=<id>`).
 */
export function WorkItemDetailClient({
  projectId,
  initialWorkItem,
}: {
  projectId: string;
  initialWorkItem: WorkItemContract;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseWorkItemTab(searchParams.get("tab"));
  const isMember = useIsProjectMember();
  const { data: session } = authClient.useSession();
  const [workItem, setWorkItem] = useState(initialWorkItem);
  const canUpdateWorkItems = useHasProjectPermission("work-items:write");
  const canEditWorkItem =
    isMember &&
    session?.user.id === workItem.createdByUserId &&
    workItem.platform === "scarn";
  const [commentsVersion, setCommentsVersion] = useState(0);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>("none");
  const [pinnedCount, setPinnedCount] = useState<number | undefined>(undefined);
  const [statusFilter, setStatusFilter] =
    useState<WorkItemNotificationsStatusFilter>("all");

  // Notifications are per-user and member-only (issue #150); a non-member
  // viewer never sees the trigger, so this fetch would only 401.
  const notificationsData = useWorkItemNotifications(
    projectId,
    workItem.id,
    statusFilter,
    isMember,
  );
  const executionsData = useWorkItemExecutions(projectId, workItem.id);
  const tasksData = useWorkItemTasks(projectId, workItem.id);
  const childrenData = useWorkItemChildren(workItem.id);
  const liveKey = useMemo(
    () =>
      [
        ...tasksData.tasks.map((task) => `${task.id}:${task.updatedAt}`),
        ...executionsData.executions.map(
          (execution) => `${execution.id}:${execution.updatedAt}`,
        ),
      ].join(","),
    [tasksData.tasks, executionsData.executions],
  );
  const conversationsData = useWorkItemConversations(workItem.id, liveKey);
  const questionsData = useWorkItemQuestions(workItem.id, liveKey);
  const decisionWaits = useWorkItemDecisionWaits(executionsData.executions);

  const activeTasks = useMemo(
    () => tasksData.tasks.filter((task) => isTaskActive(task.status)),
    [tasksData.tasks],
  );
  const conversationParam = useConversationParam();
  const sheetTask = conversationParam.conversationId
    ? tasksData.tasks.find(
        (task) => task.conversationId === conversationParam.conversationId,
      )
    : undefined;
  const openQuestions = useMemo(
    () =>
      questionsData.questions.filter((question) => question.status === "open"),
    [questionsData.questions],
  );
  const ringStatus = workItemRingStatus(
    workItem,
    tasksData.tasks,
    questionsData.questions,
  );

  const { refresh: refreshTasks } = tasksData;
  const { refresh: refreshConversations } = conversationsData;
  const { refresh: refreshQuestions } = questionsData;
  const { refresh: refreshExecutions } = executionsData;
  const handleAgentsChanged = useCallback(() => {
    refreshTasks();
    refreshConversations();
    refreshQuestions();
    void refreshExecutions();
    setCommentsVersion((version) => version + 1);
  }, [refreshTasks, refreshConversations, refreshQuestions, refreshExecutions]);

  const { setNotifications, refresh: refreshNotifications } = notificationsData;

  const handleDismissed = useCallback(
    (id: string) => {
      if (statusFilter === "all") {
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === id ? { ...n, status: "suppressed" as const } : n,
          ),
        );
      } else {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }
    },
    [statusFilter, setNotifications],
  );

  const handleResponded = useCallback(
    (updated: UserNotificationContract) => {
      setNotifications((prev) =>
        prev.map((n) => (n.id === updated.id ? updated : n)),
      );
      // Answering a feedback request may promote the answer into a project
      // context entry. Refresh server components so other panels reflect it.
      router.refresh();
      refreshNotifications();
    },
    [setNotifications, router, refreshNotifications],
  );

  const handleStateChanged = useCallback(
    (updated: WorkItemContract, postedComment: boolean) => {
      setWorkItem(updated);
      if (postedComment) setCommentsVersion((version) => version + 1);
      refreshTasks();
    },
    [refreshTasks],
  );

  const selectTab = (next: WorkItemTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "comments") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  const closeDrawer = useCallback(() => {
    setActiveDrawer("none");
  }, []);
  const openExecutions = useCallback(() => {
    setActiveDrawer("executions");
  }, []);

  return (
    <>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 1fr) 340px" },
          alignItems: "start",
          columnGap: 0,
          rowGap: 3,
        }}
      >
        <Stack spacing={3} sx={{ minWidth: 0, pr: { lg: 3 } }}>
          <WorkItemDetailHeader
            workItem={workItem}
            ringStatus={ringStatus}
            showNotifications={isMember}
            notificationCount={
              notificationsData.loading
                ? undefined
                : notificationsData.notifications.length
            }
            executionCount={
              executionsData.loading ? undefined : executionsData.total
            }
            onOpenNotifications={() => {
              setActiveDrawer("notifications");
            }}
            onOpenExecutions={openExecutions}
            onStateChanged={
              isMember && canUpdateWorkItems ? handleStateChanged : undefined
            }
          />

          <Box
            data-testid="work-item-description"
            sx={{ bgcolor: "action.hover", borderRadius: 2, p: 1.5 }}
          >
            <WorkItemBodyEntry
              workItem={workItem}
              canEdit={canEditWorkItem}
              onChanged={setWorkItem}
              knownWorkItems={childrenData.children}
            />
          </Box>

          <WorkItemChildrenSection
            projectId={projectId}
            workItem={workItem}
            childrenData={childrenData}
          />

          <WorkItemAgentsPanel
            tasks={activeTasks}
            conversations={conversationsData.conversations}
            questions={openQuestions}
            decisionWaits={decisionWaits}
            viewerUsername={session?.user.username ?? null}
            onOpenConversation={conversationParam.open}
            onChanged={handleAgentsChanged}
          />

          <Box>
            <Tabs
              value={tab}
              onChange={(_event, next: WorkItemTab) => {
                selectTab(next);
              }}
              sx={{ borderBottom: 1, borderColor: "divider", mb: 2.5 }}
            >
              <Tab value="comments" label="Comments" />
              <Tab
                value="tasks"
                label={
                  tasksData.loading
                    ? "Tasks"
                    : `Tasks (${String(tasksData.tasks.length)})`
                }
              />
            </Tabs>

            {/* Comments stays mounted so the Properties "Feeding agent"
                count is known on every tab. */}
            <Box hidden={tab !== "comments"}>
              <WorkItemCommentsSection
                workItem={workItem}
                questionsByCommentId={questionsData.byCommentId}
                commentsVersion={commentsVersion}
                onPinnedCountChange={setPinnedCount}
              />
            </Box>
            {tab === "tasks" ? (
              <WorkItemTasksTab
                workItemId={workItem.id}
                tasks={tasksData.tasks}
                loading={tasksData.loading}
                error={tasksData.error}
                conversations={conversationsData.conversations}
                executions={executionsData}
              />
            ) : null}
          </Box>
        </Stack>

        <Box
          sx={{
            minWidth: 0,
            borderLeft: { lg: 1 },
            borderTop: { xs: 1, lg: 0 },
            borderColor: "divider",
            pl: { lg: 3 },
            pt: { xs: 3, lg: 0 },
            alignSelf: "stretch",
          }}
        >
          <WorkItemProperties
            projectId={projectId}
            workItem={workItem}
            ringStatus={ringStatus}
            tasks={tasksData.tasks}
            pinnedCount={pinnedCount}
            executionsData={executionsData}
            onOpenExecutions={openExecutions}
            onWorkItemChanged={setWorkItem}
          />
        </Box>
      </Box>

      {isMember ? (
        <RightDrawer
          open={activeDrawer === "notifications"}
          onClose={closeDrawer}
          title="Notifications"
          headerAction={
            <NotificationsStatusFilter
              statusFilter={statusFilter}
              onChange={setStatusFilter}
            />
          }
        >
          <WorkItemNotificationsDrawerBody
            projectId={projectId}
            statusFilter={statusFilter}
            data={notificationsData}
            onDismissed={handleDismissed}
            onResponded={handleResponded}
          />
        </RightDrawer>
      ) : null}

      <RightDrawer
        open={activeDrawer === "executions"}
        onClose={closeDrawer}
        title="Pipeline executions"
        headerAction={
          isMember ? (
            <NewExecutionButton
              projectId={projectId}
              workItem={workItem}
              data={executionsData}
            />
          ) : undefined
        }
      >
        <WorkItemExecutionsDrawerBody
          workItem={workItem}
          data={executionsData}
          onNavigate={closeDrawer}
        />
      </RightDrawer>

      <ConversationSheet
        conversationId={conversationParam.conversationId}
        agentName={sheetTask ? taskDisplayName(sheetTask) : undefined}
        workItemTitle={workItem.title}
        taskId={
          sheetTask?.kind === "agent" && isTaskActive(sheetTask.status)
            ? sheetTask.id
            : null
        }
        onClose={conversationParam.close}
        onChanged={handleAgentsChanged}
      />
    </>
  );
}
