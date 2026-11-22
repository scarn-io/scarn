import { permissionsForRole } from "@/projects/project/domain/project-role";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { describe, expect } from "bun:test";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { RecordingAnalytics } from "@/lib/analytics/recording-analytics";

describe("project post endpoint", () => {
  const analytics = new RecordingAnalytics();
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-24T12:00:00.000Z")),
      analytics,
    }),
  );

  const projectCreatedCallsFor = (projectId: string) =>
    analytics
      .callsFor("project_created")
      .filter((call) => call.properties.project_id === projectId);

  concurrentTest(
    "reports project_created as a github web project by default for a github.com URL",
    async () => {
      const apiClient = createScarnTreaty(app);
      const owner = await createTestUserAndSession({
        email: `analytics-web-${crypto.randomUUID()}@example.com`,
      });

      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Analytics Web Project",
            description: null,
            gitUrl: "https://github.com/example/analytics-web.git",
          },
          { headers: { ...owner.authHeaders } },
        ),
      );

      expect(projectCreatedCallsFor(project.id)).toEqual([
        {
          distinctId: owner.userId,
          event: "project_created",
          properties: {
            project_id: project.id,
            source: "github",
            origin: "web",
          },
        },
      ]);
    },
  );

  concurrentTest("reports the origin the CLI hand-off sends", async () => {
    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `analytics-cli-${crypto.randomUUID()}@example.com`,
    });

    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Analytics CLI Project",
          description: null,
          gitUrl: "https://github.com/example/analytics-cli.git",
          origin: "cli_handoff",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    expect(projectCreatedCallsFor(project.id)).toEqual([
      {
        distinctId: owner.userId,
        event: "project_created",
        properties: {
          project_id: project.id,
          source: "github",
          origin: "cli_handoff",
        },
      },
    ]);
  });

  concurrentTest(
    "reports a non-GitHub repo as manual and stores its gitUrl as given",
    async () => {
      const apiClient = createScarnTreaty(app);
      const owner = await createTestUserAndSession({
        email: `analytics-manual-${crypto.randomUUID()}@example.com`,
      });
      const gitUrl = "git@gitlab.example.com:team/Tooling.git";

      const project = await unwrapAsync(
        apiClient.api.projects.post(
          { name: "Tooling", description: null, gitUrl },
          { headers: { ...owner.authHeaders } },
        ),
      );

      expect(project).toMatchObject({ gitUrl, initialSyncFailed: false });
      expect(projectCreatedCallsFor(project.id)).toEqual([
        {
          distinctId: owner.userId,
          event: "project_created",
          properties: {
            project_id: project.id,
            source: "manual",
            origin: "web",
          },
        },
      ]);
    },
  );

  concurrentTest(
    "creates a project and owner membership for the authenticated user",
    async () => {
      const apiClient = createScarnTreaty(app);
      const owner = await createTestUserAndSession({
        email: `owner-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api.projects.post(
        {
          name: "Platform Delivery",
          description: "Internal automation and work item workflows",
          gitUrl: "https://github.com/example/platform-delivery.git",
        },
        {
          headers: {
            ...owner.authHeaders,
          },
        },
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({
        initialSyncFailed: false,
        name: "Platform Delivery",
        description: "Internal automation and work item workflows",
        gitUrl: "https://github.com/example/platform-delivery.git",
        createdByUserId: owner.userId,
      });
      expect(data?.createdByUserId).toBe(parseUuidV7(owner.userId));
      expect(data?.memberships[0]).toMatchObject({
        role: "admin",
        permissions: [...permissionsForRole("admin")],
      });
    },
  );

  concurrentTest(
    "does not seed default steps or pipelines for new projects",
    async () => {
      const apiClient = createScarnTreaty(app);
      const owner = await createTestUserAndSession({
        email: `unseeded-project-${crypto.randomUUID()}@example.com`,
      });

      const project = await apiClient.api.projects.post(
        {
          name: "Unseeded Project",
          description: "Project should start without seeded defaults",
          gitUrl: "https://github.com/example/unseeded-project.git",
        },
        {
          headers: {
            ...owner.authHeaders,
          },
        },
      );

      expect(project.error).toBeNull();
      if (!project.data) throw new Error("Expected project.data");
      const projectId = parseUuidV7(project.data.id);

      const stepDefinitions = await apiClient.api["step-definitions"].get({
        query: { projectId },
        headers: { ...owner.authHeaders },
      });
      const pipelineDefinitions = await apiClient.api
        .projects({ projectId })
        ["pipeline-definitions"].get({ headers: { ...owner.authHeaders } });

      expect(stepDefinitions.error).toBeNull();
      expect(pipelineDefinitions.error).toBeNull();

      expect(stepDefinitions.data).toEqual([]);
      expect(pipelineDefinitions.data).toEqual([]);
    },
  );

  concurrentTest("returns 400 when gitUrl is missing", async () => {
    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `missing-git-url-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api.projects.post(
      {
        name: "Missing Git Url Project",
        description: "Should fail validation",
      } as never,
      {
        headers: {
          ...owner.authHeaders,
        },
      },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
  });

  concurrentTest(
    "returns 401 when the request is unauthenticated",
    async () => {
      const apiClient = createScarnTreaty(app);
      const { data, error } = await apiClient.api.projects.post({
        name: "Unauthorized Project",
        description: "Should not be created",
        gitUrl: "https://github.com/example/unauthorized-project.git",
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
      expect(error?.value).toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
        title: "Authentication required",
      });
    },
  );
});
