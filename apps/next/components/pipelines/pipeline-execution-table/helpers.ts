export const formatTimestamp = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "-";
