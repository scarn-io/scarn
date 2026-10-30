/** "Did you mean" helpers for validator hints. */
function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(
        above + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
}

export function closest(
  target: string,
  candidates: Iterable<string>,
): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(
      target.toLowerCase(),
      candidate.toLowerCase(),
    );
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = Math.max(2, Math.floor(target.length / 3));
  return bestDistance <= limit ? best : undefined;
}

export function quoteList(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}
