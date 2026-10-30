/**
 * The types of references. A `Placeholder<T>` stands for a value of type `T`
 * that exists only when the pipeline runs: reading `.x` on it gives the
 * placeholder for `T["x"]`, and passing it as an arg or to a condition helper
 * records its reference string. The brands below exist only in the types.
 */

export declare const refType: unique symbol;
export declare const untypedBrand: unique symbol;

/** A reference to a run-time value of type `T`. */
export interface Ref<out T> {
  readonly [refType]: T;
}

/**
 * A reference whose type isn't known (a `stepRef` without type arguments, a
 * work-item field, a wait without an input schema). Any field can be read,
 * and it fits any arg; the build checks it against the catalog.
 */
export interface UntypedPlaceholder extends Ref<never> {
  readonly [untypedBrand]: true;
  readonly [key: string]: UntypedPlaceholder;
}

/** A JSON value written in TypeScript, which may not contain references. */
export type JsonLiteral =
  | string
  | number
  | boolean
  | null
  | readonly JsonLiteral[]
  | { readonly [key: string]: JsonLiteral; readonly [untypedBrand]?: never };

/** A plain JSON value of type `T`; references inside it are a type error. */
export type Literal<T> = unknown extends T
  ? JsonLiteral
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends readonly (infer E)[]
      ? readonly Literal<E>[]
      : { readonly [K in keyof T]: Literal<T[K]> };

type Fields<T> = [NonNullable<T>] extends [string]
  ? { readonly length: Placeholder<number> }
  : [NonNullable<T>] extends [readonly unknown[]]
    ? { readonly length: Placeholder<number> }
    : [NonNullable<T>] extends [object]
      ? {
          readonly [K in keyof NonNullable<T>]-?: Placeholder<
            Exclude<NonNullable<T>[K], undefined>
          >;
        }
      : unknown;

/** A reference to a `T`, plus a placeholder for each of its fields. */
export type Placeholder<T> = [T] extends [never]
  ? UntypedPlaceholder
  : unknown extends T
    ? UntypedPlaceholder
    : Ref<T> & Fields<T>;

/** An array arg built element by element: each a reference or a JSON literal. */
export type ListOf<T> = T extends readonly (infer E)[]
  ? readonly (Ref<E> | Literal<E>)[]
  : never;

/** One arg: a reference of a compatible type, a JSON literal, or a list of either. */
export type Arg<T> = Ref<T> | Literal<T> | ListOf<T>;

/** The args a step with input `I` is called with. */
export type Args<I> = { [K in keyof I]: Arg<Exclude<I[K], undefined>> };

/** The error a `catch` handles. */
export interface ErrorValue {
  name: string;
  message: string;
  cause?: unknown;
}
