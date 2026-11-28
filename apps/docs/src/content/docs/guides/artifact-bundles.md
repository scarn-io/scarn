---
title: Building shareable HTML bundles
description: Write an HTML report or a built prototype that opens from a share link
---

A **bundle** is a folder an agent submits as one artifact: an entry page such as `index.html`, plus the files it loads. Scarn stores it, previews it for project members, and can share it by link. Scarn doesn't write bundles; the agent does. This page covers what a bundle must look like to work from a link, with two worked examples.

For declaring bundle fields, limits and sharing, see [Attaching artifacts to comments](/scarn/guides/steps/#declaring-a-bundle-field).

## How a bundle is served

A share link looks like `https://<content host>/s/<token>/`. The content host is a separate address from the Scarn app, so a bundle can never read your Scarn session. Every file is served with this Content Security Policy:

```text
sandbox allow-scripts allow-popups allow-forms allow-downloads;
default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval';
form-action 'none';
frame-ancestors <your Scarn app>
```

What that means for the bundle:

- **Self-contained.** Scripts, styles, fonts, images, media and `fetch` calls can only load files from the bundle itself, `data:` URLs and `blob:` URLs. A CDN script, a Google Font or a call to an API is blocked. Bundle every dependency.
- **Inline code works.** Inline `<script>` and `<style>` blocks, `style=""` attributes and `eval` are allowed.
- **No storage.** The page runs without an origin of its own (the sandbox has no `allow-same-origin`). Reading `localStorage`, `sessionStorage`, `IndexedDB` or `document.cookie` throws a `SecurityError`. Keep state in memory.
- **No form posts.** Forms can't submit anywhere. Handle `submit` in script and call `preventDefault()`.
- **Not embeddable elsewhere.** Only the Scarn app may show the bundle in an `<iframe>`. The link opens fine on its own.

And for the URLs:

- **Relative paths only.** Write `src="media/repro.mp4"` or `./media/repro.mp4`, never `/media/repro.mp4`. A path starting with `/` points outside the bundle.
- **The entry page is served at the root.** `/s/<token>/` serves the entry page, and a link without the trailing slash redirects to it. Its relative URLs resolve from the top of the folder, so keep the entry page at the top of the folder.
- **No server routing.** A path that isn't a file in the bundle returns 404. There is no directory index (`docs/` doesn't serve `docs/index.html`) and no fallback to the entry page. Use hash routing (`#/settings`) for pages inside an app.
- **Video seeking works.** Range requests are supported, so `<video>` can seek.

Links stay up until they are revoked or the bundle expires, 30 days after upload. A bundle can hold up to 1,000 files, 100 MiB per file and 250 MiB in total.

## Example: an HTML bug report with media

The step declares a bundle field that is shared automatically, and tells the agent what to put in it.

```typescript
import { defineStep, z } from "@scarn/sdk/definitions/steps";

export const reproduceBug = defineStep({
  key: "reproduce-bug",
  name: "Reproduce Bug",
  result: z.object({
    summary: z.string(),
    report: z.artifact.bundle({ share: true }),
  }),
  agentPrompt: `Reproduce the bug. Write an HTML report in out/report/:
- out/report/index.html: the steps, what you expected, what happened;
- a screenshot, a GIF of the failure and a screen recording, next to it
  in out/report/media/, referenced with relative paths.
Use no external scripts, stylesheets or fonts.
Then call scarn-submit-artifact with path "out/report" and field "report".`,
});
```

The agent writes a folder like this:

```text
out/report/
├── index.html
└── media/
    ├── before.png
    ├── failure.gif
    └── repro.mp4
```

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Checkout button does nothing</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        max-width: 48rem;
        margin: 2rem auto;
      }
      img,
      video {
        max-width: 100%;
      }
    </style>
  </head>
  <body>
    <h1>Checkout button does nothing</h1>
    <ol>
      <li>Add any item to the cart.</li>
      <li>Click <strong>Checkout</strong>.</li>
    </ol>
    <p>Expected: the payment page. Actual: nothing happens.</p>
    <img src="media/before.png" alt="Cart before clicking Checkout" />
    <img src="media/failure.gif" alt="Clicking Checkout has no effect" />
    <video src="media/repro.mp4" controls></video>
  </body>
</html>
```

Once the folder has uploaded, it is shared. A later step's comment can link to it:

```typescript
Artifact.link({ step: reproduceBug, path: "report" }, { label: "Full report" });
```

The comment then carries the share link, so people on the issue can open the report without a Scarn account.

## Example: a Vite prototype

A prototype doesn't need a declared field. The agent builds it and submits `dist/` as an undeclared bundle. It stays private until a person shares it.

In `vite.config.ts`, make every asset URL relative:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
});
```

Use a hash router, so every page is served by `index.html`. With React Router:

```tsx
import { createHashRouter, RouterProvider } from "react-router-dom";

const router = createHashRouter([
  { path: "/", element: <Home /> },
  { path: "/settings", element: <Settings /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

Keep state in memory instead of `localStorage`. If a library reads storage itself, guard it:

```typescript
function canUseStorage(): boolean {
  try {
    return window.localStorage !== null;
  } catch {
    return false;
  }
}
```

Bundle fonts and icons through imports rather than linking a CDN, and call no external APIs: put sample data in a JSON file in `public/` and load it with a relative `fetch("./data.json")`.

Then build and submit. The agent runs `vite build` and calls `scarn-submit-artifact` with `path: "dist"` and `name: "prototype"`. Without `name`, the bundle is named after the folder, `dist`.

To share it, open the run's artifacts in Scarn, click **Share** on the `prototype` row and copy the link. A comment can point at it with a path marker:

```typescript
Artifact.link("prototype/", { label: "Try the prototype" });
```

## Checking a bundle before you submit it

Serve the folder locally from a subpath, so absolute paths break the same way they would from a link:

```bash
mkdir -p /tmp/bundle-check/s/test && cp -R out/report/. /tmp/bundle-check/s/test/
cd /tmp/bundle-check && python3 -m http.server 8000
```

Open `http://localhost:8000/s/test/` with the network panel open. Any request outside `/s/test/` or to another site would fail from a share link. This doesn't apply the sandbox, so storage still works here; check for `localStorage` and cookies in the code.
