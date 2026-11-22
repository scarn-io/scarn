export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const Result = {
  ok<T>(value: T): Ok<T> {
    return { ok: true, value };
  },
  err<E>(error: E): Err<E> {
    return { ok: false, error };
  },
  /** Throw the error if ok === false. Use at API route boundaries to re-enter the existing onError handler. */
  unwrap<T, E extends Error>(result: Result<T, E>): T {
    if (result.ok) return result.value;
    throw result.error;
  },
} as const;
