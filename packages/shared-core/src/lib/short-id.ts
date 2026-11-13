/**
 * Shortens an opaque id (e.g. `019ed1b9-c02d-7170-a08a-1ff912085f7b`) to
 * `019ed1b9…5f7b` so a listing line stays readable; the full id is printed
 * alongside wherever an agent needs to copy it.
 */
export function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
