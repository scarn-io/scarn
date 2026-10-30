/**
 * Compiles args: each ref becomes its reference string, and each plain JSON
 * value becomes `{ "value": ... }`. An array with a ref among its elements
 * becomes `{ "list": [...] }`, one reference or literal per element. A ref
 * nested deeper in a literal is an error.
 */
import type { ArgValue, JsonValue } from "../contracts/pipeline-document";
import { AuthoringError } from "./errors";
import type { RawArgs } from "./model";
import { refData, useRef, type RefData } from "./refs";

// eslint-disable-next-line local/no-unknown-parameter-type -- walks author values
function literal(value: unknown, path: string): JsonValue {
  if (refData(value) !== undefined) {
    throw new AuthoringError(
      `"${path}" is a literal containing a reference; an arg is either a reference or a plain JSON value. Pass the reference as its own arg, or a reference to the whole object`,
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AuthoringError(
        `"${path}" is ${String(value)}, which isn't JSON`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      literal(item, `${path}.${String(index)}`),
    );
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        out[key] = literal(item, `${path}.${key}`);
      }
    }
    return out;
  }
  throw new AuthoringError(
    `"${path}" is a ${typeof value}, which isn't a JSON value`,
  );
}

function refArg(name: string, data: RefData): string {
  if (data.scope === "element") {
    throw new AuthoringError(
      `"${name}" is a list element from some / every / none / count; those exist only inside the condition`,
      data.record?.site ?? null,
    );
  }
  return useRef(data);
}

/** One compiled arg. Throws `AuthoringError`. */
export function compileArg(name: string, value: RawArgs[string]): ArgValue {
  const data = refData(value);
  if (data !== undefined) {
    return refArg(name, data);
  }
  if (
    Array.isArray(value) &&
    value.some((item) => refData(item) !== undefined)
  ) {
    return {
      list: value.map(
        (item: object | string | number | boolean | null, index) => {
          const path = `${name}.${String(index)}`;
          const element = refData(item);
          return element === undefined
            ? { value: literal(item, path) }
            : refArg(path, element);
        },
      ),
    };
  }
  return { value: literal(value, name) };
}

/** The args in order, without undefined values; Proxy spreads expand here. */
export function argEntries(args: RawArgs): [string, RawArgs[string]][] {
  return Object.entries(args).filter(([, value]) => value !== undefined);
}
