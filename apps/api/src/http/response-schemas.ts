import type { z } from "zod";

type OutputTypedSchema<Schema> = Schema extends z.ZodType
  ? Omit<Schema, "~standard"> & {
      readonly "~standard": Omit<Schema["~standard"], "types"> & {
        readonly types?: {
          readonly input: z.output<Schema>;
          readonly output: z.output<Schema>;
        };
      };
    }
  : never;

/**
 * Types a route's `response` map by each schema's output.
 *
 * Elysia 2 types Standard Schema responses (handler return values and Eden
 * response data) by the schema's input side. Zod applies type-predicate
 * refinements such as `uuidV7Schema`'s `UuidV7` brand to the output only, so
 * an untyped map would hand Eden callers plain `string` ids. Responses are the
 * serialized form of domain values that already satisfy the output, so typing
 * both sides by the output is sound. Identity at runtime.
 */
export const responseSchemas = <
  const Responses extends Record<number, z.ZodType>,
>(
  responses: Responses,
): {
  [
    Status in keyof Responses as Status extends `${infer Code extends number}`
      ? Code
      : Status
  ]: OutputTypedSchema<Responses[Status]>;
} => responses as never;
