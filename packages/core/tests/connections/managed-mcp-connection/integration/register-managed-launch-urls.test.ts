/**
 * The worker sends the URL it resolved for each MCP server: a
 * connection-auth entry's must be its connection's `resource`, and a remote
 * without auth may not point at a connection's.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { getDb } from "@/lib/db";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import {
  createLaunchTestClient,
  notionRef,
} from "./register-managed-launch-test-support";

describe("POST /task-runs/:taskRunId/managed-launch URL checks", () => {
  const harness = createManagedConnectionHarness();
  const { fake, appContext } = harness;
  const { startAndClaim, register } = createLaunchTestClient(harness);

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const openLaunches = (taskRunId: Parameters<typeof register>[1]) =>
    appContext.managedLaunchRepo.listOpenForRun(taskRunId, getDb());

  test("an entry URL that differs only in normalization registers", async () => {
    const { owner, projectId } = await harness.connectToReady("urls-normal");
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );
    const url = new URL(fake.resource);

    const launch = await unwrapAsync(
      register(owner, taskRunId, claimToken, {
        entries: {
          notion: {
            url: `HTTP://${url.host.toUpperCase()}${url.pathname}/`,
          },
        },
      }),
    );

    expect(Object.keys(launch.entries)).toEqual(["notion"]);
  });

  test("an entry URL that isn't the connection's is refused with the expected URL", async () => {
    const { owner, projectId } = await harness.connectToReady("urls-mismatch");
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );

    const { data, error } = await register(owner, taskRunId, claimToken, {
      entries: { notion: { url: "https://mcp.example.test/mcp" } },
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "SCARN_MCP_CONNECTION_AUTH_INVALID",
      meta: { key: "notion", connection: "notion", expectedUrl: fake.resource },
    });
    expect(JSON.stringify(error?.value)).toContain(
      `Point it at ${fake.resource}`,
    );
    expect(await openLaunches(taskRunId)).toEqual([]);
  });

  test("an entry URL that isn't a valid MCP URL is refused", async () => {
    const { owner, projectId } = await harness.connectToReady("urls-invalid");
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );

    const { error } = await register(owner, taskRunId, claimToken, {
      entries: { notion: { url: `${fake.resource}?token=x` } },
    });

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "SCARN_MCP_CONNECTION_AUTH_INVALID",
    });
  });

  test("a connection that isn't ready fails as not ready even with a wrong URL", async () => {
    const { owner, projectId } = await harness.connectToReady("urls-a");
    const { taskRunId, claimToken } = await startAndClaim(owner, projectId, {
      missing: { type: "ref", auth: { connection: "missing" } },
    });

    const { error } = await register(owner, taskRunId, claimToken, {
      entries: { missing: { url: "https://mcp.example.test/mcp" } },
    });

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: { key: "missing", connection: "missing" },
    });
  });

  test("a missing entry URL is refused", async () => {
    const { owner, projectId } = await harness.connectToReady("urls-missing");
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );

    const { error } = await register(owner, taskRunId, claimToken, {
      entries: { other: { url: fake.resource } },
    });

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({
      code: "MANAGED_LAUNCH_ENTRY_URL_MISSING",
    });
    expect(await openLaunches(taskRunId)).toEqual([]);
  });

  test("a remote without auth at a connection's URL is refused", async () => {
    const { owner, projectId } = await harness.connectToReady("urls-unauthed");
    const { taskRunId, claimToken } = await startAndClaim(owner, projectId, {
      ...notionRef,
      bare: { type: "remote", url: fake.resource },
    });

    const { error } = await register(owner, taskRunId, claimToken, {
      remotesWithoutAuth: { bare: { url: `${fake.resource}/` } },
    });

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "SCARN_MCP_CONNECTION_AUTH_INVALID",
      meta: { key: "bare", connection: "notion" },
    });
    expect(await openLaunches(taskRunId)).toEqual([]);
  });

  test("a remote without auth elsewhere doesn't block the launch", async () => {
    const { owner, projectId } = await harness.connectToReady("urls-other");
    const { taskRunId, claimToken } = await startAndClaim(owner, projectId, {
      ...notionRef,
      plain: { type: "remote", url: "https://example.test/mcp" },
    });

    const launch = await unwrapAsync(
      register(owner, taskRunId, claimToken, {
        remotesWithoutAuth: { plain: { url: "https://example.test/mcp" } },
      }),
    );

    expect(Object.keys(launch.entries)).toEqual(["notion"]);
  });

  test("entries the run's config doesn't reference are ignored", async () => {
    const { owner, projectId } = await harness.connectToReady("urls-extra");
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );

    const launch = await unwrapAsync(
      register(owner, taskRunId, claimToken, {
        entries: {
          notion: { url: fake.resource },
          stray: { url: "https://mcp.example.test/mcp" },
        },
      }),
    );

    expect(Object.keys(launch.entries)).toEqual(["notion"]);
  });
});
