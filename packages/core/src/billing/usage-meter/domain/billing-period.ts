/**
 * Calendar-month billing period helper. Usage quotas reset on the first of each
 * calendar month, evaluated in UTC so the reset boundary is deterministic and
 * independent of server/client timezone.
 */

/**
 * Returns the billing period for `now` formatted as "YYYY-MM" in UTC.
 *
 * Pure: depends only on its argument and performs no IO.
 */
export const currentBillingPeriod = (now: Date): string => {
  const year = now.getUTCFullYear().toString().padStart(4, "0");
  const month = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${year}-${month}`;
};

/**
 * Returns the UTC instant at which the given `period` ("YYYY-MM") resets, i.e.
 * midnight on the first day of the following calendar month. This is the moment
 * usage quotas roll over to a fresh meter.
 *
 * Pure: depends only on its argument and performs no IO. The "YYYY-MM" format is
 * the repo's invariant (see {@link currentBillingPeriod}); a December period
 * correctly rolls over to January of the next year.
 */
export const nextPeriodStart = (period: string): Date => {
  const [yearPart, monthPart] = period.split("-");
  const year = Number(yearPart);
  // `monthPart` is 1-based ("01".."12"); Date.UTC expects a 0-based month, so
  // passing the same number yields the *following* month. December (12) thus
  // becomes month index 12 of the same year, which Date normalizes to January.
  const month = Number(monthPart);
  return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
};
