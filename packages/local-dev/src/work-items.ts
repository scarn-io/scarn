/**
 * The work items seed creates in the sandbox. `fields.demo` (a pipeline key
 * without `ld-`) picks the pipeline through the default automation, and the
 * other fields steer the branch inside it. `expect` is the outcome each item
 * should reach under `work`; seed prints it next to the item.
 *
 * Most branches are decided by AI steps that are told to honor the steering
 * field, and `description` is written to agree with it, so `expect` is the
 * usual outcome rather than a guaranteed one. Branches driven by code steps
 * (`loop`, `errors`, `merges`, the lane failures) are exact.
 *
 * Numeric fields must be JSON numbers: the steps' zod schemas reject numeric
 * strings.
 */
export type LocalWorkItem = {
  /** Becomes the platformKey `local-${key}`. */
  key: string;
  title: string;
  /** What the item exercises, for whoever reads this file. Not seeded. */
  note: string;
  /** The report the agents read, seeded as the work item's description. */
  description: string;
  fields: Record<string, unknown>;
  state?: "open" | "closed";
  expect: string;
};

export const WORK_ITEMS: LocalWorkItem[] = [
  {
    key: "linear",
    title: "Footer links overlap on narrow screens",
    note: "Runs ld-linear through intake, analyze and summarize.",
    description:
      "On phones narrower than ~380px the footer links wrap on top of each other and the last two can't be tapped. Seen on the home page and checkout.",
    fields: { demo: "linear" },
    expect: "succeed: done",
  },
  {
    key: "choice-critical",
    title: "Checkout returns 500 for every order",
    note: "ld-choice with severity critical pages on-call.",
    description:
      "Every POST to /api/coupon and checkout submit returns a 500 since this morning's deploy. No orders are going through.",
    fields: { demo: "choice", severity: "critical" },
    expect: "succeed: paged",
  },
  {
    key: "choice-minor",
    title: "Typo on the shipping page",
    note: "ld-choice with severity minor falls through to a ticket.",
    description:
      'The checkout page says "Shiping" in the totals section. Cosmetic only.',
    fields: { demo: "choice", severity: "minor" },
    expect: "succeed: ticketed",
  },
  {
    key: "choice-invalid",
    title: "Severity was filled in wrong",
    note: "ld-choice with severity invalid ends at the fail terminal.",
    description: "asdf test please ignore",
    fields: { demo: "choice", severity: "invalid" },
    expect: "fail: invalid",
  },
  {
    key: "decision-required",
    title: "Coupon total rounds the wrong way",
    note: "ld-decision with requiresApproval true waits for you to approve, revise or reject the fix.",
    description:
      "Applying SAVE10 to a $14.00 cart shows a $1.40 discount, but applying it twice keeps adding to the discount. Totals should never go below one application of a coupon.",
    fields: { demo: "decision", requiresApproval: true },
    expect: "waits: review-fix",
  },
  {
    key: "decision-skipped",
    title: "Update the copyright year",
    note: "ld-decision with requiresApproval false applies the fix directly.",
    description: "The footer still says \u00a9 2025. It should say 2026.",
    fields: { demo: "decision", requiresApproval: false },
    expect: "succeed: done",
  },
  {
    key: "reply-full",
    title: "Cart badge shows 0 after adding an item on /cart",
    note: "ld-reply with detail full has enough to go on.",
    description:
      "Steps: open /, add the Classic Mug, go to /checkout.html. The badge in the header shows 0 even though the cart line shows the mug. Expected the badge to show 1. Happens every time in Chrome and Safari.",
    fields: { demo: "reply", detail: "full" },
    expect: "succeed: done",
  },
  {
    key: "reply-thin",
    title: "Something is broken",
    note: "ld-reply with detail thin asks you for more detail.",
    description: "it doesn't work",
    fields: { demo: "reply", detail: "thin" },
    expect: "waits: ask-for-details",
  },
  {
    key: "loop-pass",
    title: "Flaky cart test passes on the third try",
    note: "ld-loop with passOnAttempt 3 passes on run 3.",
    description:
      "The cart test fails intermittently in CI. It usually passes on a re-run.",
    fields: { demo: "loop", passOnAttempt: 3 },
    expect: "succeed: done",
  },
  {
    key: "loop-give-up",
    title: "Cart test never passes",
    note: "ld-loop with passOnAttempt 99 runs out of maxRuns.",
    description: "The cart test fails on every run since the coupon change.",
    fields: { demo: "loop", passOnAttempt: 99 },
    expect: "fail: gave-up",
  },
  {
    key: "errors-throw",
    title: "Inventory sync throws every time",
    note: "ld-errors with failMode throw is retried, then caught into recover.",
    description: "The nightly inventory sync job errors out on every run.",
    fields: { demo: "errors", failMode: "throw" },
    expect: "succeed: recovered",
  },
  {
    key: "errors-sleep",
    title: "Inventory sync hangs",
    note: "ld-errors with failMode sleep outlasts the 120 s step timeout.",
    description:
      "The nightly inventory sync job never finishes and has to be killed.",
    fields: { demo: "errors", failMode: "sleep" },
    expect: "fail: timed-out",
  },
  {
    key: "errors-none",
    title: "Inventory sync works",
    note: "ld-errors with failMode none succeeds first time.",
    description: "Sanity check that the inventory sync job still runs cleanly.",
    fields: { demo: "errors", failMode: "none" },
    expect: "succeed: done",
  },
  {
    key: "lanes-clean",
    title: "Rename the cart helpers",
    note: "ld-lanes-merge edits 3 files, then waits for a decision.",
    description:
      "Rename the cart helpers in server.mjs and public/app.js to a consistent cart* prefix (cartSubtotal, cartDiscount, serializeCart, renderCart, ...).",
    fields: { demo: "lanes-merge", files: 3, failFiles: 0 },
    expect: "waits: approve-edits (3 edits)",
  },
  {
    key: "lanes-tolerated",
    title: "Rename the checkout helpers",
    note: "ld-lanes-merge with one failing lane, within tolerance, then waits for a decision.",
    description:
      "Rename the checkout helpers in public/app.js and public/checkout.html so they share a checkout* prefix.",
    fields: { demo: "lanes-merge", files: 3, failFiles: 1 },
    expect: "waits: approve-edits (2 edits)",
  },
  {
    key: "lanes-over-tolerance",
    title: "Rename the payment helpers",
    note: "ld-lanes-merge with two failing lanes, over the tolerance of one.",
    description:
      "Rename the payment and coupon helpers across server.mjs, lib/ and public/ to a consistent naming scheme.",
    fields: { demo: "lanes-merge", files: 3, failFiles: 2 },
    expect: "run failed: lanes over tolerance",
  },
  {
    key: "routes-backlog",
    title: "Product images load slowly",
    note: "ld-routes-all with a plain bug and no pages: reproduce plus the backlog lane.",
    description:
      "Product images on the home page take a second or two to appear on a slow connection. Not blocking anything.",
    fields: { demo: "routes-all", category: "bug" },
    expect: "succeed: triaged",
  },
  {
    key: "routes-security-pages",
    title: "Session token leaks into the checkout URL",
    note: "ld-routes-all with category security and two pages: reproduce, notify security and two page-inspection lanes.",
    description:
      "After applying a coupon, the checkout URL contains what looks like a session token in the query string, which then shows up in the browser history and in Referer headers.",
    fields: {
      demo: "routes-all",
      category: "security",
      affectedPages: ["/", "/checkout.html"],
    },
    expect: "succeed: triaged",
  },
  {
    key: "merges-release",
    title: "Release 1.4.0 to production",
    note: "ld-merges with every check green: unit and e2e merge at combine-tests, then everything closes at decide-release.",
    description: "Cut and ship 1.4.0: search improvements and the coupon fix.",
    fields: {
      demo: "merges",
      services: ["api", "web", "worker"],
      scan: true,
      advisories: 0,
    },
    expect: "succeed: released",
  },
  {
    key: "merges-blocked",
    title: "Release 1.4.1 to production",
    note: "ld-merges with a failing e2e suite and an unhealthy worker: decide-release blocks the release.",
    description: "Cut and ship 1.4.1: follow-up fixes to 1.4.0.",
    fields: {
      demo: "merges",
      services: ["api", "web", "worker"],
      unhealthy: ["worker"],
      failingSuite: "e2e",
    },
    expect: "fail: release-blocked",
  },
  {
    key: "grill",
    title: "Should guest checkout keep the cart after sign-in?",
    note: "ld-grill: the agent grills you on the title in the step's conversation.",
    description:
      "A shopper adds items as a guest, then signs in at checkout. Today the guest cart is thrown away. Should we keep it, merge it with their saved cart, or ask?",
    fields: { demo: "grill" },
    expect: "waits: grill conversation",
  },
  {
    key: "secrets",
    title: "Check the sandbox API key reaches the worker",
    note: "ld-secrets reads the LOCAL_DEV_API_KEY project secret through the local-secrets environment.",
    description:
      "The sandbox API key is saved as a project secret. Confirm a step can read it and that the task log masks it.",
    fields: { demo: "secrets" },
    expect: "succeed: done",
  },
  {
    key: "codestep-with-mcp-reserved",
    title: "Reserve 2 Acme mugs",
    note: "ld-codestep-with-mcp: the lookup-sku tool step finds MUG-01 and reserve-order reserves 2 of its 12 through context.mcp.",
    description: "A customer ordered 2 Acme mugs (MUG-01). Reserve the stock.",
    fields: { demo: "codestep-with-mcp", sku: "MUG-01", quantity: 2 },
    expect: "succeed: reserved",
  },
  {
    key: "codestep-with-mcp-backordered",
    title: "Reserve 3 Acme tees",
    note: "ld-codestep-with-mcp: TEE-02 has 1 in stock, so reserve-order fails with its declared Order.OutOfStock and the catch backorders it.",
    description: "A customer ordered 3 Acme tees (TEE-02). Reserve the stock.",
    fields: { demo: "codestep-with-mcp", sku: "TEE-02", quantity: 3 },
    expect: "succeed: backordered",
  },
  {
    key: "codestep-with-mcp-unknown",
    title: "Reserve 1 Acme scarf",
    note: "ld-codestep-with-mcp: the shop doesn't sell SCARF-09, so lookup-sku's typed found is false and the route fails.",
    description:
      "A customer ordered 1 Acme scarf (SCARF-09). Reserve the stock.",
    fields: { demo: "codestep-with-mcp", sku: "SCARF-09", quantity: 1 },
    expect: "fail: unknown-sku",
  },
  {
    key: "routing-closed",
    title: "Closed: old header bug",
    note: "Closed, so it is never ready and nothing runs.",
    description: "The header logo was misaligned. Fixed in an earlier release.",
    fields: { state: "closed" },
    state: "closed",
    expect: "skipped",
  },
  {
    key: "routing-resolved",
    title: "Resolved: old footer bug",
    note: "status resolved, so the default automation skips it.",
    description: "The footer overlapped the cart on tablets. Fixed in 1.3.2.",
    fields: { status: "resolved" },
    expect: "skipped",
  },
  {
    key: "routing-default",
    title: "No demo field on this one",
    note: "No demo field, so the default automation runs ld-linear.",
    description:
      "The search box on the home page doesn't clear after a search.",
    fields: {},
    expect: "succeed: done",
  },
];
