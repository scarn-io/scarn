import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskArtifacts, taskRuns } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  seedTaskRunParent,
  seedTaskPrerequisites,
} from "tests/lib/db/seed-task-prerequisites";

type SeedState = "available" | "expired" | "deleted";

const seedArtifact = async (
  projectId: UuidV7,
  state: SeedState,
): Promise<UuidV7> => {
  const db = getDb();
  const { workItemId } = await seedTaskPrerequisites(projectId, db);
  const taskRunId = createUuidV7();
  await db.insert(taskRuns).values({
    id: taskRunId,
    projectId,
    workItemId,
    ...(await seedTaskRunParent({ projectId, workItemId }, db)),
    status: "succeeded" as const,
  });
  const artifactId = createUuidV7();
  const objectKey = `artifacts/${projectId}/${taskRunId}/media/demo.mp4`;
  await db.insert(taskArtifacts).values({
    id: artifactId,
    taskRunId,
    projectId,
    relativeStorePath: "media/demo.mp4",
    objectKey: state === "expired" ? null : objectKey,
    storeRef: state === "expired" ? null : `s3://bucket/${objectKey}`,
    sizeBytes: 4096,
    contentType: "video/mp4",
    kind: "video",
    deletedAt: state === "deleted" ? new Date() : null,
  });
  return artifactId;
};

describe("GET /projects/:projectId/artifacts/:artifactId", () => {
  const app = createApp(createAppContext());
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `project-artifact-get-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Project Artifact GET Project",
          description: "Project for single project-artifact GET tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  const requireSetup = () => {
    if (!project || !authHeaders) {
      throw new Error("Expected setup to complete");
    }
    return { project, authHeaders };
  };

  concurrentTest(
    "returns 401 when the request is unauthenticated",
    async () => {
      const { project } = requireSetup();
      const artifactId = await seedArtifact(
        parseUuidV7(project.id),
        "available",
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .artifacts({ artifactId })
        .get();

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest(
    "returns 403 for an authenticated caller with no project membership",
    async () => {
      const { project } = requireSetup();
      const artifactId = await seedArtifact(
        parseUuidV7(project.id),
        "available",
      );
      const nonMember = await createTestUserAndSession({
        email: `project-artifact-get-non-member-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .artifacts({ artifactId })
        .get({ headers: { ...nonMember.authHeaders } });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
    },
  );

  concurrentTest(
    "returns 404 when the artifact belongs to a different project",
    async () => {
      const { project, authHeaders } = requireSetup();
      const otherOwner = await createTestUserAndSession({
        email: `project-artifact-get-other-${crypto.randomUUID()}@example.com`,
      });
      const otherProject = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Other Project",
            description: "Owns the artifact",
            gitUrl: "https://github.com/example/other-project.git",
          },
          { headers: { ...otherOwner.authHeaders } },
        ),
      );
      const artifactId = await seedArtifact(
        parseUuidV7(otherProject.id),
        "available",
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .artifacts({ artifactId })
        .get({ headers: { ...authHeaders } });

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
    },
  );

  concurrentTest("returns 404 for an unknown artifact id", async () => {
    const { project, authHeaders } = requireSetup();

    const { data, error } = await apiClient.api
      .projects({ projectId: project.id })
      .artifacts({ artifactId: createUuidV7() })
      .get({ headers: { ...authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  for (const state of ["available", "expired", "deleted"] as const) {
    concurrentTest(`reports status "${state}"`, async () => {
      const { project, authHeaders } = requireSetup();
      const artifactId = await seedArtifact(parseUuidV7(project.id), state);

      const artifact = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .artifacts({ artifactId })
          .get({ headers: { ...authHeaders } }),
      );

      expect(artifact.id).toBe(artifactId);
      expect(artifact.projectId).toBe(project.id);
      expect(artifact.status).toBe(state);
      expect(artifact.relativeStorePath).toBe("media/demo.mp4");
      expect(artifact.kind).toBe("video");
    });
  }

  concurrentTest(
    "returns null run context for an artifact outside a pipeline run",
    async () => {
      const { project, authHeaders } = requireSetup();
      const artifactId = await seedArtifact(
        parseUuidV7(project.id),
        "available",
      );

      const artifact = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .artifacts({ artifactId })
          .get({ headers: { ...authHeaders } }),
      );

      expect(artifact.pipelineRunId).toBeNull();
      expect(artifact.attemptNumber).toBeNull();
      expect(artifact.nodeKey).toBeNull();
    },
  );
});
