import type { WorkNotifier } from "@/tasks/task-run/application/work-notifier";

/** A `WorkNotifier` that records every project it is told about, in order. */
export const recordingWorkNotifier = () => {
  const enqueued: string[] = [];
  const workNotifier: WorkNotifier = {
    enqueued: (projectId) => {
      enqueued.push(projectId);
    },
  };
  return { workNotifier, enqueued };
};
