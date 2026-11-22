/**
 * Shared setup for the comment-draft artifact marker tests: a project, a
 * GitHub work item, and seeding of `task_artifacts` rows for the task that
 * emits the draft.
 */
import { eq } from "drizzle-orm";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { taskArtifacts } from "@/lib/db/schema";
import type { createScarnTreaty } from "tests/treaty";
import { unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

export const REPO_FULL_NAME = "acme-org/artifacts";
export const ISSUE_NUMBER = 7;

export const setupGithubWorkItem = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  label: string,
) => {
  const owner = await createTestUserAndSession({
    email: `${label}-${crypto.randomUUID()}@example.com`,
  });
  const project = await unwrapAsync(
    apiClient.api.projects.post(
      {
        name: `${label} project`,
        description: "Project for comment artifact marker tests",
        gitUrl: "https://github.com/example/test-project.git",
      },
      { headers: { ...owner.authHeaders } },
    ),
  );
  await unwrapAsync(
    apiClient.api.projects({ projectId: project.id }).integrations.post(
      {
        kind: "github_app",
        installationId: "999",
        externalScope: { repos: [{ id: 1, fullName: REPO_FULL_NAME }] },
      },
      { headers: { ...owner.authHeaders } },
    ),
  );
  const workItem = await unwrapAsync(
    apiClient.api["work-items"].post(
      {
        projectId: project.id,
        platform: "github",
        platformId: null,
        platformKey: `${REPO_FULL_NAME}#${String(ISSUE_NUMBER)}`,
        url: null,
        title: "Issue with artifacts",
        description: "Repro steps",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: { repository: REPO_FULL_NAME, number: ISSUE_NUMBER },
      },
      { headers: { ...owner.authHeaders } },
    ),
  );
  return {
    authHeaders: owner.authHeaders,
    projectId: parseUuidV7(project.id),
    workItemId: parseUuidV7(workItem.id),
  };
};

export const seedTaskArtifact = async (input: {
  projectId: UuidV7;
  taskId: UuidV7;
  relativeStorePath: string;
  contentType?: string;
  kind?: string;
}): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(taskArtifacts)
    .values({
      id,
      taskRunId: input.taskId,
      projectId: input.projectId,
      relativeStorePath: input.relativeStorePath,
      objectKey: `artifacts/${input.projectId}/${input.taskId}/${input.relativeStorePath}`,
      storeRef: `s3://bucket/${input.relativeStorePath}`,
      sizeBytes: 2048,
      contentType: input.contentType ?? "image/png",
      kind: input.kind ?? "image",
      deletedAt: null,
    });
  return id;
};

export const deleteTaskArtifact = async (artifactId: UuidV7): Promise<void> => {
  await getDb()
    .update(taskArtifacts)
    .set({ deletedAt: new Date() })
    .where(eq(taskArtifacts.id, artifactId));
};
