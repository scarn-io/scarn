import z from "zod";

export type AnyJsonPrimitive = string | number | boolean | null;
export type AnyJsonValue = AnyJsonPrimitive | AnyJsonObject | AnyJsonArray;
export interface AnyJsonObject {
  [key: string]: AnyJsonValue;
}
export type AnyJsonArray = AnyJsonValue[];

export const anyJsonValueSchema: z.ZodType<AnyJsonValue> = z.json();

export const anyJsonObjectSchema: z.ZodType<AnyJsonObject> = z.record(
  z.string(),
  anyJsonValueSchema,
);
