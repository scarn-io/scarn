/** Compiles an automation's step target and its args. */
import type { ArgValue } from "../contracts/pipeline-document";
import { argEntries, compileArg } from "../pipelines/compile-args";
import {
  attempt,
  type CompileState,
  type Segment,
} from "../pipelines/compile-state";
import type { TargetData } from "../pipelines/model";
import { withOwners } from "../pipelines/refs";
import type { AutomationTargetData } from "./targets";

function compileArgs(
  state: CompileState,
  target: TargetData,
  pointer: readonly Segment[],
  owners: readonly object[],
): Record<string, ArgValue> | undefined {
  if (target.args === undefined) {
    return undefined;
  }
  const out: Record<string, ArgValue> = {};
  for (const [name, value] of argEntries(target.args)) {
    const compiled = attempt(state, [...pointer, name], target.site, () =>
      withOwners(owners, () => compileArg(name, value)),
    );
    if (compiled !== undefined) {
      out[name] = compiled;
    }
  }
  return out;
}

/** A step target's document fields: `kind`, `to` and `args`. */
export function compileStep(
  state: CompileState,
  target: Extract<AutomationTargetData, { kind: "step" }>,
  context: object,
  pointer: readonly Segment[],
): Record<string, unknown> {
  const args = compileArgs(
    state,
    target.target,
    [...pointer, "args"],
    [context],
  );
  const step =
    target.target.node.kind === "step" ? target.target.node.step : "";
  return { kind: "step", to: step, ...(args === undefined ? {} : { args }) };
}
