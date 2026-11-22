/**
 * Where a Task opens in the Runs tab: its pipeline run on the Task's step
 * when a step visit created it, otherwise the Task's own run page.
 */
export function taskRunPath(
  projectPath: (...segments: string[]) => string,
  task: {
    id: string;
    pipelineRunId?: string | null;
    nodeId?: string | null;
  },
): string {
  if (!task.pipelineRunId) return projectPath("runs", "tasks", task.id);
  const runPath = projectPath("runs", task.pipelineRunId);
  return task.nodeId
    ? `${runPath}?${new URLSearchParams({ step: task.nodeId }).toString()}`
    : runPath;
}
