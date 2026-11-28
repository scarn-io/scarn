import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import type { ArtifactBundleLimits } from "@/tasks/task-artifact/domain/artifact-bundle";
import type { ArtifactSharingConfig } from "@/tasks/artifact-share/domain/artifact-sharing-config";
import type { ContentRateLimiter } from "@/tasks/artifact-share/application/content-rate-limiter";
import {
  fixedTimeProvider,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

/**
 * An {@link InMemoryObjectStore} that also mints deterministic presigned URLs,
 * since the upload-URL route refuses a store that cannot presign.
 */
class PresigningInMemoryObjectStore extends InMemoryObjectStore {
  override getPresignedGetUrl(key?: string): Promise<string | null> {
    return Promise.resolve(`https://store.test/get/${key ?? ""}`);
  }

  override getPresignedPutUrl(key?: string): Promise<string | null> {
    return Promise.resolve(`https://store.test/put/${key ?? ""}`);
  }
}

/**
 * A result schema with a declared bundle field `report` that auto-shares
 * (stored keyword shape, plan decision 19), a private bundle field `notes`
 * and a plain file field `screenshot`.
 */
export const BUNDLE_RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    report: {
      type: "string",
      "x-scarn-artifact": {
        accept: [],
        bundle: { entry: "report.html" },
        share: true,
      },
    },
    notes: {
      type: "string",
      "x-scarn-artifact": { accept: [], bundle: { entry: "index.html" } },
    },
    screenshot: {
      type: "string",
      "x-scarn-artifact": { accept: [".png"] },
    },
  },
};

/**
 * Shared setup for the artifact-bundle endpoint tests: a live app with an
 * in-memory object store, a project owned by a fresh user, and a step
 * definition (whose result schema declares a bundle field) whose task runs
 * can be started and claimed.
 */
export const createArtifactBundleHarness = (
  label: string,
  options: {
    artifactBundleLimits?: ArtifactBundleLimits;
    artifactSharingConfig?: ArtifactSharingConfig;
    contentRateLimiter?: ContentRateLimiter;
  } = {},
) => {
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-05-01T12:00:00.000Z")),
    objectStore: new PresigningInMemoryObjectStore(),
    objectStorageBucket: "artifacts-bucket",
    ...(options.artifactBundleLimits
      ? { artifactBundleLimits: options.artifactBundleLimits }
      : {}),
    ...(options.artifactSharingConfig
      ? { artifactSharingConfig: options.artifactSharingConfig }
      : {}),
    ...(options.contentRateLimiter
      ? { contentRateLimiter: options.contentRateLimiter }
      : {}),
  });
  const app = createApp(appContext);
  const apiClient = createScarnTreaty(app);
  let state:
    | {
        projectId: UuidV7;
        stepDefinitionId: UuidV7;
        authHeaders: { authorization: string };
      }
    | undefined;

  const setup = async (): Promise<void> => {
    const owner = await createTestUserAndSession({
      email: `${label}-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: `Artifact bundle ${label} project`,
          description: "Project for artifact bundle tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const projectId = parseUuidV7(project.id);
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `artifact_bundle_step_${crypto.randomUUID()}`,
          name: "Artifact bundle step",
          description: "Reusable step for artifact bundle tests",
          prompt: "Return a result payload.",
          version: 1,
          kind: "user_defined" as const,
          inputSchemaJson: { type: "object" },
          resultSchemaJson: BUNDLE_RESULT_SCHEMA,
          status: "active" as const,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    state = {
      projectId,
      stepDefinitionId: stepDefinition.id,
      authHeaders: owner.authHeaders,
    };
  };

  const ready = () => {
    if (!state) {
      throw new Error("Expected artifact bundle harness setup to complete");
    }
    return state;
  };

  const claimTaskRun = async (
    workerId: string,
  ): Promise<{ taskRunId: UuidV7; claimToken: string }> => {
    const { projectId, stepDefinitionId, authHeaders } = ready();
    const workItemId = await seedWorkItem(projectId);
    const { run } = await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId,
          stepDefinitionVersion: 1,
          inputJson: { ticketId: `ticket-${workerId}` },
          executionTimeoutSeconds: 300,
        },
        { headers: { ...authHeaders } },
      ),
    );
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId,
          workItemId,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers: { ...authHeaders } },
      ),
    );
    const claim = claims.find((c) => c.task.id === run.id);
    if (!claim) {
      throw new Error("Expected claim token to be returned");
    }
    return { taskRunId: run.id, claimToken: claim.claimToken };
  };

  /** Mint an upload URL for a bundle member and record it, as a worker would. */
  const uploadMember = async (input: {
    taskRunId: UuidV7;
    claimToken: string;
    bundleId: UuidV7;
    relativeStorePath: string;
    sizeBytes?: number;
  }) => {
    const { authHeaders } = ready();
    const sizeBytes = input.sizeBytes ?? 100;
    const taskRun = apiClient.api["task-runs"]({ taskRunId: input.taskRunId });
    const upload = await unwrapAsync(
      taskRun["artifact-upload-url"].post(
        {
          claimToken: input.claimToken,
          relativeStorePath: input.relativeStorePath,
          contentType: "text/html",
          sizeBytes,
          bundleId: input.bundleId,
        },
        { headers: { ...authHeaders } },
      ),
    );
    return unwrapAsync(
      taskRun.artifacts.post(
        {
          claimToken: input.claimToken,
          objectKey: upload.objectKey,
          relativeStorePath: input.relativeStorePath,
          sizeBytes,
          contentType: "text/html",
          bundleId: input.bundleId,
        },
        { headers: { ...authHeaders } },
      ),
    );
  };

  const taskRunApi = (taskRunId: UuidV7) =>
    apiClient.api["task-runs"]({ taskRunId });

  const createBundle = async (
    taskRunId: UuidV7,
    claimToken: string,
    overrides: {
      name?: string;
      rootPath?: string;
      entryPath?: string;
      fieldPath?: string;
    } = {},
  ) =>
    unwrapAsync(
      taskRunApi(taskRunId)["artifact-bundles"].post(
        {
          claimToken,
          name: overrides.name ?? "report",
          rootPath: overrides.rootPath ?? "out/report",
          ...(overrides.entryPath ? { entryPath: overrides.entryPath } : {}),
          ...(overrides.fieldPath ? { fieldPath: overrides.fieldPath } : {}),
        },
        { headers: { ...ready().authHeaders } },
      ),
    );

  /** Finalize; manifest sizes default to the default member size (100). */
  const finalize = (
    taskRunId: UuidV7,
    bundleId: UuidV7,
    claimToken: string,
    manifest: { path: string; sizeBytes?: number }[],
  ) =>
    taskRunApi(taskRunId)
      ["artifact-bundles"]({ bundleId })
      .finalize.post(
        {
          claimToken,
          manifest: manifest.map(({ path, sizeBytes }) => ({
            path,
            sizeBytes: sizeBytes ?? 100,
          })),
        },
        { headers: { ...ready().authHeaders } },
      );

  /** Record a member directly (no upload URL), so large sizes skip the usage cap pre-flight. */
  const recordMember = (input: {
    taskRunId: UuidV7;
    claimToken: string;
    bundleId: UuidV7;
    relativeStorePath: string;
    sizeBytes: number;
  }) =>
    taskRunApi(input.taskRunId).artifacts.post(
      {
        claimToken: input.claimToken,
        objectKey: `artifacts/${ready().projectId}/${input.taskRunId}/${input.relativeStorePath}`,
        relativeStorePath: input.relativeStorePath,
        sizeBytes: input.sizeBytes,
        bundleId: input.bundleId,
      },
      { headers: { ...ready().authHeaders } },
    );

  /** Create a bundle with a single entry page and finalize it `ready`. */
  const createReadyBundle = async (
    workerId: string,
    name = "report",
  ): Promise<{ taskRunId: UuidV7; bundleId: UuidV7 }> => {
    const { taskRunId, claimToken } = await claimTaskRun(workerId);
    const bundle = await createBundle(taskRunId, claimToken, {
      name,
      rootPath: `out/${name}`,
    });
    await uploadMember({
      taskRunId,
      claimToken,
      bundleId: bundle.id,
      relativeStorePath: `out/${name}/index.html`,
    });
    await unwrapAsync(
      finalize(taskRunId, bundle.id, claimToken, [{ path: "index.html" }]),
    );
    return { taskRunId, bundleId: bundle.id };
  };

  return {
    appContext,
    app,
    apiClient,
    setup,
    createReadyBundle,
    claimTaskRun,
    uploadMember,
    taskRunApi,
    createBundle,
    finalize,
    recordMember,
    get projectId() {
      return ready().projectId;
    },
    get authHeaders() {
      return ready().authHeaders;
    },
  };
};
