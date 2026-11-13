import type { ApiErrorBody } from "./api-types";

/** Every call this package makes returns this shape (mirrors `@scarn/sdk`'s
 * generated `RequestResult`'s non-`throwOnError` branch: `data`/`error` are
 * mutually exclusive, discriminated on which is `undefined`).
 *
 * The narrow read-client types built on it (`RunReadClient`,
 * `WorkItemReadClient`, `TaskLogsClient`) match a real generated
 * `ScarnClient` at runtime but not structurally: `@hey-api/openapi-ts`
 * encodes every nullable field as `T | unknown`, which collapses to plain
 * `unknown` (see `./api-types.ts`). Callers passing a real client therefore
 * cast once with `as unknown as <Client>`. */
export type ApiResult<TData> =
  { data: TData; error: undefined } | { data: undefined; error: ApiErrorBody };

export type AuthHeaders = { Authorization: string };
