/**
 * What every AI step in the `ld-*` pipelines shares: the read-only `bun1`
 * environment, the Acme Shop orientation prepended to prompts, and the
 * optional work-item description input.
 */
import { Repo, Runtime } from "@scarn/sdk/definitions/steps";
import { z } from "zod";

export const readOnly = {
  runtime: Runtime.managed.bun1(),
  repo: Repo.readOnly(),
};

export const SHOP_CONTEXT = `
You are working in the Acme Shop repository: a small storefront with a
product grid, cart and checkout with coupon codes. \`server.mjs\` serves the
static pages in \`public/\` and a JSON API; \`lib/\` holds catalog, search and
HTTP helpers. Read \`README.md\` first. Start the shop with
\`PORT=4173 bun server.mjs &\` when you need it running.
`;

export const description = z.string().nullable().optional();
