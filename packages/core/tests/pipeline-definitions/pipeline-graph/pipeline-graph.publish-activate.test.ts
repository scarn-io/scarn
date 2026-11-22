/**
 * DB-backed coverage for publishing and activating pipeline versions.
 *
 * Placement: in neither `unit/` (it hits Postgres) nor `integration/`
 * (those must go through the API client, and publish/activate have no HTTP
 * route yet). Version reads and run starts go through the API.
 */
import { beforeAll, describe, expect } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@/common/contracts/json";
import { createAppContext, type AppContext } from "@/lib/di";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import { publishPipelineVersion } from "@/pipeline-definitions/pipeline-graph/application/publish-pipeline-graph-version";
import { activatePipelineGraphVersion } from "@/pipeline-definitions/pipeline-graph/application/activate-pipeline-graph-version";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { createTestWorkItem } from "tests/tasks/task-run/integration/task-run-test-support";
import {
  buildAgentStepDefinitionPayload,
  chainedPipelineDocument,
  createPipelineFromDocument,
} from "../pipeline-test-support";

describe("publishing and activating pipeline versions", () => {
  let appContext: AppContext;
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let userAuthz: UserAuthorizationService;
  let headers: { authorization: string };
  let projectId: UuidV7;
  let stepKey: string;

  beforeAll(async () => {
    appContext = createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-07-01T09:00:00.000Z")),
    });
    apiClient = createScarnTreaty(createApp(appContext));
    const owner = await createTestUserAndSession({
      email: `pipeline-publish-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    userAuthz = appContext.createUserAuthorizationService(
      parseUuidV7(owner.userId),
    );
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Pipeline publish project",
          description: "Project for pipeline publish tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...headers } },
      ),
    );
    projectId = parseUuidV7(project.id);
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildAgentStepDefinitionPayload(projectId),
        { headers: { ...headers } },
      ),
    );
    stepKey = stepDefinition.key;
  });

  const documentFor = (key: string, ...nodeIds: string[]) =>
    chainedPipelineDocument(
      key,
      nodeIds.map((nodeId) => ({ nodeId, stepKey })),
    );

  const createPipeline = async (document: PipelineDocument) => {
    const definition = await createPipelineFromDocument(
      apiClient,
      headers,
      projectId,
      document,
    );
    return parseUuidV7(definition.id);
  };

  const publish = async (
    pipelineDefinitionId: UuidV7,
    document: PipelineDocument | AnyJsonObject,
  ) =>
    await publishPipelineVersion(
      { pipelineDefinitionId, document: document },
      { ...appContext, userAuthz },
    );

  const activate = async (pipelineDefinitionId: UuidV7, version: number) =>
    await activatePipelineGraphVersion(
      { pipelineDefinitionId, version },
      { ...appContext, userAuthz },
    );

  const startRunOn = async (pipelineDefinitionId: UuidV7) => {
    const workItem = await createTestWorkItem(
      apiClient,
      headers,
      projectId,
      "publish",
    );
    return await unwrapAsync(
      apiClient.api["pipeline-executions"].post(
        {
          projectId,
          workItemId: parseUuidV7(workItem.id),
          pipelineDefinitionId,
        },
        { headers: { ...headers } },
      ),
    );
  };

  serialTest(
    "creating with a document publishes version 1 and pins its steps",
    async () => {
      const key = `publish-${crypto.randomUUID()}`;
      const pipelineDefinitionId = await createPipeline(
        documentFor(key, "first"),
      );

      const versions = await unwrapAsync(
        apiClient.api["pipeline-definitions"]({
          pipelineDefinitionId,
        }).versions.get({ headers: { ...headers } }),
      );
      expect(versions.map((version) => version.version)).toEqual([1]);

      const version = await unwrapAsync(
        apiClient.api["pipeline-definitions"]({ pipelineDefinitionId })
          .versions({ version: 1 })
          .get({ headers: { ...headers } }),
      );
      expect(version).toMatchObject({
        version: 1,
        schemaVersion: 1,
        definition: { key },
        steps: [{ stepKey }],
      });
    },
  );

  serialTest(
    "publishing an unchanged document writes nothing and returns the latest version",
    async () => {
      const document = documentFor(`publish-${crypto.randomUUID()}`, "first");
      const pipelineDefinitionId = await createPipeline(document);

      const outcome = await publish(pipelineDefinitionId, document);
      if (!outcome.ok) {
        throw outcome.error;
      }
      expect(outcome.value.published).toBe(false);
      expect(outcome.value.version.version).toBe(1);
    },
  );

  serialTest(
    "publishing a changed document adds the next version and makes it active",
    async () => {
      const key = `publish-${crypto.randomUUID()}`;
      const pipelineDefinitionId = await createPipeline(
        documentFor(key, "first"),
      );

      const outcome = await publish(
        pipelineDefinitionId,
        documentFor(key, "first", "second"),
      );
      if (!outcome.ok) {
        throw outcome.error;
      }
      expect(outcome.value.published).toBe(true);
      expect(outcome.value.version.version).toBe(2);
      expect(outcome.value.pipelineDefinition.currentVersion?.version).toBe(2);

      const run = await startRunOn(pipelineDefinitionId);
      expect(run.pipelineDefinitionVersionId).toBe(outcome.value.version.id);
    },
  );

  serialTest("an invalid document is rejected with its errors", async () => {
    const key = `publish-${crypto.randomUUID()}`;
    const pipelineDefinitionId = await createPipeline(
      documentFor(key, "first"),
    );

    const outcome = await publish(pipelineDefinitionId, {
      schemaVersion: 1,
      key,
      start: { to: "first" },
      nodes: {
        first: {
          kind: "step",
          step: "no-such-step",
          next: {
            routes: [{ to: "done" }],
          },
        },
        done: { kind: "succeed" },
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.error.code).toBe("PIPELINE_DOCUMENT_INVALID");
    expect(outcome.error.message).toContain("no-such-step");
  });

  serialTest("a document keyed for another pipeline is rejected", async () => {
    const pipelineDefinitionId = await createPipeline(
      documentFor(`publish-${crypto.randomUUID()}`, "first"),
    );

    const outcome = await publish(
      pipelineDefinitionId,
      documentFor(`other-${crypto.randomUUID()}`, "first"),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("PIPELINE_DOCUMENT_KEY_MISMATCH");
    }
  });

  serialTest(
    "activating an earlier version rolls new runs back to it",
    async () => {
      const key = `publish-${crypto.randomUUID()}`;
      const pipelineDefinitionId = await createPipeline(
        documentFor(key, "first"),
      );
      const published = await publish(
        pipelineDefinitionId,
        documentFor(key, "first", "second"),
      );
      if (!published.ok) {
        throw published.error;
      }

      const activated = await activate(pipelineDefinitionId, 1);
      if (!activated.ok) {
        throw activated.error;
      }
      expect(activated.value.currentVersion?.version).toBe(1);

      const run = await startRunOn(pipelineDefinitionId);
      const versionOne = await unwrapAsync(
        apiClient.api["pipeline-definitions"]({ pipelineDefinitionId })
          .versions({ version: 1 })
          .get({ headers: { ...headers } }),
      );
      expect(run.pipelineDefinitionVersionId).toBe(versionOne.id);

      const republished = await publish(
        pipelineDefinitionId,
        documentFor(key, "first", "second"),
      );
      if (!republished.ok) {
        throw republished.error;
      }
      expect(republished.value.published).toBe(false);
      expect(republished.value.version.version).toBe(2);
      expect(republished.value.pipelineDefinition.currentVersion?.version).toBe(
        1,
      );
    },
  );

  serialTest("activating a version that doesn't exist fails", async () => {
    const pipelineDefinitionId = await createPipeline(
      documentFor(`publish-${crypto.randomUUID()}`, "first"),
    );

    const outcome = await activate(pipelineDefinitionId, 9);
    expect(outcome.ok).toBe(false);
  });
});
