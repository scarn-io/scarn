/**
 * Styles for the template detail page, its Use dialog and the "template
 * used" toast, inlined into `index-html-template.ts`'s `<style>` block.
 */
export const TEMPLATE_PAGE_CSS = `
      .studio-template-detail { padding: 16px 24px 48px; }
      .studio-template-breadcrumb { margin: 0 0 12px; font-size: 13px; }
      .studio-template-breadcrumb a { color: var(--studio-text-muted); text-decoration: none; }
      .studio-template-breadcrumb a:hover { color: var(--studio-text); text-decoration: underline; }
      .studio-template-preview {
        display: flex;
        height: 500px;
        border: 1px solid var(--studio-border);
        border-radius: 6px;
        overflow: hidden;
      }
      .studio-template-graph { flex: 1; min-width: 0; }
      .studio-template-step-panel {
        width: 360px;
        flex: none;
        overflow-y: auto;
        padding: 12px 16px;
        border-left: 1px solid var(--studio-border);
        background: var(--studio-surface);
      }
      .studio-template-preview-errors {
        margin: 8px 0 0;
        padding-left: 20px;
        font-size: 13px;
        color: var(--studio-severity-error);
      }
      .studio-template-body {
        display: grid;
        grid-template-columns: 300px minmax(0, 760px);
        gap: 32px;
        align-items: start;
        margin-top: 24px;
      }
      .studio-template-side {
        position: sticky;
        top: 16px;
        padding: 16px;
        border: 1px solid var(--studio-border);
        border-radius: 6px;
        background: var(--studio-surface);
        font-size: 13px;
      }
      .studio-template-side-name { margin: 0 0 6px; font-size: 18px; color: var(--studio-text-strong); }
      .studio-template-side-summary { margin: 0 0 12px; color: var(--studio-text-subtle); }
      .studio-template-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        list-style: none;
        margin: 0 0 12px;
        padding: 0;
      }
      .studio-template-tags li {
        padding: 1px 8px;
        border-radius: 999px;
        background: var(--studio-surface-raised);
        border: 1px solid var(--studio-border);
        color: var(--studio-text-muted);
        font-size: 11px;
      }
      .studio-template-facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 12px;
        margin: 0 0 16px;
      }
      .studio-template-facts dt { color: var(--studio-text-muted); }
      .studio-template-facts dd { margin: 0; word-break: break-word; }
      .studio-template-renamed { display: block; margin-top: 4px; color: var(--studio-text-muted); font-size: 12px; }
      .studio-template-use { width: 100%; }
      .studio-template-conflicts,
      .studio-template-use-error {
        margin-top: 12px;
        padding: 8px 10px;
        border-left: 3px solid var(--studio-severity-warning);
        background: var(--studio-surface-raised);
        border-radius: 4px;
      }
      .studio-template-use-error { border-left-color: var(--studio-severity-error); }
      .studio-template-conflicts p,
      .studio-template-use-error p { margin: 0 0 4px; }
      .studio-template-conflicts ul,
      .studio-template-use-error ul { margin: 0 0 4px; padding-left: 18px; }
      .studio-button {
        padding: 6px 12px;
        border: 1px solid var(--studio-border);
        border-radius: 4px;
        background: var(--studio-surface-raised);
        color: var(--studio-text);
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .studio-button:hover:not(:disabled) { background: var(--studio-hover); }
      .studio-button:disabled { opacity: 0.5; cursor: not-allowed; }
      .studio-button:focus-visible { outline: 2px solid var(--studio-focus); outline-offset: 2px; }
      .studio-button-primary {
        background: var(--studio-text-strong);
        border-color: var(--studio-text-strong);
        color: var(--studio-bg);
        font-weight: 600;
      }
      .studio-button-primary:hover:not(:disabled) { background: var(--studio-text-subtle); }
      .studio-markdown { font-size: 14px; line-height: 1.6; color: var(--studio-text); }
      .studio-markdown h1,
      .studio-markdown h2,
      .studio-markdown h3,
      .studio-markdown h4 { margin: 20px 0 8px; color: var(--studio-text-strong); }
      .studio-markdown h3 { font-size: 15px; }
      .studio-markdown > :first-child { margin-top: 0; }
      .studio-markdown p { margin: 0 0 12px; }
      .studio-markdown ul,
      .studio-markdown ol { margin: 0 0 12px; padding-left: 22px; }
      .studio-markdown a { color: var(--studio-severity-info); }
      .studio-markdown code,
      .studio-template-side code,
      .studio-toast code,
      .studio-dialog code,
      .studio-detail-notice code {
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 0.9em;
        padding: 1px 4px;
        border-radius: 3px;
        background: var(--studio-surface-raised);
        border: 1px solid var(--studio-border-subtle);
      }
      .studio-detail-notice {
        margin: 10px 0 0;
        padding: 6px 8px;
        border: 1px dashed var(--studio-border);
        border-radius: 4px;
        font-size: 12px;
        color: var(--studio-text-subtle);
      }
      .studio-detail-description { margin: 10px 0 0; font-size: 13px; color: var(--studio-text-subtle); }
      .studio-detail-table th[scope="row"] { border-bottom: 1px solid var(--studio-border-subtle); white-space: nowrap; }
      .studio-dialog {
        width: min(520px, calc(100vw - 32px));
        padding: 20px;
        border: 1px solid var(--studio-border);
        border-radius: 8px;
        background: var(--studio-surface);
        color: var(--studio-text);
        font-size: 13px;
      }
      .studio-dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
      .studio-dialog-title { margin: 0 0 4px; font-size: 16px; color: var(--studio-text-strong); }
      .studio-dialog-target { margin: 0 0 16px; color: var(--studio-text-muted); }
      .studio-dialog-field { margin-bottom: 14px; }
      .studio-dialog-field label { display: block; font-weight: 600; margin-bottom: 4px; }
      .studio-dialog-optional { font-weight: normal; color: var(--studio-text-muted); }
      .studio-dialog-help { margin: 0 0 6px; color: var(--studio-text-muted); }
      .studio-dialog-field input,
      .studio-dialog-field textarea {
        box-sizing: border-box;
        width: 100%;
        padding: 6px 8px;
        border: 1px solid var(--studio-border);
        border-radius: 4px;
        background: var(--studio-surface-raised);
        color: var(--studio-text);
        font: inherit;
        resize: vertical;
      }
      .studio-dialog-error { margin: 0 0 12px; }
      .studio-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .studio-toast {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 10;
        width: 380px;
        padding: 12px 16px;
        border: 1px solid var(--studio-border);
        border-left: 4px solid var(--studio-severity-info);
        border-radius: 6px;
        background: var(--studio-surface);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        font-size: 13px;
      }
      .studio-toast p { margin: 6px 0; }
      .studio-toast ol { margin: 0; padding-left: 20px; }
      .studio-toast li { margin-bottom: 4px; }
      .studio-toast code { word-break: break-all; }
      .studio-toast-header { display: flex; justify-content: space-between; align-items: center; }
      .studio-toast-close {
        border: none;
        background: none;
        color: var(--studio-text-muted);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .studio-toast-close:hover { color: var(--studio-text); }
`;
