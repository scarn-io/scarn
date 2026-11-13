import yargs from "yargs/yargs";
import type { CommandModule } from "yargs";
import type { ActionIo } from "../src/lib/action-support";

/**
 * Shared plumbing for the action-verb tests: a recording confirmation gate,
 * in-memory `--body` sources, and an in-process yargs run that captures
 * stdout and rethrows the handler's error.
 */

export const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });

export const fail = (status: number, detail: string) =>
  Promise.resolve({
    data: undefined,
    error: { status, title: "Error", detail },
  });

/** Read dependencies for the noun's read verbs, which these tests never call. */
export const unusedReads = {
  connect: () => Promise.reject(new Error("read verbs are not under test")),
  connectProject: () =>
    Promise.reject(new Error("read verbs are not under test")),
  resolveRef: () => Promise.reject(new Error("read verbs are not under test")),
};

export type FakeIo = ActionIo & { asked: string[] };

export function fakeIo(
  options: {
    answer?: boolean;
    files?: Record<string, string>;
    stdin?: string;
  } = {},
): FakeIo {
  const asked: string[] = [];
  return {
    asked,
    confirm: (message, yes) => {
      asked.push(message);
      return Promise.resolve(yes || (options.answer ?? false));
    },
    body: {
      readFile: (path) => {
        const content = options.files?.[path];
        return content === undefined
          ? Promise.reject(new Error(`ENOENT: ${path}`))
          : Promise.resolve(content);
      },
      readStdin: () => Promise.resolve(options.stdin ?? ""),
    },
  };
}

export async function runAction(
  command: CommandModule<object, object>,
  args: readonly string[],
): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await yargs([...args])
      .command(command)
      .strict()
      .exitProcess(false)
      .showHelpOnFail(false)
      .fail((message, error) => {
        throw error instanceof Error ? error : new Error(message);
      })
      .parseAsync();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}
