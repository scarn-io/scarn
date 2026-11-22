/**
 * A route `transform` hook that keeps every value of the given repeated query
 * keys (`status=a&status=b` → `["a", "b"]`).
 *
 * Elysia 2 marks a query key as repeatable only from a TypeBox schema's shape;
 * for a Zod (Standard Schema) query it keeps the last value alone. Run this
 * before validation on routes whose Zod query schema accepts one or many.
 */
export const keepRepeatedQueryKeys =
  (...keys: readonly string[]) =>
  ({ request, query }: { request: Request; query: unknown }): void => {
    const searchParams = new URL(request.url).searchParams;
    const target = query as Record<string, unknown>;
    for (const key of keys) {
      const values = searchParams.getAll(key);
      if (values.length > 1) {
        target[key] = values;
      }
    }
  };
