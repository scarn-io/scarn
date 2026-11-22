import { eq } from "drizzle-orm";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import {
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "./auth-test-utils";
import {
  createPipelineFromDocument,
  singleStepPipelineDocument,
} from "tests/pipeline-definitions/pipeline-test-support";

/**
 * Issue #149: a `visibility: "public"` project can be read by any actor —
 * anonymous or a logged-in non-member — without a membership row, while
 * writes and private-project reads are denied exactly as before.
 *
 * There is no HTTP route that sets a project's visibility (see issue #151 —
 * the demo-project seed script is the only intended way this data comes into
 * existence), so these tests flip it directly via the DB, the same
 * infra-level path the seed script will use. This does not violate the
 * integration-tests-use-the-public-API-client ESLint rule, which only
 * restricts importing `application/*`.
 */
describe("project visibility", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-05-01T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  const createProject = async (label: string, name: string) => {
    const owner = await createTestUserAndSession({
      email: `${label}-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name,
          description: `Project for the "${label}" visibility test`,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    return { owner, project };
  };

  const markPublic = async (projectId: string): Promise<void> => {
    await getDb()
      .update(projects)
      .set({ visibility: "public" })
      .where(eq(projects.id, projectId));
  };

  const createPublicProject = async (label: string, name: string) => {
    const created = await createProject(label, name);
    await markPublic(created.project.id);
    return created;
  };

  const seedPipelineDefinition = async (
    owner: { authHeaders: { authorization: string } },
    projectId: UuidV7,
    name: string,
  ) => {
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `step_${uuidv7()}`,
          name: "Visibility test step",
          description: "Reusable step for the visibility suite",
          prompt: "Return a completed scoring result.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    return await createPipelineFromDocument(
      apiClient,
      owner.authHeaders,
      projectId,
      singleStepPipelineDocument(`pipeline_${uuidv7()}`, stepDefinition.key),
      name,
    );
  };

  const seedWorkItem = async (
    owner: { authHeaders: { authorization: string } },
    projectId: UuidV7,
    title: string,
  ) =>
    await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId,
          platform: "github",
          platformId: `visibility-${uuidv7()}`,
          platformKey: `visibility-${uuidv7()}`,
          url: null,
          title,
          description: "Seeded for the project visibility suite",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: {},
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

  concurrentTest(
    "defaults every newly created project to private visibility",
    async () => {
      const { project } = await createProject(
        "default-visibility",
        "Default Visibility Project",
      );

      expect(project.visibility).toBe("private");
    },
  );

  concurrentTest(
    "an anonymous caller can read a public project's metadata",
    async () => {
      const { project } = await createPublicProject(
        "anon-project-read",
        "Public Project Metadata",
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .get();

      expect(error).toBeNull();
      expect(data?.id).toBe(project.id);
      expect(data?.visibility).toBe("public");
    },
  );

  concurrentTest(
    "a logged-in non-member can read a public project's metadata",
    async () => {
      const { project } = await createPublicProject(
        "member-project-read",
        "Public Project For Outsiders",
      );
      const outsider = await createTestUserAndSession({
        email: `outsider-project-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .get({ headers: { ...outsider.authHeaders } });

      expect(error).toBeNull();
      expect(data?.id).toBe(project.id);
    },
  );

  concurrentTest(
    "an anonymous caller can read a public project's work items",
    async () => {
      const { owner, project } = await createPublicProject(
        "anon-work-items",
        "Public Project Work Items",
      );
      await seedWorkItem(
        owner,
        parseUuidV7(project.id),
        "Publicly readable work item",
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        ["work-items"].get();

      expect(error).toBeNull();
      expect(data?.items).toHaveLength(1);
      expect(data?.items[0]?.title).toBe("Publicly readable work item");
    },
  );

  concurrentTest(
    "an anonymous caller can read a public project's single work item and its comments",
    async () => {
      const { owner, project } = await createPublicProject(
        "anon-work-item-comments",
        "Public Project Work Item Comments",
      );
      const workItem = await seedWorkItem(
        owner,
        parseUuidV7(project.id),
        "Work item with a comment",
      );
      await unwrapAsync(
        apiClient.api["work-item-comments"].post(
          {
            workItemId: parseWorkItemId(workItem.id),
            body: "A publicly readable comment",
          },
          { headers: { ...owner.authHeaders } },
        ),
      );

      const workItemResult = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).get();
      expect(workItemResult.error).toBeNull();
      expect(workItemResult.data?.id).toBe(workItem.id);

      const commentsResult = await apiClient.api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(workItem.id) },
      });
      expect(commentsResult.error).toBeNull();
      expect(commentsResult.data).toHaveLength(1);
      expect(commentsResult.data?.[0]?.body).toBe(
        "A publicly readable comment",
      );
    },
  );

  concurrentTest(
    "an anonymous caller can list a public project's pipeline definitions",
    async () => {
      const { owner, project } = await createPublicProject(
        "anon-pipeline-definitions",
        "Public Project Pipeline Definitions",
      );
      await seedPipelineDefinition(
        owner,
        parseUuidV7(project.id),
        "Publicly readable pipeline",
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        ["pipeline-definitions"].get();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0]?.name).toBe("Publicly readable pipeline");
    },
  );

  concurrentTest(
    "an anonymous caller can read a public project's single pipeline definition",
    async () => {
      const { owner, project } = await createPublicProject(
        "anon-pipeline-definition",
        "Public Project Pipeline Definition",
      );
      const definition = await seedPipelineDefinition(
        owner,
        parseUuidV7(project.id),
        "Publicly readable single pipeline",
      );

      const { data, error } = await apiClient.api["pipeline-definitions"]({
        pipelineDefinitionId: definition.id,
      }).get();

      expect(error).toBeNull();
      expect(data?.id).toBe(definition.id);
    },
  );

  concurrentTest(
    "an anonymous caller cannot write to a public project (denied with 401, not 403)",
    async () => {
      const { project } = await createPublicProject(
        "anon-write-denied",
        "Public Project Write Denied Anon",
      );

      const { data, error } = await apiClient.api["work-items"].post({
        projectId: project.id,
        platform: "github",
        platformId: `anon-write-${uuidv7()}`,
        platformKey: `anon-write-${uuidv7()}`,
        url: null,
        title: "Should never be created",
        description: "Anonymous write attempt",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: {},
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest(
    "a logged-in non-member cannot write to a public project without a membership grant",
    async () => {
      const { project } = await createPublicProject(
        "member-write-denied",
        "Public Project Write Denied Member",
      );
      const outsider = await createTestUserAndSession({
        email: `outsider-write-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: `outsider-write-${uuidv7()}`,
          platformKey: `outsider-write-${uuidv7()}`,
          url: null,
          title: "Should never be created",
          description: "Non-member write attempt",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: {},
        },
        { headers: { ...outsider.authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        status: 403,
        code: "PROJECT_FORBIDDEN",
      });
    },
  );

  concurrentTest(
    "an anonymous caller is still denied a private project exactly as before (401)",
    async () => {
      const { project } = await createProject(
        "private-anon-denied",
        "Private Project Anon Denied",
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .get();

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest(
    "a logged-in non-member is still denied a private project exactly as before (403)",
    async () => {
      const { project } = await createProject(
        "private-member-denied",
        "Private Project Member Denied",
      );
      const outsider = await createTestUserAndSession({
        email: `outsider-private-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .get({ headers: { ...outsider.authHeaders } });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
    },
  );
});
