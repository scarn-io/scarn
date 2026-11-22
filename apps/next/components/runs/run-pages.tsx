"use client";

/**
 * A Task's page in the Runs tab, inside the run frame. A Task without a work
 * item that answers a conversation (a chat) opens on that conversation;
 * every other Task opens on its Task view.
 */

import { useEffect, useState } from "react";
import { RepoConversationView } from "@/components/repo-conversations/repo-conversation-view";
import { fetchTask } from "@/components/tasks/task-api";
import { TaskView } from "@/components/tasks/task-view";
import { RunFrame } from "./run-frame";

type TaskPane =
  | { taskId: string; kind: "conversation"; conversationId: string }
  | { taskId: string; kind: "task" };

function useTaskPane(taskId: string): TaskPane | null {
  const [pane, setPane] = useState<TaskPane | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTask(taskId).then(
      (task) => {
        if (cancelled) return;
        setPane(
          task.workItem === null && task.repoConversation
            ? {
                taskId,
                kind: "conversation",
                conversationId: task.repoConversation.id,
              }
            : { taskId, kind: "task" },
        );
      },
      () => {
        if (!cancelled) setPane({ taskId, kind: "task" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return pane?.taskId === taskId ? pane : null;
}

export function RunTaskPage({
  projectId,
  taskId,
  pollIntervalMs,
}: {
  projectId: string;
  taskId: string;
  pollIntervalMs?: number;
}) {
  const pane = useTaskPane(taskId);

  return (
    <RunFrame
      projectId={projectId}
      lookup={{ type: "task", id: taskId }}
      layout={pane?.kind === "conversation" ? "fill" : "scroll"}
      {...(pollIntervalMs === undefined ? {} : { pollIntervalMs })}
    >
      {({ framed }) => {
        if (pane === null) return null;
        if (pane.kind === "conversation") {
          return (
            <RepoConversationView
              conversationId={pane.conversationId}
              projectId={projectId}
              framed={framed}
            />
          );
        }
        return (
          <TaskView taskId={taskId} projectId={projectId} framed={framed} />
        );
      }}
    </RunFrame>
  );
}
