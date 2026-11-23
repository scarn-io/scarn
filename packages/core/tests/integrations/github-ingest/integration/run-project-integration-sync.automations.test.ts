import { afterAll, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { unwrapAsync } from "tests/utils";
import {
  createRunnerHarness,
  projectAutomation,
  uniqueKey,
  workItemAutomation,
  type RunnerHarness,
} from "tests/pipeline-definitions/automation/integration/automation-runner-test-support";
import {
  createRelationshipsTestHarness,
  makeRelationshipsFetchImpl,
  useGithubRelationshipsTestEnv,
  type GitHubIssueFixture,
  type GitHubIssueRefFixture,
} from "./run-project-integration-sync-relationships-test-support";

/**
 * Issues a GitHub sync ingests raise the same work item events as any other
 * write, so the project's enabled automations run on them. Reassigns
 * `globalThis.fetch` and `process.env`, so tests run serially.
 */
describe("POST /projects/:projectId/integrations/:integrationId/sync with project automations", () => {
  useGithubRelationshipsTestEnv();
  const { loadSyncedWorkItem } = createRelationshipsTestHarness();
  const cleanups: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  /** A runner harness project with a GitHub App integration on `repoFullName`. */
  const githubProject = async (label: string, repoFullName: string) => {
    const h = await createRunnerHarness(label);
    const integration = await unwrapAsync(
      h.apiClient.api.projects({ projectId: h.projectId }).integrations.post(
        {
          kind: "github_app",
          installationId: "999",
          externalScope: { repos: [{ id: 1, fullName: repoFullName }] },
        },
        { headers: h.headers },
      ),
    );
    cleanups.push(
      async () =>
        await h.apiClient.api
          .projects({ projectId: h.projectId })
          .integrations({ integrationId: integration.id })
          .delete(undefined, { headers: h.headers }),
    );
    const sync = async (
      issues: GitHubIssueFixture[],
      blockedByByNumber: Record<number, GitHubIssueRefFixture[]> = {},
    ) => {
      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues,
        blockedByByNumber,
      });
      return await unwrapAsync(
        h.apiClient.api
          .projects({ projectId: h.projectId })
          .integrations({ integrationId: integration.id })
          .sync.post(undefined, { headers: h.headers }),
      );
    };
    const item = async (number: number) =>
      parseUuidV7(
        (await loadSyncedWorkItem(h.projectId, repoFullName, number)).id,
      );
    return { h, sync, item };
  };

  const enablePipelineOnReady = async (h: RunnerHarness) => {
    const pipeline = await h.createPipeline(await h.createStep("triage"));
    const key = uniqueKey("default");
    await h.publish(
      projectAutomation(key, [
        {
          key: "work-item-ready",
          event: "workItem.ready",
          next: {
            routes: [{ kind: "pipeline", to: pipeline.key, on: "workItem" }],
          },
        },
      ]),
    );
    await h.enable(key);
    return pipeline;
  };

  test.serial(
    "a synced issue gets one system-triggered run of the ready pipeline",
    async () => {
      const { h, sync, item } = await githubProject(
        "github-sync-ready",
        "acme/automation-sync",
      );
      const pipeline = await enablePipelineOnReady(h);

      const result = await sync([{ number: 1 }]);

      expect(result.totalUpserted).toBe(1);
      expect(await h.runsOn(await item(1))).toMatchObject([
        { pipelineId: pipeline.id, triggeredByUserId: null },
      ]);
    },
  );

  test.serial(
    "a synced issue that arrives blocked gets its pipeline when its blocker closes",
    async () => {
      const { h, sync, item } = await githubProject(
        "github-sync-blocked",
        "acme/automation-blocked",
      );
      const pipeline = await enablePipelineOnReady(h);
      const blockedBy = {
        1: [{ owner: "acme", repo: "automation-blocked", number: 2 }],
      };

      await sync([{ number: 1 }, { number: 2 }], blockedBy);
      const blocked = await item(1);
      expect(await h.runsOn(blocked)).toEqual([]);

      await sync([{ number: 1 }, { number: 2, state: "closed" }], blockedBy);

      expect(await h.runsOn(blocked)).toMatchObject([
        { pipelineId: pipeline.id },
      ]);
    },
  );

  test.serial(
    "adding the wayfinder label to a synced issue attaches Wayfinder",
    async () => {
      const { h, sync, item } = await githubProject(
        "github-sync-wayfinder",
        "acme/automation-wayfinder",
      );
      const plan = await h.createStep("plan");
      const wayfinderKey = uniqueKey("wayfinder");
      const routerKey = uniqueKey("router");
      await h.publish(
        workItemAutomation(wayfinderKey, [
          {
            key: "self-attached",
            event: "self.attached",
            next: { routes: [{ kind: "step", to: plan.key, on: "workItem" }] },
          },
        ]),
      );
      await h.publish(
        projectAutomation(routerKey, [
          {
            key: "work-item-label-added",
            event: "workItem.label.added",
            next: {
              routes: [
                {
                  when: {
                    path: "event.label",
                    op: "equal",
                    value: "wayfinder",
                  },
                  kind: "attach",
                  automation: wayfinderKey,
                },
              ],
              otherwise: { kind: "skip" },
            },
          },
        ]),
      );
      await h.enable(routerKey);

      await sync([{ number: 1, labels: ["bug"] }]);
      const issue = await item(1);
      expect(await h.tasksOn(issue)).toEqual([]);

      await sync([{ number: 1, labels: ["bug", "wayfinder"] }]);

      const attached = await unwrapAsync(
        h.apiClient.api["work-items"]({ workItemId: issue }).automations.get({
          headers: h.headers,
        }),
      );
      expect(attached.map((each) => each.automation.key)).toEqual([
        wayfinderKey,
      ]);
      expect((await h.tasksOn(issue)).map((task) => task.step)).toEqual([
        plan.key,
      ]);
      expect(await h.activityOf(issue)).toEqual([
        `Automation ${routerKey} · workItem.label.added · rule 1: skipped`,
        `Automation ${routerKey} · workItem.label.added · rule 1: attached ${wayfinderKey}`,
        `Automation ${wayfinderKey} · self.attached · rule 1: started ${plan.key}`,
      ]);
    },
  );
});
