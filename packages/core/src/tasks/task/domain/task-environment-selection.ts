/**
 * A Task's environment selection (decision 1): the extra catalog connectors
 * it adds on top of its environment's. An environment override is not part
 * of it; it lives in the Task's derived execution config (decision 3).
 */

/** A catalog connector one Task adds, with a project secret for each var it needs. */
export type ExtraConnector = {
  connectorId: string;
  vars: Record<string, { secret: string }>;
};

export type TaskEnvironmentSelection = {
  extraConnectors: ExtraConnector[];
};

/** `null` when the Task adds no connectors. */
export const taskEnvironmentSelection = (
  extraConnectors: readonly ExtraConnector[],
): TaskEnvironmentSelection | null =>
  extraConnectors.length === 0
    ? null
    : {
        extraConnectors: extraConnectors.map((extra) => ({
          connectorId: extra.connectorId,
          vars: Object.fromEntries(
            Object.entries(extra.vars).map(([name, { secret }]) => [
              name,
              { secret },
            ]),
          ),
        })),
      };
