import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { RecordingAnalytics } from "@/lib/analytics/recording-analytics";
import { permissionsForRole } from "@/projects/project/domain/project-role";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createTestUserAndSession,
  type TestUserAndSession,
} from "../../project/integration/auth-test-utils";

describe("project invite accept endpoint", () => {
  const analytics = new RecordingAnalytics();
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-24T12:00:00.000Z")),
      analytics,
    }),
  );
  const apiClient = createScarnTreaty(app);

  const inviteToProject = async (label: string) => {
    const owner = await createTestUserAndSession({
      email: `invite-accept-owner-${crypto.randomUUID()}@example.com`,
    });
    const inviteeEmail = `invite-accept-${label}-${crypto.randomUUID()}@example.com`;
    const invitee = await createTestUserAndSession({ email: inviteeEmail });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: `Invite Accept ${label}`,
          description: null,
          gitUrl: "https://github.com/example/invite-accept.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const { inviteUrl } = await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).invites.post(
        {
          email: inviteeEmail,
          role: "write",
          restriction: "specific_email",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const rawToken = inviteUrl.split("/invite/")[1] ?? "";
    return { owner, invitee, projectId: project.id, rawToken };
  };

  const accept = async (rawToken: string, invitee: TestUserAndSession) =>
    await unwrapAsync(
      apiClient.api["project-invites"]({ token: rawToken }).accept.post(
        undefined,
        { headers: { ...invitee.authHeaders } },
      ),
    );

  const membershipOf = async (
    projectId: string,
    member: TestUserAndSession,
    owner: TestUserAndSession,
  ) =>
    (
      await unwrapAsync(
        apiClient.api
          .projects({ projectId })
          .get({ headers: { ...owner.authHeaders } }),
      )
    ).memberships.find((membership) => membership.userId === member.userId);

  const inviteAcceptedCallsFor = (projectId: string) =>
    analytics
      .callsFor("invite_accepted")
      .filter((call) => call.properties.project_id === projectId);

  concurrentTest(
    "reports invite_accepted with new_member true for someone joining",
    async () => {
      const { invitee, projectId, rawToken } = await inviteToProject("new");

      await accept(rawToken, invitee);

      expect(inviteAcceptedCallsFor(projectId)).toEqual([
        {
          distinctId: invitee.userId,
          event: "invite_accepted",
          properties: {
            project_id: projectId,
            role: "write",
            new_member: true,
          },
        },
      ]);
    },
  );

  concurrentTest(
    "reports new_member false when the invitee was already a member",
    async () => {
      const { owner, invitee, projectId, rawToken } =
        await inviteToProject("existing");
      await unwrapAsync(
        apiClient.api
          .projects({ projectId })
          .members({ userId: invitee.userId })
          .role.put({ role: "read" }, { headers: { ...owner.authHeaders } }),
      );

      await accept(rawToken, invitee);

      expect(
        inviteAcceptedCallsFor(projectId).map(
          (call) => call.properties.new_member,
        ),
      ).toEqual([false]);
    },
  );

  concurrentTest("copies the invite's role onto a new membership", async () => {
    const { owner, invitee, projectId, rawToken } =
      await inviteToProject("role-new");

    await accept(rawToken, invitee);

    expect(await membershipOf(projectId, invitee, owner)).toMatchObject({
      role: "write",
      permissions: [...permissionsForRole("write")],
    });
  });

  concurrentTest(
    "replaces an existing member's role with the invite's role",
    async () => {
      const { owner, invitee, projectId, rawToken } =
        await inviteToProject("role-existing");
      await unwrapAsync(
        apiClient.api
          .projects({ projectId })
          .members({ userId: invitee.userId })
          .role.put({ role: "read" }, { headers: { ...owner.authHeaders } }),
      );

      await accept(rawToken, invitee);

      expect((await membershipOf(projectId, invitee, owner))?.role).toBe(
        "write",
      );
    },
  );
});
