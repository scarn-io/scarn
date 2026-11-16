/**
 * `buildDryRunOrchestrator` builds its clone service through the same
 * shared factory as the real orchestrator, so a dry run exercises the mirror
 * cache (or the plain clone when `SCARN_GIT_CACHE=off`) exactly like a real
 * run.
 */
import { rm } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { noopLogger } from "@scarn/observability/logging/host";
import { ConfigurationError } from "../../../../src/lib/errors";
import { buildDryRunOrchestrator } from "../../../../src/work/task-run/application/run-work-dry-run-orchestrators";
import { DirectProviderAccessResolver } from "../../../../src/work/task-run/infra/provider-access/direct-provider-access-resolver";
import { SafeProviderAccessResolver } from "../../../../src/work/task-run/infra/provider-access/safe-provider-access-resolver";
import {
  pathExists,
  setupCachedCloneFixture,
  disposeMirrorFixtureTemplate,
} from "../../../runtime/runtime-service/unit/cached-git-clone-fixtures";
import { buildLaunchInput } from "./helpers/orchestrator-launch-fakes";

afterAll(disposeMirrorFixtureTemplate);

describe("buildDryRunOrchestrator git cache wiring", () => {
  let fixtureRoot: string | null = null;

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = null;
    }
  });

  function safeResolver() {
    return new SafeProviderAccessResolver(
      new DirectProviderAccessResolver({ logger: noopLogger }),
    );
  }

  async function launchAgainstFixture(
    localEnvVars: Record<string, string>,
    runtime: "host" | "container" = "container",
    startAgent = true,
  ) {
    const fx = await setupCachedCloneFixture();
    fixtureRoot = fx.root;
    const orchestrator = buildDryRunOrchestrator(
      noopLogger,
      { SCARN_GIT_CACHE_DIR: fx.cacheDir, ...localEnvVars },
      safeResolver(),
    );
    let outcome = "launched";
    try {
      const environment = await orchestrator.launch({
        ...buildLaunchInput(),
        environment:
          runtime === "host"
            ? { kind: "inline", runtime: { kind: "host" } }
            : { kind: "inline", runtime: { kind: "devcontainer" } },
        startAgent,
        gitUrl: fx.remote,
        stepKey: undefined,
        repo: {
          mode: "readOnly",
          gitCredentials: "none",
          baseBranch: null,
        },
        resolveMcpEnv: () => {
          throw new Error("host checkout reached MCP env resolution");
        },
      });
      await environment.cleanup();
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    expect(outcome).toMatch(
      runtime === "host" && !startAgent
        ? /^launched$/u
        : runtime === "host"
          ? /host checkout reached MCP env resolution/u
          : /Devcontainer auto-discovery found no config; checked: \.devcontainer\/devcontainer\.json, devcontainer\.json/u,
    );
    return fx;
  }

  test("clones through the mirror cache by default", async () => {
    const fx = await launchAgainstFixture({});

    expect(await pathExists(fx.mirrorPath)).toBe(true);
  });

  test("SCARN_GIT_CACHE=off in localEnvVars clones plainly without touching the cache", async () => {
    const fx = await launchAgainstFixture({ SCARN_GIT_CACHE: "off" });

    expect(await pathExists(fx.mirrorPath)).toBe(false);
    expect(await pathExists(fx.cacheDir)).toBe(false);
  });

  test("host dry runs clone through the shared cache before MCP configuration", async () => {
    const fx = await launchAgainstFixture({}, "host");

    expect(await pathExists(fx.mirrorPath)).toBe(true);
  });

  test("host dry runs honor localEnvVars when disabling the clone cache", async () => {
    const fx = await launchAgainstFixture({ SCARN_GIT_CACHE: "off" }, "host");

    expect(await pathExists(fx.mirrorPath)).toBe(false);
    expect(await pathExists(fx.cacheDir)).toBe(false);
  });

  test("an unknown SCARN_GIT_CACHE value fails construction", () => {
    expect(() =>
      buildDryRunOrchestrator(
        noopLogger,
        { SCARN_GIT_CACHE: "maybe" },
        safeResolver(),
      ),
    ).toThrow(ConfigurationError);
  });

  test("an agentless host launch still clones through the shared cache", async () => {
    const fx = await launchAgainstFixture({}, "host", false);
    expect(await pathExists(fx.mirrorPath)).toBe(true);
  });
});
