/** Leaves the app for `url` (e.g. a provider's authorization page). Its own module so tests can replace it. */
export const redirectToUrl = (url: string): void => {
  window.location.assign(url);
};
