import { describe, expect, test } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type {
  UserDisplay,
  UsernameReader,
} from "@/organizations/organization/application/username-reader";
import { taskSummariesToContracts } from "@/tasks/task/application/task-summary-mapper";
import type { TaskSummaryRecord } from "@/tasks/task/application/task-summary-reader";

const viewerUserId = createUuidV7();
const userId = createUuidV7();
const automationId = createUuidV7();

const record = (
  starter: Pick<TaskSummaryRecord, "startedByUserId" | "startedByAutomation">,
): TaskSummaryRecord => ({
  id: createUuidV7(),
  projectId: createUuidV7(),
  kind: "agent",
  name: null,
  status: "queued",
  prompt: "Do the thing.",
  ...starter,
  conversationId: null,
  waitingOnUserIds: [],
  workItem: null,
  repoConversation: null,
  stepDefinition: null,
  pipelineRunId: null,
  nodeId: null,
  pipelineRun: null,
  runNumber: null,
  durationMs: null,
  errorMessage: null,
  lastAgentMessage: null,
  lastLogText: null,
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
});

const usernameReader: UsernameReader = {
  loadUsernamesByUserId: (ids: readonly UuidV7[]) =>
    Promise.resolve(
      new Map<UuidV7, UserDisplay>(
        ids.includes(userId)
          ? [[userId, { username: "alice", image: null }]]
          : [],
      ),
    ),
};

describe("task summary startedBy", () => {
  test("names the user, the automation, or the system", async () => {
    const summaries = await taskSummariesToContracts(
      [
        record({ startedByUserId: userId, startedByAutomation: null }),
        record({
          startedByUserId: null,
          startedByAutomation: {
            id: automationId,
            key: "triage-bugs",
            title: null,
          },
        }),
        record({ startedByUserId: null, startedByAutomation: null }),
      ],
      viewerUserId,
      usernameReader,
    );

    expect(summaries.map((summary) => summary.startedBy)).toEqual([
      { kind: "user", userId, username: "alice" },
      { kind: "automation", automationId, key: "triage-bugs", title: null },
      { kind: "system" },
    ]);
  });
});
