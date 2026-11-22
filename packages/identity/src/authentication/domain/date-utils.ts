export const normalizeDate = (
  value: Date | string | null | undefined,
): Date | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }

  return parsed;
};
