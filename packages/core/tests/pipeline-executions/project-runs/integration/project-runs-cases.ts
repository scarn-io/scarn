/** The shared pipeline-run and Task scenarios the Runs list tests read. */
import type { ProjectRunsPageContract } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import {
  seedAutomation,
  seedChat,
  seedOpenQuestion,
  seedPipeline,
  seedRun,
  seedStepDefinition,
  seedTask,
  seedTaskRun,
  seedVisit,
  seedWorkItem,
  type RunsProject,
} from "./project-runs-test-support";

/** The rows of a page by id. */
export const byId = (page: ProjectRunsPageContract) =>
  new Map(page.runs.map((run) => [run.id, run]));

/**
 * One pipeline run per status (queued, running, needs-you on a reply and a
 * decision for the owner, done, ended, failed, cancelled) at minutes 1 to 8,
 * and the running run's step Task, which must not be a row.
 */
export const seedPipelineRunCases = async (project: RunsProject) => {
  const { projectId, owner } = project;
  const pipeline = await seedPipeline(projectId, "Review");
  const item = async (title: string) =>
    (
      await seedWorkItem({
        projectId,
        title,
        createdByUserId: owner.userId,
      })
    ).id;

  const queuedItem = await item("Queued work");
  const queued = await seedRun({
    projectId,
    pipeline,
    workItemId: queuedItem,
    status: "active",
    minute: 1,
  });
  await seedVisit({
    runId: queued,
    nodeId: "build",
    nodeKind: "step",
    status: "active",
  });

  const runningItem = await item("Running work");
  const running = await seedRun({
    projectId,
    pipeline,
    workItemId: runningItem,
    status: "active",
    minute: 2,
  });
  const stepTask = await seedTask({
    projectId,
    workItemId: runningItem,
    status: "running",
    minute: 2,
  });
  const stepTaskId = stepTask;
  await seedTaskRun({
    taskId: stepTask,
    projectId,
    workItemId: runningItem,
    status: "running",
  });
  await seedVisit({
    runId: running,
    nodeId: "lint",
    nodeKind: "step",
    status: "active",
    taskId: stepTask,
  });

  const waitingItem = await item("Waiting work");
  const waiting = await seedRun({
    projectId,
    pipeline,
    workItemId: waitingItem,
    status: "waiting",
    minute: 3,
  });
  const askVisit = await seedVisit({
    runId: waiting,
    nodeId: "ask",
    nodeKind: "wait",
    status: "waiting",
  });
  await seedOpenQuestion({
    projectId,
    workItemId: waitingItem,
    runId: waiting,
    visitId: askVisit,
    body: "Which database should we use?",
  });

  const decision = await seedRun({
    projectId,
    pipeline,
    workItemId: await item("Decision work"),
    status: "waiting",
    minute: 4,
  });
  await seedVisit({
    runId: decision,
    nodeId: "approve",
    nodeKind: "wait",
    status: "waiting",
  });

  const done = await seedRun({
    projectId,
    pipeline,
    workItemId: await item("Done work"),
    status: "succeeded",
    endNodeId: "done",
    minute: 5,
  });

  const ended = await seedRun({
    projectId,
    pipeline,
    workItemId: await item("Ended work"),
    status: "failed",
    endNodeId: "rejected",
    error: { name: "Scarn.Rejected", message: "Rejected" },
    minute: 6,
  });

  const failed = await seedRun({
    projectId,
    pipeline,
    workItemId: await item("Failed work"),
    status: "failed",
    error: { name: "Scarn.StepFailed", message: "Step failed" },
    minute: 7,
  });
  await seedVisit({
    runId: failed,
    nodeId: "build",
    nodeKind: "step",
    status: "failed",
    error: { name: "Build.Broken", message: "tsc exited with 2" },
  });

  const cancelled = await seedRun({
    projectId,
    pipeline,
    workItemId: await item("Cancelled work"),
    status: "cancelled",
    minute: 8,
  });
  return {
    ids: { queued, running, waiting, decision, done, ended, failed, cancelled },
    stepTaskId,
    pipeline,
  };
};

/**
 * Standalone Tasks (prompt, step, waiting on the owner and on the member,
 * failed, lapsed, queued) at minutes 1 to 7, and Tasks without a work item
 * (chats: waiting on the owner, ended, failed, running) at minutes 8 to 11.
 */
export const seedTaskAndChatCases = async (project: RunsProject) => {
  const { projectId, owner, member } = project;
  const mine = await seedWorkItem({
    projectId,
    title: "Owner's item",
    createdByUserId: owner.userId,
  });
  const theirs = await seedWorkItem({
    projectId,
    title: "Member's item",
    createdByUserId: member.userId,
  });
  const stepDefinitionId = await seedStepDefinition(projectId, "Triage");
  const automationId = await seedAutomation(projectId, "Nightly triage");

  const prompt = await seedTask({
    projectId,
    workItemId: mine.id,
    status: "running",
    minute: 1,
    prompt: "\n  Fix the flaky test\nThen open a PR.",
    startedByUserId: owner.userId,
  });
  const step = await seedTask({
    projectId,
    workItemId: mine.id,
    status: "succeeded",
    minute: 2,
    stepDefinitionId,
    automationId,
  });
  const waitingOnOwner = await seedTask({
    projectId,
    workItemId: mine.id,
    status: "waiting_for_person",
    minute: 3,
  });
  const waitingOnMember = await seedTask({
    projectId,
    workItemId: theirs.id,
    status: "waiting_for_person",
    minute: 4,
  });
  const failed = await seedTask({
    projectId,
    workItemId: mine.id,
    status: "failed",
    minute: 5,
    errorJson: { name: "Build.Broken", message: "tsc exited with 2" },
  });
  await seedTaskRun({
    taskId: failed,
    projectId,
    workItemId: mine.id,
    status: "failed",
    errorJson: { name: "Build.Broken", message: "tsc exited with 2" },
  });
  const lapsed = await seedTask({
    projectId,
    workItemId: mine.id,
    status: "running",
    minute: 6,
  });
  await seedTaskRun({
    taskId: lapsed,
    projectId,
    workItemId: mine.id,
    status: "running",
    leaseExpiresAt: new Date(Date.UTC(2020, 0, 1)),
  });
  const queued = await seedTask({
    projectId,
    workItemId: mine.id,
    status: "waiting_for_work",
    minute: 7,
  });

  const chat = async (
    input: Omit<Parameters<typeof seedChat>[0], "projectId">,
  ) => (await seedChat({ projectId, ...input })).taskId;
  const chatWaiting = await chat({
    taskStatus: "waiting_for_person",
    minute: 8,
    createdByUserId: owner.userId,
    question: "How do builds work?",
    answer: "They run   in CI.\nAnything else?",
  });
  const chatEnded = await chat({
    taskStatus: "waiting_for_person",
    minute: 9,
    createdByUserId: owner.userId,
    closed: true,
  });
  const chatFailed = await chat({
    taskStatus: "failed",
    minute: 10,
    createdByUserId: member.userId,
  });
  const chatRunning = await chat({
    taskStatus: "running",
    minute: 11,
    createdByUserId: member.userId,
  });
  return {
    ids: {
      prompt,
      step,
      waitingOnOwner,
      waitingOnMember,
      failed,
      lapsed,
      queued,
      chatWaiting,
      chatEnded,
      chatFailed,
      chatRunning,
    },
    automationId,
    stepDefinitionId,
  };
};
