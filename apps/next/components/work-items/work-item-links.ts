/**
 * Finding work item links in Markdown. A link names a work item when its
 * path ends in `/work-items/<uuid v7>`, on any host and whether it's
 * absolute or relative, so a link copied from another deployment, or one an
 * agent wrote with the app's base URL, still resolves. Whether the item is
 * really in this project is up to the lookup, not the URL.
 */

const UUID_V7 =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const WORK_ITEM_PATH = new RegExp(`/work-items/(${UUID_V7})/?$`, "i");
const WORK_ITEM_PATH_IN_TEXT = new RegExp(
  `(?<![\\w-])work-items/(${UUID_V7})(?![0-9a-f-])`,
  "gi",
);
const RELATIVE_BASE = "https://relative.invalid/";

/** The work item id `href` links to, or `null` when it isn't a work item link. */
export function workItemIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  let pathname: string;
  try {
    pathname = new URL(href, RELATIVE_BASE).pathname;
  } catch {
    return null;
  }
  const match = WORK_ITEM_PATH.exec(pathname);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Every work item id a path in `text` names, each once, in order. It reads
 * the raw text, so it may find ids that end up outside a link (in code, say);
 * those are only looked up, never shown.
 */
export function workItemIdsInText(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(WORK_ITEM_PATH_IN_TEXT)) {
    if (match[1]) ids.add(match[1].toLowerCase());
  }
  return [...ids];
}
