/**
 * Placeholders at run time: Proxies that record the reference path they stand
 * for. Reading a field gives a child placeholder. Coercing one (comparison,
 * arithmetic, template string) throws, and every read is recorded so reads
 * that never reach an arg, `over` or a condition can be reported.
 */
import type { JsonSchema } from "../contracts/pipeline-document";
import { AuthoringError } from "./errors";
import { captureSite, type SourceSite } from "./source";

const REF = Symbol("scarn.ref");

/** A work-item field a reference reads, collected into `workItemFields`. */
export interface WorkItemFieldUse {
  alias: string;
  label: string;
}

/** A read of a placeholder field during compilation. */
export interface ReadRecord {
  readonly path: string;
  readonly site: SourceSite | null;
  readonly pointer: string;
  readonly parent: ReadRecord | null;
  used: boolean;
  hasChildren: boolean;
}

export interface RefData {
  /** The reference string, or a path relative to a list element. */
  readonly path: string;
  /** "element" refs live inside `some` / `every` / `none` / `count` / field selectors. */
  readonly scope: "document" | "element";
  /** The JSON Schema of the value, when known. */
  readonly schema: JsonSchema | undefined;
  readonly field: WorkItemFieldUse | undefined;
  readonly record: ReadRecord | null;
  /** The callback context that created it; null for refs valid anywhere. */
  readonly owner: object | null;
  /** The node a `nodes.<id>...` reach-back reads. */
  readonly reach: string | undefined;
}

/** A reach-back used at `pointer`, checked once every node is placed. */
export interface ReachUse {
  node: string;
  pointer: string;
  site: SourceSite | null;
}

/** Collects reads while `definePipeline` runs the authoring callbacks. */
export interface ReadTracker {
  readonly records: ReadRecord[];
  /** Work-item fields used, in order of first use. */
  readonly fields: WorkItemFieldUse[];
  readonly reaches: ReachUse[];
  pointer: string;
}

let active: ReadTracker | null = null;
let currentOwners: readonly object[] = [];

/** Runs `run` with `owners` as the callback contexts whose refs may be used. */
export function withOwners<T>(owners: readonly object[], run: () => T): T {
  const previous = currentOwners;
  currentOwners = owners;
  try {
    return run();
  } finally {
    currentOwners = previous;
  }
}

export function withTracker<T>(tracker: ReadTracker, run: () => T): T {
  const previous = active;
  active = tracker;
  try {
    return run();
  } finally {
    active = previous;
  }
}

/** The current pointer of the active tracker, or "" outside compilation. */
export function setTrackerPointer(pointer: string): void {
  if (active !== null) {
    active.pointer = pointer;
  }
}

const COERCION_HINT =
  "a placeholder stands for a value that only exists when the pipeline runs, so it can't be compared, converted or used in JS logic. Use a condition helper such as equal(...) or greaterThan(...), in a .next(...) route's when to branch";

function coercionError(path: string): never {
  throw new AuthoringError(
    `"${path === "" ? "element" : path}" was coerced to a primitive: ${COERCION_HINT}`,
  );
}

function propertySchema(
  schema: JsonSchema | undefined,
  key: string,
): JsonSchema | undefined {
  if (key === "length") {
    return { type: "integer" };
  }
  if (typeof schema !== "object") {
    return undefined;
  }
  if (/^\d+$/.test(key) && schema.items !== undefined) {
    return schema.items;
  }
  return schema.properties?.[key];
}

/** The property names a spread of this placeholder expands to. */
function spreadKeys(data: RefData): string[] {
  const schema = data.schema;
  if (
    typeof schema !== "object" ||
    schema.properties === undefined ||
    (schema.type !== undefined && schema.type !== "object")
  ) {
    throw new AuthoringError(
      `can't spread "${data.path}": its JSON Schema doesn't declare its properties, so the args it expands to aren't known. Pass each arg explicitly`,
    );
  }
  return Object.keys(schema.properties);
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

export function makePlaceholder(data: RefData): object {
  const children = new Map<string, object>();
  const child = (key: string): object => {
    const cached = children.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = createChild(key);
    children.set(key, created);
    return created;
  };
  // A spread reads every declared property; one the author overrides is
  // dropped, not misused, so spread properties aren't tracked as reads.
  const spreadChild = (key: string): object =>
    makePlaceholder({
      ...data,
      path: joinPath(data.path, key),
      schema: propertySchema(data.schema, key),
      record: data.record,
    });
  const createChild = (key: string): object => {
    const record =
      active === null
        ? null
        : {
            path: joinPath(data.path, key),
            site: captureSite(),
            pointer: active.pointer,
            parent: data.record,
            used: false,
            hasChildren: false,
          };
    if (record !== null) {
      active?.records.push(record);
      if (data.record !== null) {
        data.record.hasChildren = true;
      }
    }
    return makePlaceholder({
      path: joinPath(data.path, key),
      scope: data.scope,
      schema: propertySchema(data.schema, key),
      field: data.field,
      record,
      owner: data.owner,
      reach: data.reach,
    });
  };
  // Object spread calls getOwnPropertyDescriptor and then get for each key.
  let spreading: string | undefined;
  return new Proxy(Object.create(null) as object, {
    get(_target, key) {
      if (typeof key === "string" && key === spreading) {
        spreading = undefined;
        return spreadChild(key);
      }
      if (key === REF) {
        return data;
      }
      if (
        key === Symbol.toPrimitive ||
        key === "valueOf" ||
        key === "toString" ||
        key === "toJSON"
      ) {
        return () => coercionError(data.path);
      }
      if (typeof key === "symbol" || key === "then") {
        return undefined;
      }
      return child(key);
    },
    has(_target, key) {
      return key === REF;
    },
    ownKeys() {
      return spreadKeys(data);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== "string") {
        return undefined;
      }
      spreading = key;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: spreadChild(key),
      };
    },
    set() {
      throw new AuthoringError(`can't assign to "${data.path}"`);
    },
  });
}

/**
 * A root placeholder for a reference such as `result` or `nodes.x.input`.
 * Context objects create one per property read, so reading `r.result` alone
 * is recorded too.
 */
export function rootPlaceholder(
  path: string,
  schema: JsonSchema | undefined,
  options: {
    scope?: "document" | "element";
    field?: WorkItemFieldUse;
    owner?: object | null;
    reach?: string;
  } = {},
): object {
  const record =
    active === null
      ? null
      : {
          path,
          site: captureSite(),
          pointer: active.pointer,
          parent: null,
          used: false,
          hasChildren: false,
        };
  if (record !== null) {
    active?.records.push(record);
  }
  return makePlaceholder({
    path,
    scope: options.scope ?? "document",
    schema,
    field: options.field,
    record,
    owner: options.owner ?? null,
    reach: options.reach,
  });
}

/** The data behind a placeholder, or undefined for any other value. */
// eslint-disable-next-line local/no-unknown-parameter-type -- inspects arbitrary author values
export function refData(value: unknown): RefData | undefined {
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    REF in value
  ) {
    return (value as { [REF]: RefData })[REF];
  }
  return undefined;
}

/** Marks a placeholder as used, so its read isn't reported. */
export function markUsed(data: RefData): void {
  for (let record = data.record; record !== null; record = record.parent) {
    record.used = true;
  }
}

/**
 * Uses a ref in an arg, `over` or a condition: marks it used and checks it
 * belongs to the callback being compiled. `result` means a different value
 * in every node's callback, so a ref from another callback would compile to
 * the wrong reference.
 */
export function useRef(data: RefData): string {
  markUsed(data);
  if (data.field !== undefined) {
    active?.fields.push(data.field);
  }
  if (data.reach !== undefined && active !== null) {
    active.reaches.push({
      node: data.reach,
      pointer: active.pointer,
      site: data.record?.site ?? null,
    });
  }
  if (data.owner !== null && !currentOwners.includes(data.owner)) {
    throw new AuthoringError(
      `"${data.path}" comes from another callback's r: "result", "input" and "error" mean this node's own values in each callback. Use r.node(handle) to reach back to another node`,
      data.record?.site ?? null,
    );
  }
  return data.path;
}

/** Reads of leaf paths that never reached an arg, `over` or a condition. */
export function unusedReads(tracker: ReadTracker): ReadRecord[] {
  return tracker.records.filter(
    (record) => !record.used && !record.hasChildren,
  );
}
