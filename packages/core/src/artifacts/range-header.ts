/**
 * Parses an HTTP `Range` request header against an object of `totalSize`
 * bytes (RFC 9110 §14.1.2), single ranges only.
 *
 * - `{ start, end }` (inclusive, clamped to the object): serve a 206.
 * - `"unsatisfiable"`: serve a 416 with `Content-Range: bytes *\/<total>`.
 * - `null`: ignore the header and serve the whole object as a 200; this
 *   covers no header, a unit other than `bytes`, malformed values, and
 *   multi-range requests (which we do not support).
 */
export const parseRangeHeader = (
  header: string | null | undefined,
  totalSize: number,
): { start: number; end: number } | "unsatisfiable" | null => {
  const match = header
    ? /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
    : null;
  if (!match) {
    return null;
  }
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") {
    return null;
  }

  if (first === "") {
    const suffixLength = Number(last);
    if (suffixLength === 0 || totalSize === 0) {
      return "unsatisfiable";
    }
    return {
      start: Math.max(0, totalSize - suffixLength),
      end: totalSize - 1,
    };
  }

  const start = Number(first);
  if (last !== "" && Number(last) < start) {
    return null;
  }
  if (start >= totalSize) {
    return "unsatisfiable";
  }
  const end = last === "" ? totalSize - 1 : Number(last);
  return { start, end: Math.min(end, totalSize - 1) };
};
