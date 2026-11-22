/* eslint-disable max-lines */
/**
 * The managed relay end to end (Phase 8): the real worker loop launches the
 * pinned OpenCode on the host, which reaches the fake Notion only through
 * the API relay served on a real loopback listener. Only the AI provider is
 * scripted (`FakeAiServer`); the API, Postgres, the worker, OpenCode and its
 * MCP client are real.
 *
 * - A declared auth health check calls a read tool through the relay before
 *   the agent's first turn; the agent then calls the tool again, and no
 *   token reaches the task log, API or worker logs, events or the OpenCode
 *   config; the capability reaches no log.
 * - A disconnect while a call is in flight fails the run with
 *   `ManagedConnectionAuthorityLost` and no retry, though the step retries
 *   `Scarn.All`.
 * - A tool call refused after a disconnect, followed by the agent's "Done.",
 *   still ends the run failed.
 *
 * Gated behind SCARN_INTEGRATION=true like the worker's real-OpenCode tests:
 * it needs the OpenCode runtime payload in `~/.scarn/runtimes`. Run from
 * `packages/core` with:
 *   SCARN_INTEGRATION=true bun test tests/connections/managed-mcp-connection/integration/managed-mcp-relay-opencode-e2e.test.ts
 */
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setDefaultLogDestination } from "@scarn/observability/logging/host";
import { setHomeDirForTests } from "@scarn/sdk/defaults";
import { createDefaultProjectWorkDeps, runProjectWork } from "@scarn/worker";
import {
  FakeAiServer,
  seedOpencodeConfig,
} from "@scarn/worker/testing/fake-ai";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { managedConnectionEvents, projects } from "@/lib/db/schema";
import { unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import {
  authorityLost,
  createSealTestClient,
  type SealProject,
} from "./managed-authority-seal-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const execFileAsync = promisify(execFile);

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const TEST_TIMEOUT_MS = 4 * 60 * 1000;
const TOOL = "notion-tool-0-0";
const OPENCODE_TOOL = `notion_${TOOL}`;
const FINAL_TEXT = "Done.";
const SLOW_PROVIDER_MS = 8_000;
const RETRY_ALL = { retry: [{ on: ["Scarn.All"], maxAttempts: 2 }] };

const waitFor = async (
  label: string,
  condition: () => boolean,
  timeoutMs = 120_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await Bun.sleep(25);
  }
};

const git = (cwd: string, args: string[]) =>
  execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

const createFixtureRepo = async (root: string) => {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "# Relay e2e fixture\n");
  await mkdir(path.join(repo, ".opencode"));
  await writeFile(
    path.join(repo, ".opencode", "opencode.json"),
    JSON.stringify({
      mcp: { notion: { type: "remote", url: "https://mcp.notion.com/mcp" } },
    }),
  );
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Scarn Integration",
    "-c",
    "user.email=integration@scarn.io",
    "commit",
    "--no-gpg-sign",
    "-m",
    "Relay fixture",
  ]);
  return repo;
};

/** Every regular file under `dir` modified since `since`, as latin1 text. */
const readFilesSince = async (dir: string, since: number) => {
  const texts: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return texts;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.mtimeMs >= since) {
      texts.push(
        `${file}\n${(await readFile(file).catch(() => Buffer.alloc(0))).toString("latin1")}`,
      );
    }
  }
  return texts;
};

/** `readFilesSince` over the entries of `dir` created since `since`, skipping older runs' leftovers. */
const readNewEntriesSince = async (dir: string, since: number) => {
  const texts: string[] = [];
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const info = await stat(path.join(dir, entry)).catch(() => null);
    if (info && info.birthtimeMs >= since) {
      texts.push(...(await readFilesSince(path.join(dir, entry), since)));
    }
  }
  return texts;
};

const ENV_KEYS = [
  "HOME",
  "ANTHROPIC_API_KEY",
  "SCARN_LOCAL_DB_PATH",
  "SCARN_ARTIFACT_STORES",
  "SCARN_ARTIFACT_LOCAL_DIR",
  "SCARN_GIT_CACHE",
  "SCARN_LOG_LEVEL",
] as const;

describe.skipIf(!integrationEnabled)(
  "managed relay with real OpenCode (integration)",
  () => {
    const appRef: {
      current: ((request: Request) => Promise<Response>) | null;
    } = { current: null };
    const relayCapabilities = new Set<string>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: (request) => {
        const bearer = /^Bearer (.+)$/u.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        if (
          bearer &&
          new URL(request.url).pathname.startsWith("/api/mcp-relay/")
        ) {
          relayCapabilities.add(bearer);
        }
        return (
          appRef.current?.(request) ??
          Promise.resolve(new Response(null, { status: 503 }))
        );
      },
    });
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const harness = createManagedConnectionHarness({
      appUrl: baseUrl,
      slowMs: SLOW_PROVIDER_MS,
    });
    appRef.current = (request) => harness.app.handle(request);
    const { fake, apiClient, logs } = harness;
    const seal = createSealTestClient(harness);
    const fakeAi = new FakeAiServer({
      initialToolUseDelayMs: 3_000,
      verbose: process.env["SCARN_INTEGRATION_VERBOSE"] === "true",
    });
    const workerLogs: string[] = [];
    const logDest = { write: (line: string) => workerLogs.push(line) };
    const savedEnv = new Map<string, string | undefined>();
    let root = "";
    let home = "";
    let repo = "";
    let previousLogDest: ReturnType<typeof setDefaultLogDestination>;

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "scarn-relay-e2e-"));
      home = path.join(root, "home");
      await mkdir(path.join(home, ".scarn"), { recursive: true });
      await symlink(
        path.join(os.homedir(), ".scarn", "runtimes"),
        path.join(home, ".scarn", "runtimes"),
        "dir",
      );
      repo = await createFixtureRepo(root);
      for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
      Object.assign(process.env, {
        HOME: home,
        SCARN_LOCAL_DB_PATH: path.join(root, "worker.sqlite"),
        SCARN_ARTIFACT_STORES: "local",
        SCARN_ARTIFACT_LOCAL_DIR: path.join(root, "artifacts"),
        SCARN_GIT_CACHE: "off",
        SCARN_LOG_LEVEL: "debug",
      });
      setHomeDirForTests(home);
      previousLogDest = setDefaultLogDestination(logDest);
      await fakeAi.start();
      Object.assign(
        process.env,
        await seedOpencodeConfig(home, fakeAi.port, {
          fakeAiHost: "127.0.0.1",
        }),
      );
    });

    afterAll(async () => {
      setDefaultLogDestination(previousLogDest);
      setHomeDirForTests(undefined);
      for (const [key, value] of savedEnv) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      await fakeAi.stop().catch(() => undefined);
      await fake.stop();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    });

    /** A project whose ready Notion connection a host step references, cloning the fixture repo. */
    const relayProject = async (label: string, settings: object = {}) => {
      const target = await seal.project(
        label,
        { notion: { type: "ref", auth: { connection: "notion" } } },
        {
          environment: { kind: "inline", runtime: { kind: "host" } },
          repo: { mode: "readOnly", gitCredentials: "none" },
          ...settings,
        },
      );
      await getDb()
        .update(projects)
        .set({ gitUrl: repo })
        .where(eq(projects.id, target.projectId));
      await writeFile(
        path.join(home, ".scarn", "auth.jsonc"),
        JSON.stringify({
          profiles: {
            [baseUrl]: {
              accessToken: target.owner.sessionToken,
              email: target.owner.email,
            },
          },
        }),
      );
      return target;
    };

    const startTask = async (target: SealProject) => {
      const workItemId = await seal.seedNativeWorkItem(target.projectId);
      const started = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId: target.projectId,
            workItemId,
            stepDefinitionId: target.stepId,
            stepDefinitionVersion: 1,
            inputJson: {},
            executionTimeoutSeconds: 600,
          },
          { headers: target.owner.authHeaders },
        ),
      );
      return {
        workItemId,
        taskId: started.task.id,
        taskRunId: started.run.id,
      };
    };

    /** One pass of the real worker loop over the work item; resolves once its run is done. */
    const work = (
      target: SealProject,
      workItemId: UuidV7,
      leaseDurationSeconds: number,
    ) =>
      runProjectWork(
        {
          projectId: target.projectId,
          baseUrl,
          workItemId,
          workerId: `relay-e2e-${crypto.randomUUID()}`,
          once: true,
          pollIntervalMs: 250,
          leaseDurationSeconds,
          sessionStartTimeoutMs: 90_000,
          dest: logDest,
        },
        createDefaultProjectWorkDeps(logDest),
      );

    const runOf = async (target: SealProject, taskRunId: UuidV7) =>
      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId }).get({
          headers: target.owner.authHeaders,
        }),
      );

    const runsOfTask = async (target: SealProject, taskId: UuidV7) =>
      (
        await unwrapAsync(
          apiClient.api
            .tasks({ taskId })
            .runs.get({ headers: target.owner.authHeaders }),
        )
      ).map((run) => ({ number: run.number, status: run.status }));

    const taskLogText = async (target: SealProject, taskRunId: UuidV7) =>
      JSON.stringify(
        await unwrapAsync(
          apiClient.api["task-runs"]({ taskRunId }).logs.get({
            query: { from: 0, limit: 1_000 },
            headers: target.owner.authHeaders,
          }),
        ),
      );

    const expectFreeOf = (label: string, text: string, canaries: string[]) => {
      for (const canary of canaries) {
        expect({ label, leaked: text.includes(canary) }).toEqual({
          label,
          leaked: false,
        });
      }
    };

    test(
      "a declared auth health check reads through OpenCode and the managed relay before the agent runs, without credential leaks",
      async () => {
        const checkName = "managed Notion read";
        const target = await relayProject("relay-e2e-happy", {
          healthChecksJson: [
            {
              kind: "tool",
              name: checkName,
              mcp: "notion",
              tool: TOOL,
              args: { query: "health-check-read" },
              severity: "required",
              timeoutSeconds: 60,
            },
          ],
        });
        const { workItemId, taskRunId } = await startTask(target);
        const since = Date.now();
        const logsBefore = logs.length;
        const workerLogsBefore = workerLogs.length;
        fakeAi.configure(
          OPENCODE_TOOL,
          { query: "relay" },
          {
            finalText: FINAL_TEXT,
          },
        );
        const requestsBefore = fakeAi.requestCount;
        relayCapabilities.clear();

        const working = work(target, workItemId, 60);
        await waitFor("the agent's first turn", () => {
          return fakeAi.requestCount > requestsBefore;
        });
        expect(fake.mcp.effectCount(TOOL)).toBe(1);
        expect(fake.mcp.callsTo("tools/call")).toHaveLength(1);
        expect(relayCapabilities.size).toBe(1);
        fake.faults.mcp = "mcp_slow";
        await waitFor("the relayed tool call", () => {
          return fake.mcp.effectCount(TOOL) > 1;
        });
        const agentFiles = [
          ...(await readNewEntriesSince(
            path.join(os.tmpdir(), "scarn-agent-homes"),
            since,
          )),
          ...(await readNewEntriesSince(
            path.join(os.tmpdir(), "scarn-project-runtime-sessions"),
            since,
          )),
          ...(await readFilesSince(home, since)),
        ];
        const result = await working;
        delete fake.faults.mcp;

        expect(result.claimedCount).toBe(1);
        expect(fake.mcp.callsTo("initialize").length).toBeGreaterThan(0);
        expect(fake.mcp.callsTo("tools/list").length).toBeGreaterThan(0);
        expect(fake.mcp.effectCount(TOOL)).toBe(2);
        const toolResult = JSON.stringify(fakeAi.requests.at(-1)?.messages);
        expect(toolResult).toContain(`called ${TOOL}`);
        const run = await runOf(target, taskRunId);
        expect(run.status).toBe("yielded");

        expect(relayCapabilities.size).toBe(1);
        const [capability = ""] = [...relayCapabilities];
        expect(capability.length).toBeGreaterThan(16);
        const agentLog = agentFiles.filter((file) =>
          file.includes("opencode-serve.log"),
        );
        expect(agentLog.length).toBeGreaterThan(0);

        const tokens = [...fake.issuedTokens];
        expect(tokens.length).toBeGreaterThanOrEqual(2);
        for (const call of fake.mcp.callsTo("tools/call")) {
          expect(tokens).toContain(
            call.authorization?.replace(/^Bearer /u, "") ?? "",
          );
          expect(call.authorization).not.toBe(`Bearer ${capability}`);
        }
        const events = await getDb()
          .select()
          .from(managedConnectionEvents)
          .where(eq(managedConnectionEvents.connectionId, target.connectionId));
        const taskLog = await taskLogText(target, taskRunId);
        expect(taskLog).toContain("notion");
        const apiLogs = logs.slice(logsBefore).join("\n");
        const ownWorkerLogs = workerLogs.slice(workerLogsBefore).join("\n");
        expect(ownWorkerLogs).toContain(taskRunId);
        expect(ownWorkerLogs).toContain("Declared health checks completed");
        expect(ownWorkerLogs).toContain(checkName);
        expect(ownWorkerLogs).toContain("passed");

        for (const { label, text } of [
          { label: "task log", text: taskLog },
          { label: "api logs", text: apiLogs },
          { label: "worker logs", text: ownWorkerLogs },
          { label: "events", text: JSON.stringify(events) },
          { label: "run", text: JSON.stringify(run) },
          { label: "agent files", text: agentFiles.join("\n") },
        ]) {
          expectFreeOf(label, text, tokens);
        }
        for (const { label, text } of [
          { label: "task log", text: taskLog },
          { label: "api logs", text: apiLogs },
          { label: "worker logs", text: ownWorkerLogs },
          { label: "events", text: JSON.stringify(events) },
          { label: "opencode log", text: agentLog.join("\n") },
        ]) {
          expectFreeOf(label, text, [capability]);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a disconnect while a relayed call is in flight fails the run with ManagedConnectionAuthorityLost and no retry",
      async () => {
        const target = await relayProject("relay-e2e-disconnect", RETRY_ALL);
        const { workItemId, taskId, taskRunId } = await startTask(target);
        fakeAi.configure(OPENCODE_TOOL, {}, { finalText: FINAL_TEXT });
        const requestsBefore = fakeAi.requestCount;

        const working = work(target, workItemId, 4);
        await waitFor("the agent's first turn", () => {
          return fakeAi.requestCount > requestsBefore;
        });
        fake.faults.mcp = "mcp_slow";
        const callsBefore = fake.mcp.callsTo("tools/call").length;
        await waitFor("the relayed tool call", () => {
          return fake.mcp.callsTo("tools/call").length > callsBefore;
        });
        await seal.disconnect(target);
        const result = await working;
        delete fake.faults.mcp;

        expect(result.claimedCount).toBe(1);
        expect(fake.mcp.callsTo("tools/call")).toHaveLength(callsBefore + 1);
        expect(await runOf(target, taskRunId)).toMatchObject({
          status: "failed",
          errorJson: authorityLost("disconnected"),
        });
        expect(await runsOfTask(target, taskId)).toEqual([
          { number: 1, status: "failed" },
        ]);
        expect(
          await seal.authorityLostEvents(target.connectionId),
        ).toMatchObject([{ taskRunId, reasonCode: "disconnected" }]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      `a tool call refused after a disconnect, then the agent's "${FINAL_TEXT}", still ends the run failed`,
      async () => {
        const target = await relayProject("relay-e2e-done", RETRY_ALL);
        const { workItemId, taskId, taskRunId } = await startTask(target);
        fakeAi.configure(OPENCODE_TOOL, {}, { finalText: FINAL_TEXT });
        const requestsBefore = fakeAi.requestCount;
        const effectsBefore = fake.mcp.effectCount(TOOL);

        const working = work(target, workItemId, 60);
        await waitFor("the agent's first turn", () => {
          return fakeAi.requestCount > requestsBefore;
        });
        await seal.disconnect(target);
        const result = await working;

        expect(result.claimedCount).toBe(1);
        expect(fake.mcp.effectCount(TOOL)).toBe(effectsBefore);
        const toolTurn = fakeAi.requests.at(-1);
        expect(JSON.stringify(toolTurn?.messages)).toContain("tool_result");
        expect(await runOf(target, taskRunId)).toMatchObject({
          status: "failed",
          errorJson: authorityLost("disconnected"),
        });
        expect(await runsOfTask(target, taskId)).toEqual([
          { number: 1, status: "failed" },
        ]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
