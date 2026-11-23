/**
 * The health check runner (#119): given a launched environment and a step's
 * declared health checks (`defineStep`'s `healthChecks` field), produces an
 * outcome for each one.
 *
 * Replaced the dry-run canary orchestration's registry-lookup model
 * (the now-deleted `mcpCanaryRegistry`/`matchMcpCanary`, #121) with declared
 * checks: there is no matching, no ambiguity, and no hardcoded server list
 * here. The forced-call invoker underneath
 * (`forceAndVerifyMcpHealthCheck`) needed no generalisation — it already
 * accepts a caller-supplied `{ tool, args }`.
 *
 * Tool enumeration goes through the Scarn plugin's `scarn.listTools` RPC
 * (`@scarn/opencode-plugin`'s `scarn-rpc.ts`): v2 has no server route
 * listing registered tools. MCP tools are deliberately not treated as
 * enumerable (the #114 spike found v1 never listed them, and the RPC reports
 * what the plugin context sees, not each MCP server's live catalogue). So
 * id-resolution fast-failing and pre-call
 * Ajv argument validation only apply to checks with no `mcp` qualifier — an
 * `mcp`-qualified check skips both and goes straight to the forced call,
 * letting a genuinely missing or broken MCP tool fail there instead (exactly
 * `forceAndVerifyMcpHealthCheck`'s existing `tool-error` path). Treating an
 * MCP tool's absence from the enumeration as `not-registered` would produce a
 * false positive against every correctly configured MCP health check.
 */
import Ajv from "ajv/dist/2020";
import {
  SCARN_LIST_TOOLS_METHOD,
  SCARN_RPC_ID,
  type ScarnListToolsOutput,
} from "@scarn/opencode-plugin";
import type {
  HealthCheck,
  HealthCheckSeverity,
} from "@scarn/sdk/health-checks";
import type { FakeAiServer } from "../infra/fake-ai/fake-ai-server";
import {
  createScarnOpencodeClient,
  opencodeLocation,
  type ScarnOpencodeClient,
} from "../infra/opencode-client";
import { forceAndVerifyCliHealthCheck } from "./force-and-verify-cli-health-check";
import { forceAndVerifyMcpHealthCheck } from "./force-and-verify-mcp-health-check";
import { scheduleHealthChecks } from "./health-check-scheduling";
import { logWorkError } from "./work-logger";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";

/**
 * Resolve a declared health check to the id shown in reports: `${mcp}_${tool}`
 * when a `"tool"` check's `mcp` is set, matching OpenCode's MCP tool-naming
 * convention; `tool` verbatim otherwise — plugin tools, standalone tools, and
 * built-ins already share one flat namespace, so no qualifier applies. A
 * `"cli"` check has no OpenCode-side tool id to resolve to (it always runs
 * through the fixed `shell` built-in — see `force-and-verify-cli-health-check.ts`),
 * so its declared `command`, joined with spaces, stands in for reporting
 * purposes instead.
 */
export function resolveHealthCheckToolId(check: HealthCheck): string {
  if (check.kind === "cli") {
    return check.command.join(" ");
  }
  return check.mcp ? `${check.mcp}_${check.tool}` : check.tool;
}

export type HealthCheckOutcome =
  | { kind: "passed" }
  | {
      kind: "failed";
      reason:
        | "not-registered"
        | "invalid-args"
        | "tool-error"
        | "timeout"
        | "session-error"
        | "nonzero-exit"
        /** A direct MCP check (no agent) whose server couldn't be reached or lacks the tool. */
        | "unavailable";
      detail: string;
      /** Only set for `not-registered`: every id OpenCode does know about. */
      availableIds?: string[];
    }
  /**
   * Never attempted: by default an earlier required check aborted the run.
   * Dry runs explicitly mark managed auth tool checks `real-runs-only`;
   * that skip is advisory, independent of the server's startup gate.
   */
  | { kind: "skipped"; reason?: "real-runs-only" };

export type HealthCheckReport = {
  /** `check.name`, defaulting to the resolved tool id. */
  name: string;
  resolvedId: string;
  severity: HealthCheckSeverity;
  /** The declared check's `kind` — carried through so reporting (`apps/cli`'s dry-run output) can render `"tool"` and `"cli"` checks differently. */
  kind: HealthCheck["kind"];
  outcome: HealthCheckOutcome;
};

export type RunHealthChecksInput = {
  server: OpencodeServerHandle;
  /**
   * In declaration order. `required` checks run before `warn` ones
   * regardless of how the two severities are interleaved in this array — see
   * {@link runHealthChecks}.
   */
  healthChecks: HealthCheck[];
  /** Already started; shared across every check this call runs. */
  fakeAiServer: FakeAiServer;
  /** Interval for polling each forced call's result. Defaults to 500ms. */
  healthCheckPollIntervalMs?: number | undefined;
};

type CheckContext = {
  enumeration: ToolEnumeration;
  server: OpencodeServerHandle;
  fakeAiServer: FakeAiServer;
  pollIntervalMs: number | undefined;
};

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lazily fetches and caches the plugin's tool enumeration — ids plus each
 * tool's input JSON Schema (`null` when the tool was not declared with a plain
 * JSON Schema). `mcp`-qualified checks never trigger the fetch (see file
 * comment), so a step whose declared checks are all MCP calls never queries
 * it at all.
 */
class ToolEnumeration {
  private toolsPromise: Promise<Map<string, unknown>> | undefined;

  constructor(
    private readonly client: ScarnOpencodeClient,
    private readonly server: OpencodeServerHandle,
  ) {}

  async ids(): Promise<Set<string>> {
    return new Set((await this.tools()).keys());
  }

  async schemaFor(toolId: string): Promise<unknown> {
    return (await this.tools()).get(toolId);
  }

  private tools(): Promise<Map<string, unknown>> {
    this.toolsPromise ??= this.fetchTools();
    return this.toolsPromise;
  }

  private async fetchTools(): Promise<Map<string, unknown>> {
    try {
      const response = await this.client.rpc.call({
        rpcID: SCARN_RPC_ID,
        method: SCARN_LIST_TOOLS_METHOD,
        location: opencodeLocation(this.server),
        input: {},
      });
      const output = response.output as ScarnListToolsOutput | undefined;
      return new Map(
        (output?.tools ?? []).map((tool) => [tool.id, tool.inputSchema]),
      );
    } catch (error) {
      logWorkError("health-check", "Failed to enumerate registered tools", {
        agentBaseUrl: this.server.baseUrl,
        error: errorMessage(error),
      });
      return new Map();
    }
  }
}

type ArgsValidation =
  | { kind: "valid" }
  | { kind: "invalid"; detail: string }
  /** The schema itself failed to compile; validation is skipped, not failed. */
  | { kind: "unavailable" };

/**
 * Validates `args` against `schema` with Ajv, formatting errors as instance
 * path plus message — the same idiom `scarn-submit-step-findings` (plugin)
 * and `process-project-work-findings.ts` (worker) already use for authoring
 * errors.
 *
 * A schema that fails to *compile* — e.g. the recursive `$ref`-vs-`$defs`
 * mismatch the #114 spike found on at least one real plugin tool's generated
 * schema — is reported as `"unavailable"`, not `"invalid"`: the schema itself
 * is broken, not the caller's arguments, so this is not an authoring error.
 */
function validateArgs(
  schema: object,
  args: Record<string, unknown>,
): ArgsValidation {
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch {
    return { kind: "unavailable" };
  }

  if (validate(args)) {
    return { kind: "valid" };
  }

  const details = (validate.errors ?? [])
    .map(
      (issue) => `${issue.instancePath || "/"} ${issue.message ?? "invalid"}`,
    )
    .join("; ");
  return { kind: "invalid", detail: details || "validation failed" };
}

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a dynamically fetched value, not a real input boundary
function isSchemaObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * `"tool"`-kind checks fast-fail against OpenCode's tool enumeration and
 * validate `args` against the tool's own schema before ever forcing a call —
 * see the file comment for why an `mcp`-qualified check skips both. `"cli"`
 * checks have nothing to enumerate or validate against: the `shell` tool is a
 * fixed OpenCode built-in (decision ledger #3 in the plan — no new
 * exec-in-container primitive), so there is no id to resolve and no
 * per-command argument schema to check `command`/`expectExitCode` against.
 * They go straight to `forceAndVerifyCliHealthCheck`.
 */
async function runOneCheck(
  input: CheckContext & { check: HealthCheck; resolvedId: string },
): Promise<HealthCheckOutcome> {
  const { check, resolvedId, enumeration, server, fakeAiServer } = input;
  const { pollIntervalMs } = input;

  switch (check.kind) {
    case "cli": {
      const verification = await forceAndVerifyCliHealthCheck({
        server,
        command: check.command,
        expectExitCode: check.expectExitCode,
        fakeAiServer,
        timeoutMs: check.timeoutSeconds * 1000,
        pollIntervalMs,
      });

      return verification.passed
        ? { kind: "passed" }
        : {
            kind: "failed",
            reason: verification.reason,
            detail: verification.detail,
          };
    }
    case "tool": {
      const args = check.args ?? {};

      if (!check.mcp) {
        const registeredIds = await enumeration.ids();
        if (!registeredIds.has(resolvedId)) {
          return {
            kind: "failed",
            reason: "not-registered",
            detail: `Tool "${resolvedId}" is not registered in this environment.`,
            availableIds: [...registeredIds].sort(),
          };
        }

        const schema = await enumeration.schemaFor(resolvedId);
        if (isSchemaObject(schema)) {
          const validation = validateArgs(schema, args);
          if (validation.kind === "invalid") {
            return {
              kind: "failed",
              reason: "invalid-args",
              detail: validation.detail,
            };
          }
        }
      }

      const verification = await forceAndVerifyMcpHealthCheck({
        server,
        healthCheck: { tool: resolvedId, args },
        fakeAiServer,
        timeoutMs: check.timeoutSeconds * 1000,
        pollIntervalMs,
      });

      return verification.passed
        ? { kind: "passed" }
        : {
            kind: "failed",
            reason: verification.reason,
            detail: verification.detail + doubleQualifiedHint(check),
          };
    }
  }
}

/**
 * A failed `mcp`-qualified check whose `tool` already starts with
 * `${mcp}_` may have been double-qualified by its author. This can't be
 * decided offline — some servers' own tool names legitimately start with
 * the server key (Microsoft's PostgreSQL MCP exposes `postgres_mcp_connect`
 * under a server registered as `postgres`) — so the suggestion is only
 * offered once the call has actually failed.
 */
function doubleQualifiedHint(
  check: Extract<HealthCheck, { kind: "tool" }>,
): string {
  if (!check.mcp) return "";
  const prefix = `${check.mcp}_`;
  if (!check.tool.startsWith(prefix)) return "";
  return (
    ` Hint: with mcp "${check.mcp}", tool "${check.tool}" was called as ` +
    `"${prefix}${check.tool}". If "${prefix}" was meant as the server prefix, ` +
    `set tool: "${check.tool.slice(prefix.length)}".`
  );
}

/** Narrows {@link HealthCheckOutcome} to just the `failed` variant. */
export type FailedHealthCheckOutcome = Extract<
  HealthCheckOutcome,
  { kind: "failed" }
>;

/**
 * Finds the first `required` check whose outcome is `failed`, in report
 * order (which matches declaration order).
 * Used by a real task run (#120) to decide whether to kill the step
 * before the agent is prompted; `warn` failures are advisory and never
 * matched here.
 */
export function findFailedRequiredHealthCheck(
  reports: HealthCheckReport[],
):
  { report: HealthCheckReport; outcome: FailedHealthCheckOutcome } | undefined {
  for (const report of reports) {
    if (report.severity === "required" && report.outcome.kind === "failed") {
      return { report, outcome: report.outcome };
    }
  }
  return undefined;
}

/**
 * Renders a failed health check as a human-readable message for the step
 * failure it produces — the only diagnostic a user gets if they don't dig
 * into the log feed for the forced call's tool output.
 */
export function describeFailedHealthCheck(
  report: HealthCheckReport,
  outcome: FailedHealthCheckOutcome,
): string {
  const availableIdsSuffix =
    outcome.availableIds && outcome.availableIds.length > 0
      ? ` Available tool ids: ${outcome.availableIds.join(", ")}.`
      : "";
  return `Health check "${report.name}" (${report.resolvedId}) failed [${outcome.reason}]: ${outcome.detail}${availableIdsSuffix}`;
}

export function buildReport(
  check: HealthCheck,
  resolvedId: string,
  outcome: HealthCheckOutcome,
): HealthCheckReport {
  return {
    name: check.name ?? resolvedId,
    resolvedId,
    severity: check.severity,
    kind: check.kind,
    outcome,
  };
}

/**
 * Runs a step's declared health checks against a launched environment and
 * reports an outcome for each one, returned in the same order as
 * `input.healthChecks`.
 *
 * Scheduling (`required` before `warn`, parallel lanes, `serialGroup`, the
 * best-effort abort on a `required` failure) lives in
 * `health-check-scheduling.ts`, shared with the direct runner a code step uses.
 */
export async function runHealthChecks(
  input: RunHealthChecksInput,
): Promise<HealthCheckReport[]> {
  const { server, healthChecks, fakeAiServer } = input;

  if (healthChecks.length === 0) {
    return [];
  }

  const enumeration = new ToolEnumeration(
    createScarnOpencodeClient(server),
    server,
  );

  const context: CheckContext = {
    enumeration,
    server,
    fakeAiServer,
    pollIntervalMs: input.healthCheckPollIntervalMs,
  };

  const results = await scheduleHealthChecks(healthChecks, (check) =>
    runOneCheck({
      check,
      resolvedId: resolveHealthCheckToolId(check),
      ...context,
    }),
  );
  return results.map(({ check, outcome }) =>
    buildReport(check, resolveHealthCheckToolId(check), outcome),
  );
}
