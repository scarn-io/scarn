import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
  addWriteMember,
  createProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const CANDIDATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Confirming a candidate is a compare-and-set on exactly what the admin was
 * shown, by a member holding `secrets:write`, from the Scarn app.
 */
describe("managed connection confirm", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, origin } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  test("a wrong fingerprint is refused and leaves the candidate waiting", async () => {
    const { owner, projectId, connectionId, pending, candidate } =
      await harness.connectToCandidate("confirm-fingerprint");

    const { error } = await harness
      .connections(projectId)({ connectionId })
      .candidate.confirm.post(
        {
          candidateId: candidate.id,
          fingerprint: "0".repeat(candidate.fingerprint.length),
          expectedVersion: pending.version,
        },
        { headers: { ...owner.authHeaders, origin } },
      );

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_CANDIDATE_MISMATCH",
    });
    const after = await harness.getConnection(owner, projectId, connectionId);
    expect(after).toMatchObject({
      state: "awaiting_confirmation",
      version: pending.version,
      candidate,
    });
  });

  test("a second tab's stale expectedVersion is refused", async () => {
    const started = await harness.connectToCallback("confirm-stale");
    const { owner, projectId, connectionId } = started;
    const secondTab = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    await harness.callback(started.callbackUrl, owner.authHeaders);
    const firstTab = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    const candidate = firstTab.candidate;
    if (!candidate) {
      throw new Error("expected a candidate");
    }
    expect(secondTab.version).toBeLessThan(firstTab.version);
    const confirm = (expectedVersion: number) =>
      harness
        .connections(projectId)({ connectionId })
        .candidate.confirm.post(
          {
            candidateId: candidate.id,
            fingerprint: candidate.fingerprint,
            expectedVersion,
          },
          { headers: { ...owner.authHeaders, origin } },
        );

    const stale = await confirm(secondTab.version);

    expect(stale.error?.status).toBe(409);
    expect(stale.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_VERSION_CONFLICT",
    });
    const confirmed = await confirm(firstTab.version);
    expect(confirmed.data).toMatchObject({ state: "ready" });
    const replayed = await confirm(firstTab.version);
    expect(replayed.error?.status).toBe(409);
    expect(replayed.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_VERSION_CONFLICT",
    });
  });

  test("a candidate older than 10 minutes can't be confirmed", async () => {
    const { owner, projectId, connectionId, pending, candidate } =
      await harness.connectToCandidate("confirm-expired");
    clock.advance(CANDIDATE_WINDOW_MS);

    const { error } = await harness
      .connections(projectId)({ connectionId })
      .candidate.confirm.post(
        {
          candidateId: candidate.id,
          fingerprint: candidate.fingerprint,
          expectedVersion: pending.version,
        },
        { headers: { ...owner.authHeaders, origin } },
      );

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "MANAGED_CANDIDATE_EXPIRED" });
  });

  test("a member without secrets:write gets 403 on every write", async () => {
    const { owner, projectId, connectionId, pending, candidate } =
      await harness.connectToCandidate("confirm-writer");
    const writer = await createProjectSecretsTestUser("confirm-writer");
    await addWriteMember(harness.apiClient, projectId, owner, writer);
    const headers = { ...writer.authHeaders, origin };
    const connection = harness.connections(projectId)({ connectionId });

    const confirmed = await connection.candidate.confirm.post(
      {
        candidateId: candidate.id,
        fingerprint: candidate.fingerprint,
        expectedVersion: pending.version,
      },
      { headers },
    );
    const cancelled = await connection.candidate.cancel.post(
      { candidateId: candidate.id },
      { headers },
    );
    const started = await harness
      .connections(projectId)
      .post({ preset: "notion" }, { headers });

    for (const { error } of [confirmed, cancelled, started]) {
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({ code: "PROJECT_FORBIDDEN" });
    }
    const listed = await harness
      .connections(projectId)
      .get({ headers: writer.authHeaders });
    expect(listed.data?.map((item) => item.id)).toEqual([connectionId]);
    expect(
      await harness.getConnection(owner, projectId, connectionId),
    ).toMatchObject({ state: "awaiting_confirmation", candidate });
  });

  test("an anonymous caller or a non-member gets 404 on reads of a public project", async () => {
    const { projectId, connectionId } =
      await harness.connectToCandidate("confirm-public");
    await getDb()
      .update(projects)
      .set({ visibility: "public" })
      .where(eq(projects.id, projectId));
    const stranger = await createProjectSecretsTestUser("confirm-stranger");

    for (const headers of [{}, stranger.authHeaders]) {
      const listed = await harness.connections(projectId).get({ headers });
      const read = await harness
        .connections(projectId)({ connectionId })
        .get({ headers });
      expect(listed.error?.status).toBe(404);
      expect(read.error?.status).toBe(404);
    }
  });

  test("a POST from a foreign or missing Origin is rejected", async () => {
    const { owner, projectId, connectionId, pending, candidate } =
      await harness.connectToCandidate("confirm-origin");
    const body = {
      candidateId: candidate.id,
      fingerprint: candidate.fingerprint,
      expectedVersion: pending.version,
    };
    const connection = harness.connections(projectId)({ connectionId });

    for (const headers of [
      { ...owner.authHeaders, origin: "https://evil.example" },
      owner.authHeaders,
    ]) {
      const confirmed = await connection.candidate.confirm.post(body, {
        headers,
      });
      const cancelled = await connection.candidate.cancel.post(
        { candidateId: candidate.id },
        { headers },
      );
      const started = await harness
        .connections(projectId)
        .post({ preset: "notion" }, { headers });
      for (const { error } of [confirmed, cancelled, started]) {
        expect(error?.status).toBe(403);
        expect(error?.value).toMatchObject({ code: "UNTRUSTED_ORIGIN" });
      }
    }
    expect(
      await harness.getConnection(owner, projectId, connectionId),
    ).toMatchObject({
      state: "awaiting_confirmation",
      version: pending.version,
      candidate,
    });
  });
});
