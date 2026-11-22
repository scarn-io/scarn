import type { ProjectRole } from "@/projects/project/domain/project-role";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  managedConnectionEvents,
  managedOAuthAttempts,
  managedOAuthGrants,
} from "@/lib/db/schema";
import {
  addWriteMember,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

describe("managed consent permission changes", () => {
  const harness = createManagedConnectionHarness();
  const { apiClient, fake } = harness;

  afterEach(() => {
    fake.reset();
  });
  afterAll(async () => {
    await fake.stop();
  });

  const setRole = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    member: ProjectSecretsTestUser,
    role: ProjectRole,
  ) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .members({ userId: parseUuidV7(member.userId) })
        .role.put({ role }, { headers: owner.authHeaders }),
    );

  const addAdmin = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    label: string,
  ) => {
    const admin = await createProjectSecretsTestUser(label);
    await addWriteMember(apiClient, projectId, owner, admin);
    await setRole(owner, projectId, admin, "admin");
    return admin;
  };

  const grantsOf = async (connectionId: string) =>
    await getDb()
      .select()
      .from(managedOAuthGrants)
      .where(eq(managedOAuthGrants.connectionId, connectionId));

  const attemptsOf = async (connectionId: string) =>
    await getDb()
      .select()
      .from(managedOAuthAttempts)
      .where(eq(managedOAuthAttempts.connectionId, connectionId));

  for (const path of ["membership", "invite"] as const) {
    const downgrade = async (
      owner: ProjectSecretsTestUser,
      projectId: UuidV7,
      admin: ProjectSecretsTestUser,
    ) => {
      if (path === "membership") {
        await setRole(owner, projectId, admin, "write");
      } else {
        const { inviteUrl } = await unwrapAsync(
          apiClient.api
            .projects({ projectId })
            .invites.post(
              { role: "write", restriction: "any_authenticated_user" },
              { headers: owner.authHeaders },
            ),
        );
        const token = inviteUrl.split("/invite/")[1] ?? "";
        await unwrapAsync(
          apiClient.api["project-invites"]({ token }).accept.post(undefined, {
            headers: admin.authHeaders,
          }),
        );
      }
    };

    test(`${path}: cancels only the affected actor's pending attempt and rejects its callback`, async () => {
      const { owner, projectId, connectionId } = await harness.connectToReady(
        `permissions-${path}-attempt`,
      );
      const admin = await addAdmin(owner, projectId, `${path}-attempt`);
      const callbackUrl = await harness.reconnectToCallback(
        admin,
        projectId,
        connectionId,
      );
      const before = await attemptsOf(connectionId);
      const ownAttempt = before.find((a) => a.actorUserId === admin.userId);
      expect(ownAttempt?.status).toBe("pending");

      await downgrade(owner, projectId, admin);

      const after = await attemptsOf(connectionId);
      expect(after.find((a) => a.id === ownAttempt?.id)).toMatchObject({
        status: "cancelled",
        pkceVerifierCiphertext: null,
      });
      const tokenCalls = fake.callsTo("token").length;
      const { location } = await harness.callback(
        callbackUrl,
        admin.authHeaders,
      );
      expect(location.searchParams.get("error")).toBe("invalid_callback");
      expect(fake.callsTo("token")).toHaveLength(tokenCalls);
      const events = await getDb()
        .select()
        .from(managedConnectionEvents)
        .where(eq(managedConnectionEvents.connectionId, connectionId));
      expect(
        events.filter((event) => event.reasonCode === "permission_revoked"),
      ).toMatchObject([
        {
          type: "attempt_failed",
          actorUserId: admin.userId,
          reasonCode: "permission_revoked",
        },
      ]);
    });

    test(`${path}: another admin's pending attempt is untouched`, async () => {
      const { owner, projectId, connectionId } = await harness.connectToReady(
        `permissions-${path}-other`,
      );
      const admin = await addAdmin(owner, projectId, `${path}-other`);
      const callbackUrl = await harness.reconnectToCallback(
        owner,
        projectId,
        connectionId,
      );
      const before = await attemptsOf(connectionId);
      await downgrade(owner, projectId, admin);
      expect(await attemptsOf(connectionId)).toEqual(before);
      const { location } = await harness.callback(
        callbackUrl,
        owner.authHeaders,
      );
      expect(location.searchParams.get("error")).toBeNull();
    });

    test(`${path}: cleanup failure rolls back membership and candidate deletion`, async () => {
      const { owner, projectId, connectionId } = await harness.connectToReady(
        `permissions-${path}-rollback`,
      );
      const admin = await addAdmin(owner, projectId, `${path}-rollback`);
      const { pending } = await harness.reconnectToCandidate(
        admin,
        projectId,
        connectionId,
      );
      const before = await grantsOf(connectionId);
      const repo = harness.appContext.managedConnectionEventRepo;
      const append = repo.append.bind(repo);
      repo.append = () => {
        throw new Error("injected consent audit failure");
      };
      let failed = false;
      try {
        await downgrade(owner, projectId, admin);
      } catch {
        failed = true;
      } finally {
        repo.append = append;
      }
      expect(failed).toBe(true);
      expect(await grantsOf(connectionId)).toEqual(before);
      expect(
        await harness.getConnection(owner, projectId, connectionId),
      ).toEqual(pending);
      const project = await harness.appContext.projectRepo.load(projectId);
      expect(
        project?.getMembership(parseUuidV7(admin.userId))?.permissions,
      ).toContain("secrets:write");
    });

    test(`${path}: deletes the actor's candidate ciphertext and preserves the serving grant`, async () => {
      const { owner, projectId, connectionId, ready } =
        await harness.connectToReady(`permissions-${path}-candidate`);
      const admin = await addAdmin(owner, projectId, `${path}-candidate`);
      const before = await grantsOf(connectionId);
      const { candidate } = await harness.reconnectToCandidate(
        admin,
        projectId,
        connectionId,
      );
      expect(await grantsOf(connectionId)).toHaveLength(2);

      await downgrade(owner, projectId, admin);

      expect(await grantsOf(connectionId)).toEqual(before);
      expect(
        (await grantsOf(connectionId)).some((g) => g.id === candidate.id),
      ).toBe(false);
      expect(
        await harness.getConnection(owner, projectId, connectionId),
      ).toMatchObject({
        state: "ready",
        candidate: null,
        generation: ready.generation,
        account: ready.account,
      });
      const tools = await harness
        .connections(projectId)({ connectionId })
        .tools.get({ headers: owner.authHeaders });
      expect(tools.error).toBeNull();
      expect(fake.callsTo("revoke")).toHaveLength(0);
      const events = await getDb()
        .select()
        .from(managedConnectionEvents)
        .where(eq(managedConnectionEvents.connectionId, connectionId));
      expect(
        events.filter((event) => event.reasonCode === "permission_revoked"),
      ).toMatchObject([
        {
          type: "candidate_cancelled",
          actorUserId: admin.userId,
          reasonCode: "permission_revoked",
        },
      ]);
    });

    test(`${path}: a confirmed grant survives its creator and confirmer losing permission`, async () => {
      const { owner, projectId, connectionId } = await harness.connectToReady(
        `permissions-${path}-confirmed`,
      );
      const admin = await addAdmin(owner, projectId, `${path}-confirmed`);
      const { candidate, pending } = await harness.reconnectToCandidate(
        admin,
        projectId,
        connectionId,
      );
      const ready = await unwrapAsync(
        harness
          .connections(projectId)({ connectionId })
          .candidate.confirm.post(
            {
              candidateId: candidate.id,
              fingerprint: candidate.fingerprint,
              expectedVersion: pending.version,
            },
            { headers: { ...admin.authHeaders, origin: harness.origin } },
          ),
      );
      const before = await grantsOf(connectionId);

      await downgrade(owner, projectId, admin);

      expect(await grantsOf(connectionId)).toEqual(before);
      expect(
        await harness.getConnection(owner, projectId, connectionId),
      ).toMatchObject({
        state: "ready",
        generation: ready.generation,
        account: ready.account,
      });
      const tools = await harness
        .connections(projectId)({ connectionId })
        .tools.get({ headers: owner.authHeaders });
      expect(tools.error).toBeNull();
      expect(fake.callsTo("revoke")).toHaveLength(0);
    });
  }

  test("retaining secrets:write leaves the actor's candidate untouched", async () => {
    const { owner, projectId, connectionId } = await harness.connectToReady(
      "permissions-unchanged",
    );
    const admin = await addAdmin(owner, projectId, "unchanged");
    const { candidate } = await harness.reconnectToCandidate(
      admin,
      projectId,
      connectionId,
    );
    const beforeGrants = await grantsOf(connectionId);
    const beforeAttempts = await attemptsOf(connectionId);

    await setRole(owner, projectId, admin, "admin");

    expect(await grantsOf(connectionId)).toEqual(beforeGrants);
    expect(await attemptsOf(connectionId)).toEqual(beforeAttempts);
    expect(
      (await harness.getConnection(owner, projectId, connectionId)).candidate
        ?.id,
    ).toBe(candidate.id);
  });

  test("retaining secrets:write leaves the actor's open attempt untouched", async () => {
    const { owner, projectId, connectionId } = await harness.connectToReady(
      "permissions-unchanged-attempt",
    );
    const admin = await addAdmin(owner, projectId, "unchanged-attempt");
    const callbackUrl = await harness.reconnectToCallback(
      admin,
      projectId,
      connectionId,
    );
    const before = await attemptsOf(connectionId);
    await setRole(owner, projectId, admin, "admin");
    expect(await attemptsOf(connectionId)).toEqual(before);
    const { location } = await harness.callback(callbackUrl, admin.authHeaders);
    expect(location.searchParams.get("error")).toBeNull();
  });
});
