import { setDefaultTimeout } from "bun:test";
import { configure } from "@testing-library/dom";

/**
 * Preloaded before every `bun test` file in apps/next (see bunfig.toml).
 *
 * Both time budgets live here so they are tuned in one place:
 * - the per-test timeout (`NEXT_UNIT_TEST_TIMEOUT_MS`, default 15s), and
 * - Testing Library's `waitFor`/`findBy*` budget
 *   (`NEXT_UNIT_TEST_ASYNC_TIMEOUT_MS`, default 5s, up from its 1s default,
 *   which a loaded CI runner exceeds while MUI dialogs mount and unmount).
 */
const readMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

setDefaultTimeout(readMs("NEXT_UNIT_TEST_TIMEOUT_MS", 15_000));
configure({
  asyncUtilTimeout: readMs("NEXT_UNIT_TEST_ASYNC_TIMEOUT_MS", 5_000),
});
