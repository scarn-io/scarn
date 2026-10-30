/**
 * Creation sites: where in the author's TypeScript a chain, target or ref was
 * written, read from `new Error().stack`. Frames inside the SDK itself are
 * skipped, so the site is the first frame in user code.
 */

/** A position in a source file. `file` is an absolute path or URL. */
export interface SourceSite {
  file: string;
  line: number;
  column: number;
}

const FRAME = /\(?((?:file:\/\/)?[^\s()]+):(\d+):(\d+)\)?\s*$/;

function sdkRoot(): string {
  const here = new URL(import.meta.url).pathname;
  const parts = here.split("/");
  return parts.slice(0, -2).join("/") + "/";
}

const SDK_ROOT = sdkRoot();

function toPath(file: string): string {
  return file.startsWith("file://") ? new URL(file).pathname : file;
}

/** Parses one stack frame line into a site, or null for native frames. */
export function parseFrame(frame: string): SourceSite | null {
  const match = FRAME.exec(frame.trim());
  if (match === null) {
    return null;
  }
  const [, file, line, column] = match;
  if (file === undefined || line === undefined || column === undefined) {
    return null;
  }
  return { file: toPath(file), line: Number(line), column: Number(column) };
}

/** The first frame of the current stack that is outside the SDK, if any. */
export function captureSite(stack = new Error().stack): SourceSite | null {
  for (const frame of (stack ?? "").split("\n").slice(1)) {
    const site = parseFrame(frame);
    if (
      site !== null &&
      !site.file.startsWith(SDK_ROOT) &&
      !site.file.startsWith("node:") &&
      site.file.includes("/")
    ) {
      return site;
    }
  }
  return null;
}

function cwd(): string | null {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  return typeof proc?.cwd === "function" ? proc.cwd() : null;
}

/** `file.ts:42`, with the file relative to the working directory when it's inside it. */
export function formatSite(site: SourceSite | null): string {
  if (site === null) {
    return "<unknown>";
  }
  const base = cwd();
  const file =
    base !== null && site.file.startsWith(`${base}/`)
      ? site.file.slice(base.length + 1)
      : site.file;
  return `${file}:${String(site.line)}`;
}
