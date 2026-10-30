// Offline validation of a batch of step definitions.
//
// These are the mistakes the type system cannot catch — either because the
// definition file was written in JS, generated, or hand-edited, or because the
// fact being checked spans two steps (an artifact marker naming another
// step's result). Everything here is pure: no network, no token, no server.
// `pushFromDirectory` runs it before it mutates anything.

import type { StepDefinitionSpec } from "../steps/define-step";
import { checkArtifactFields } from "./validate-artifacts";
import { checkArtifactMarkers } from "./validate-artifact-markers";
import { checkEnv } from "./validate-env";
import { checkRepo } from "./validate-repo";
import { checkRuntime } from "./validate-runtime";
import { listPaths, type DefinitionValidationIssue } from "./validation-issue";

// ─── Health checks reference declared, single-qualified MCP tools ───

function checkHealthChecks(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    const checks = step.healthChecksJson ?? [];
    if (checks.length === 0) continue;

    const mcpServerKeys = Object.keys(step.opencodeMcpJson ?? {});
    const mcpServerKeySet = new Set(mcpServerKeys);

    checks.forEach((check, index) => {
      // A cli check has no `tool`/`mcp` to validate against — Zod already
      // enforces a non-empty `command` at the schema layer for real
      // pushes, so there is nothing left for this check to do. Its label
      // (were it needed for a future message here) would read
      // `check.name ?? check.command.join(" ")`, mirroring the same
      // "joined command stands in for the tool id" convention used by
      // `resolveHealthCheckToolId` (`packages/worker`) and the dry-run
      // reporter, for consistency — though this file has no direct
      // dependency on either.
      if (check.kind === "cli") return;

      const label = check.name ?? check.tool;
      const where = `Step "${step.key}" health check #${String(index + 1)} ("${label}")`;

      if (!check.mcp) return;

      if (!mcpServerKeySet.has(check.mcp)) {
        issues.push({
          check: "health-check-mcp-server",
          severity: "error",
          message:
            `${where} names MCP server "${check.mcp}", but the step declares no ` +
            `such server in mcps. Declared servers: ${mcpServerKeys.length > 0 ? listPaths([...mcpServerKeys].sort()) : "(none)"}.`,
        });
      }

      const prefix = `${check.mcp}_`;
      if (check.tool.startsWith(prefix)) {
        issues.push({
          check: "health-check-double-qualified",
          severity: "error",
          message:
            `${where} sets mcp "${check.mcp}" and tool "${check.tool}", which already ` +
            `starts with "${prefix}". When "mcp" is set, "tool" should be the bare tool ` +
            `name — OpenCode resolves it to "${prefix}${check.tool}". Did you mean ` +
            `tool: "${check.tool.slice(prefix.length)}"?`,
        });
      }
    });
  }

  return issues;
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Runs every offline check over a batch of step definitions and returns the
 * issues found, in check order. An empty array means the batch is clean.
 */
export function validateDefinitionSpecs(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const stepsByKey = new Map<string, StepDefinitionSpec[]>();
  for (const step of steps) {
    const existing = stepsByKey.get(step.key);
    if (existing) existing.push(step);
    else stepsByKey.set(step.key, [step]);
  }

  return [
    ...checkArtifactFields(steps),
    ...checkArtifactMarkers(steps, stepsByKey),
    ...checkHealthChecks(steps),
    ...checkEnv(steps),
    ...checkRuntime(steps),
    ...checkRepo(steps),
  ];
}

/**
 * `validateDefinitionSpecs`, but throws a single aggregated error.
 *
 * Only counts and lists `severity: "error"` issues — `"warning"`-tier issues
 * (an embed marker no platform can embed) never block a push and are dropped
 * here. They're still present in `validateDefinitionSpecs`'s own return value
 * for any caller that wants to surface them.
 */
export function assertValidDefinitionSpecs(
  steps: readonly StepDefinitionSpec[],
): void {
  const issues = validateDefinitionSpecs(steps).filter(
    (issue) => issue.severity === "error",
  );
  if (issues.length === 0) return;

  const header =
    issues.length === 1
      ? "Definition validation failed:"
      : `Definition validation failed with ${String(issues.length)} problems:`;
  throw new Error(
    [header, ...issues.map((issue) => `  • ${issue.message}`)].join("\n"),
  );
}
