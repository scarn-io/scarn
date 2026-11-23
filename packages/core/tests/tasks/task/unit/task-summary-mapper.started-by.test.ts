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
const scheduleId = createUuidV7();

const record = (
  starter: Partial<
    Pick<
      TaskSummaryRecord,
      | "startedByUserId"
      | "startedByAutomation"
      | "startedBySchedule"
      | "scheduledFor"
    >
  >,
): TaskSummaryRecord => ({
  id: createUuidV7(),
  projectId: createUuidV7(),
  kind: "agent",
  name: null,
  status: "queued",
  prompt: "Do the thing.",
  startedByUserId: null,
  startedByAutomation: null,
  startedBySchedule: null,
  scheduledFor: null,
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

const automation = { id: automationId, key: "triage-bugs", title: null };

describe("task summary startedBy", () => {
  test("names the user, the automation, or the system", async () => {
    const summaries = await taskSummariesToContracts(
      [
        record({ startedByUserId: userId }),
        record({ startedByAutomation: automation }),
        record({}),
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

  test("names the schedule rule, with the person for Run now", async () => {
    const schedule = { id: scheduleId, key: "nightly", removed: true };
    const scheduledFor = new Date("2026-11-01T02:00:00.000Z");
    const summaries = await taskSummariesToContracts(
      [
        record({
          startedByAutomation: automation,
          startedBySchedule: schedule,
          scheduledFor,
        }),
        record({
          startedByUserId: userId,
          startedByAutomation: automation,
          startedBySchedule: schedule,
          scheduledFor,
        }),
      ],
      viewerUserId,
      usernameReader,
    );

    const base = {
      kind: "schedule" as const,
      automationId,
      key: "triage-bugs",
      title: null,
      schedule,
    };
    expect(summaries.map((summary) => summary.startedBy)).toEqual([
      { ...base, user: null },
      { ...base, user: { userId, username: "alice" } },
    ]);
    expect(summaries[0]?.scheduledFor).toBe("2026-11-01T02:00:00.000Z");
  });
});
