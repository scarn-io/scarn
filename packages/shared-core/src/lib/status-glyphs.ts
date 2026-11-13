/**
 * Single-character status glyphs for the read commands, kept small and
 * legible in a monospace terminal:
 *
 *   ✓ satisfied / succeeded — done, successfully
 *   ✗ unsatisfied / failed  — failed
 *   ● running / active      — in flight
 *   ○ queued / pending      — not started yet
 *   ‼ blocked / waiting     — waiting on a human decision
 *   ⏱ timeout               — blew its deadline
 *   ⚠ abandoned             — lost its worker lease
 *   ⊘ cancelled             — deliberately stopped
 */
const LOOSE_STATUS_GLYPHS: Readonly<Record<string, string>> = {
  satisfied: "✓",
  unsatisfied: "✗",
  running: "●",
  queued: "○",
  pending: "○",
  blocked: "‼",
  timeout: "⏱",
  abandoned: "⚠",
  cancelled: "⊘",
  succeeded: "✓",
  failed: "✗",
  active: "●",
  waiting: "‼",
  waiting_for_person: "‼",
  needs_person: "‼",
  waiting_for_work: "○",
  waiting_for_concurrency_slot: "○",
  ready: "○",
  open: "○",
  answered: "✓",
  closed: "✓",
  not_needed: "⊘",
};

/**
 * Glyph for any status vocabulary the read commands list (run and visit
 * status, Task status, work item and question states). Unknown statuses
 * render as `·` rather than failing, since these come straight off the wire.
 */
export function looseStatusGlyph(status: string | null): string {
  if (status === null) return "·";
  return LOOSE_STATUS_GLYPHS[status] ?? "·";
}
