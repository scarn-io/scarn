import type { StepDefinitionSpec } from "../definitions/steps";
import type { ManagedConnectionName } from "../managed-connections";

type PushedMcpServerBase = {
  /** The step's key. */
  step: string;
  /** The server's key in the step's MCP config. */
  key: string;
  /** The managed connection named by `auth`, or null when it has none. */
  connection: ManagedConnectionName | null;
};

/**
 * An enabled `ref` or `remote` MCP server of a pushed step, for
 * `scarn pipelines push` to check against the project's connections. A
 * remote carries its URL. A ref carries the name it is looked up by in the
 * repository's MCP files, which the push script doesn't read; the CLI does.
 */
export type PushedMcpServer =
  | (PushedMcpServerBase & { type: "remote"; url: string })
  | (PushedMcpServerBase & {
      type: "ref";
      name: string;
      /** The ref's own `disabled`, which overrides the repository's. */
      disabled?: boolean;
    });

/** Every enabled `ref` or `remote` MCP server of `steps`, in step order. */
export function pushedMcpServers(
  steps: readonly StepDefinitionSpec[],
): PushedMcpServer[] {
  return steps.flatMap((step) =>
    Object.entries(step.opencodeMcpJson ?? {}).flatMap(
      ([key, entry]): PushedMcpServer[] => {
        if (entry.type === "local" || entry.disabled === true) return [];
        const base = {
          step: step.key,
          key,
          connection: entry.auth?.connection ?? null,
        };
        if (entry.type === "remote") {
          return [{ ...base, type: "remote", url: entry.url }];
        }
        return [
          {
            ...base,
            type: "ref",
            name: entry.name ?? key,
            ...(entry.disabled === undefined
              ? {}
              : { disabled: entry.disabled }),
          },
        ];
      },
    ),
  );
}
