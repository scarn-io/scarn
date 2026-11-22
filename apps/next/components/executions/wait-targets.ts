import { z } from "zod";

const routeSchema = z.object({ to: z.string(), when: z.unknown().optional() });

const waitNodeSchema = z.object({
  kind: z.literal("wait"),
  title: z.string().optional(),
  next: z
    .object({
      routes: z.array(routeSchema),
      otherwise: z.object({ to: z.string() }).optional(),
    })
    .optional(),
});

const actionConditionSchema = z.object({
  path: z.literal("result.action"),
  op: z.literal("equal"),
  value: z.string(),
});

/** What the pinned document says about a wait node. */
export type WaitNodeInfo = {
  title: string | null;
  /**
   * The node the run goes to next: after `action` for a decision, or after a
   * reply. `null` when a route depends on something the page can't know.
   */
  targetOf: (action?: string) => string | null;
};

const unknownNode: WaitNodeInfo = { title: null, targetOf: () => null };

function readWaitNode(
  definition: Record<string, unknown> | null,
  nodeId: string,
): z.infer<typeof waitNodeSchema> | null {
  const nodes = definition?.["nodes"];
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return null;
  const parsed = waitNodeSchema.safeParse(
    (nodes as Record<string, unknown>)[nodeId],
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Reads wait node `nodeId` from a pinned pipeline document. Routes are taken
 * in order: one with no `when` always matches, one on `result.action` matches
 * its action, and any other condition makes the target unknown.
 */
export function waitNodeInfo(
  definition: Record<string, unknown> | null,
  nodeId: string,
): WaitNodeInfo {
  const node = readWaitNode(definition, nodeId);
  if (!node) return unknownNode;
  return {
    title: node.title ?? null,
    targetOf: (action) => {
      for (const route of node.next?.routes ?? []) {
        if (route.when === undefined) return route.to;
        const condition = actionConditionSchema.safeParse(route.when);
        if (!condition.success || action === undefined) return null;
        if (condition.data.value === action) return route.to;
      }
      return node.next?.otherwise?.to ?? null;
    },
  };
}
