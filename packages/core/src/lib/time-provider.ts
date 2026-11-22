export type TimeProvider = {
  now(): Date;
  nowIso(): string;
};

export const systemTimeProvider: TimeProvider = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};
