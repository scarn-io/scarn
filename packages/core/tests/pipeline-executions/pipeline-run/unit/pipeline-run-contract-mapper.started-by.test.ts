import { describe, expect, test } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { UserDisplay } from "@/organizations/organization/application/username-reader";
import { AutomationEntity } from "@/pipeline-definitions/automation/domain/automation-entity";
import {
  projectPipelineRunsToContracts,
  type PipelineRunReadDeps,
} from "@/pipeline-executions/pipeline-run/application/pipeline-run-contract-mapper";
import { PipelineRunEntity } from "@/pipeline-executions/pipeline-run/domain/pipeline-run-entity";
import { fixedTimeProvider } from "tests/utils";

const projectId = createUuidV7();
const userId = createUuidV7();
const automation = AutomationEntity.create({
  projectId,
  key: "triage-bugs",
  title: "Triage bugs",
  scope: "project",
});

const runStartedBy = (starter: {
  triggeredByUserId?: UuidV7;
  startedByAutomationId?: UuidV7;
}) =>
  PipelineRunEntity.create({
    projectId,
    workItemId: createUuidV7(),
    pipelineGraphId: createUuidV7(),
    pipelineGraphVersionId: createUuidV7(),
    status: "active",
    ...starter,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  });

const readDeps = () => {
  const usernameCalls: UuidV7[][] = [];
  const automationCalls: UuidV7[][] = [];
  const deps = {
    pipelineRunRepo: { loadHistories: () => Promise.resolve(new Map()) },
    pipelineGraphVersionRepo: { loadMany: () => Promise.resolve([]) },
    nodeVisitQuestionRepo: { loadByRunIds: () => Promise.resolve(new Map()) },
    taskRunRepo: { loadManyByIds: () => Promise.resolve([]) },
    workItemTitleReader: {
      loadTitlesByWorkItemIds: () => Promise.resolve(new Map()),
    },
    usernameReader: {
      loadUsernamesByUserId: (ids: readonly UuidV7[]) => {
        usernameCalls.push([...ids]);
        return Promise.resolve(
          new Map<UuidV7, UserDisplay>([
            [userId, { username: "alice", image: null }],
          ]),
        );
      },
    },
    automationRepo: {
      loadMany: (ids: readonly UuidV7[]) => {
        automationCalls.push([...ids]);
        return Promise.resolve(ids.includes(automation.id) ? [automation] : []);
      },
    },
    timeProvider: fixedTimeProvider(new Date("2026-11-02T00:00:00.000Z")),
  } as unknown as PipelineRunReadDeps;
  return { deps, usernameCalls, automationCalls };
};

describe("pipeline run contract startedBy", () => {
  test("names the user, the automation, or the system, in one read each", async () => {
    const { deps, usernameCalls, automationCalls } = readDeps();
    const deletedAutomationId = createUuidV7();

    const contracts = await projectPipelineRunsToContracts(
      [
        runStartedBy({ triggeredByUserId: userId }),
        runStartedBy({ startedByAutomationId: automation.id }),
        runStartedBy({ startedByAutomationId: deletedAutomationId }),
        runStartedBy({}),
      ],
      deps,
    );

    expect(contracts.map((contract) => contract.startedBy)).toEqual([
      { kind: "user", userId, username: "alice" },
      {
        kind: "automation",
        automationId: automation.id,
        key: "triage-bugs",
        title: "Triage bugs",
      },
      { kind: "system" },
      { kind: "system" },
    ]);
    expect(usernameCalls).toEqual([[userId]]);
    expect(automationCalls).toEqual([[automation.id, deletedAutomationId]]);
  });

  test("a user that no longer resolves keeps its id with a null username", async () => {
    const { deps } = readDeps();
    const unknownUserId = createUuidV7();

    const [contract] = await projectPipelineRunsToContracts(
      [runStartedBy({ triggeredByUserId: unknownUserId })],
      deps,
    );

    expect(contract?.startedBy).toEqual({
      kind: "user",
      userId: unknownUserId,
      username: null,
    });
  });
});
