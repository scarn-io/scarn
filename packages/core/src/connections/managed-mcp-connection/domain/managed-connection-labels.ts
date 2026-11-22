const conjunction = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});

/**
 * The distinct connection labels, in first-seen order, joined for a
 * sentence ("Acme docs", "Acme docs and Wiki"); null when there are none.
 */
export const joinConnectionLabels = (
  labels: readonly (string | null | undefined)[],
): { text: string; count: number } | null => {
  const distinct = [
    ...new Set(
      labels.filter(
        (label): label is string => typeof label === "string" && label !== "",
      ),
    ),
  ];
  return distinct.length === 0
    ? null
    : { text: conjunction.format(distinct), count: distinct.length };
};
