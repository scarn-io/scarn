import * as clack from "@clack/prompts";
import type { Argv } from "yargs";
import { CliError } from "./cli-error";

/**
 * The gate in front of every mutating action (cancel, rerun, …): `--yes`
 * skips it, a TTY gets a yes/no prompt, and anything else fails with
 * `confirmation_required` instead of hanging on a prompt nobody can answer.
 */

export interface ConfirmActionInput {
  /** The question shown on the prompt, e.g. `Cancel execution <id>?`. */
  message: string;
  /** The command's `--yes` flag. */
  yes: boolean;
  /** Defaults to whether both stdin and stdout are TTYs. */
  isTty?: boolean;
  /** Defaults to a `clack.confirm` prompt; resolves `false` on cancel. */
  prompt?: (message: string) => Promise<boolean>;
}

export const withConfirmOption = <T>(argv: Argv<T>) =>
  argv.option("yes", {
    alias: "y",
    type: "boolean",
    default: false,
    describe: "Skip the confirmation prompt (required when not on a TTY)",
  });

async function clackPrompt(message: string): Promise<boolean> {
  const answer = await clack.confirm({ message, initialValue: false });
  return clack.isCancel(answer) ? false : answer;
}

/** `true` to proceed, `false` when the user declined at the prompt. */
export async function confirmAction(
  input: ConfirmActionInput,
): Promise<boolean> {
  if (input.yes) return true;
  const isTty = input.isTty ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!isTty) {
    throw new CliError(
      "confirmation_required",
      `${input.message} Not on a TTY, so pass --yes to confirm.`,
    );
  }
  return (input.prompt ?? clackPrompt)(input.message);
}
