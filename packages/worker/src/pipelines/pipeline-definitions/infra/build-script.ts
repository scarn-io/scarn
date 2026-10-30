// Bun's `with { type: "text" }` import attribute inlines the template at
// build time, so the bun-compile binary carries the script source as a string.
import template from "./build-script.ts.tmpl" with { type: "text" };

export const BUILD_SCRIPT_FILENAME = ".scarn-build.ts";
export const BUILD_SCRIPT_TEMPLATE = template;
export const BUILD_SCRIPT_MARKER = "__SCARN_BUILD__";
