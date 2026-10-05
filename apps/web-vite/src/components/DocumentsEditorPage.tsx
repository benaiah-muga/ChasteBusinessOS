import { useCallback, useEffect, useRef, useState } from "react";
import "./DocumentsEditorPage.css";
import {
  DEFAULT_PAGE_SETTINGS,
  DocumentsEditorApiError,
  createDocumentTemplate,
  documentHtmlToJson,
  documentJsonToHtml,
  documentsEditorIdFromPath,
  downloadDocx,
  fetchArchivedVersion,
  fetchEditorDocument,
  postEditorWorkspace,
  publishDocumentVersion,
  refineDocumentHtml,
  releaseEditorWorkspace,
  requestAssist,
  restoreDocumentVersion,
  sanitizeDocumentHtml,
  updateDocumentMetadata,
  type AuthoredDocument,
  type PageSettings,
  type PresenceUser,
  type VersionRow,
} from "../api/documents-editor";
import "./DocumentsEditorPage.css";

/**
 * Authored-document editor: a debounced autosave to the draft workspace
 * (outside the ledger, ADR 0056), live presence, soft locks, append-only
 * version publishing with compare and restore, AI writing assist, page
 * settings with a print-styled paper preview and .docx export.
 *
 * The writing surface is a content-editable region over the same ProseMirror
 * JSON the rest of the app stores, serialized through an allowlist. Nothing
 * from a stored document reaches the DOM as markup without passing
 * `sanitizeDocumentHtml` first, so a document can never bring a script, a
 * frame or a remote image along with it.
 */

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

type Notice =
  | { tone: "pending" | "success"; text: string }
  | { tone: "error"; text: string };

type BootState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; document: AuthoredDocument; versions: VersionRow[] };

type CompareState = { a: string; b: string; aV: number; bV: number } | null;

interface SurfaceHandle {
  element: HTMLElement;
  emit: () => void;
}

const SAVE_LABELS: Record<SaveState, string> = {
  idle: "",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Save interrupted: retry",
  conflict: "Edited elsewhere: reload to pick up the latest draft",
};

const LANGUAGES = ["English", "Swahili", "French", "Arabic", "Luganda", "Amharic"];

function readableError(error: unknown): string {
  return error instanceof DocumentsEditorApiError
    ? error.message
    : "Could not reach the document service. Check your connection and try again.";
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function closestTag(node: Node | null, tag: string): Element | null {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === 1 && (current as Element).tagName.toLowerCase() === tag) return current as Element;
    current = current.parentNode;
  }
  return null;
}

/** Text the assist panel needs: what is selected, and what precedes the caret. */
function selectionFacts(surface: HTMLElement | null): { text: string; before: string } {
  const selection = window.getSelection();
  if (!surface || !selection || selection.rangeCount === 0) return { text: "", before: "" };
  const range = selection.getRangeAt(0);
  if (!surface.contains(range.startContainer)) return { text: "", before: "" };
  const before = range.cloneRange();
  before.selectNodeContents(surface);
  before.setEnd(range.startContainer, range.startOffset);
  return { text: selection.toString(), before: before.toString() };
}

const EDITOR_STYLES = `
.de-page { display: flex; min-height: calc(100vh - 74px); flex-direction: column; }
.de-header { position: sticky; top: 0; z-index: 10; border-bottom: 1px solid #e5e3dc; background: rgb(250 249 245 / 95%); backdrop-filter: blur(6px); }
.de-header-row { display: flex; max-width: 1180px; flex-wrap: wrap; align-items: center; gap: 9px; margin: 0 auto; padding: 10px 16px; }
.de-back { color: #8a8980; font-size: 12px; text-decoration: none; }
.de-back:hover { color: #243d32; }
.de-title { min-width: 12rem; flex: 1; border: 1px solid transparent; border-radius: 7px; padding: 5px 8px; background: transparent; color: #24241f; font-size: 15px; font-weight: 650; }
.de-title:hover { background: #f0efe9; }
.de-title:focus { border-color: #cfd8d0; background: #fff; outline: none; }
.de-chip { max-width: 14rem; overflow: hidden; border: 1px solid #e2e0d7; border-radius: 99px; padding: 3px 9px; background: #f2f1ea; color: #7c7b72; font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.de-presence { display: flex; gap: 5px; }
.de-presence span { border-radius: 99px; padding: 3px 9px; background: #f3ecdb; color: #7a6534; font-size: 10.5px; font-weight: 600; }
.de-save { font-size: 11px; }
.de-save-saved { color: #3c7a55; font-weight: 600; }
.de-save-pending { color: #86877e; }
.de-save-conflict { color: #9a6f1f; font-weight: 600; }
.de-save-error { color: #a5382e; font-weight: 600; }
.de-save-retry { border: 0; padding: 0; background: none; color: inherit; cursor: pointer; font: inherit; text-decoration: underline; text-underline-offset: 2px; }
.de-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.de-group { display: flex; gap: 5px; }
.de-button { display: inline-flex; min-height: 30px; align-items: center; justify-content: center; border: 1px solid #d9d7cd; border-radius: 7px; padding: 0 10px; background: #f7f6f0; color: #354238; cursor: pointer; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.de-button:hover { border-color: #b1a47d; background: #f2efe5; }
.de-button:disabled { cursor: wait; opacity: .55; }
.de-button-primary { border-color: #26372e; background: #26372e; color: #f7f6f0; }
.de-button-primary:hover { border-color: #315744; background: #315744; }
.de-button-ghost { border-color: transparent; background: transparent; color: #6b716a; }
.de-button-ghost:hover { background: #efeee8; }
.de-button[aria-pressed="true"] { border-color: #a99a74; background: #f2efe5; }
.de-select, .de-input { min-height: 30px; border: 1px solid #dedbd2; border-radius: 7px; padding: 4px 8px; background: #fff; color: inherit; font-size: 11.5px; }
.de-textarea { width: 100%; min-height: 60px; resize: vertical; border: 1px solid #dedbd2; border-radius: 7px; padding: 7px 8px; background: #fff; color: inherit; font: inherit; font-size: 12px; }
.de-lock { max-width: 1180px; margin: 0 auto; padding: 0 16px 9px; color: #7a5c17; font-size: 11.5px; }
.de-lock p { margin: 0; border: 1px solid #eadfbe; border-radius: 8px; padding: 6px 10px; background: #fbf6e8; }
.de-body { width: min(100% - 32px, 1536px); margin: 0 auto; padding: 14px 0 40px; }
.de-view-switch { display: none; gap: 6px; margin-bottom: 12px; }
.de-view-switch button { border: 1px solid #dedbd2; border-radius: 99px; padding: 4px 14px; background: #f7f6f0; color: #6b716a; cursor: pointer; font-size: 11.5px; font-weight: 600; }
.de-view-switch button[aria-selected="true"] { border-color: #a99a74; background: #f2efe5; color: #354238; }
.de-workbench { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.85fr); gap: 16px; align-items: start; }
.de-workbench.is-assisted { grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr) 300px; }
.de-panel { border: 1px solid #e5e3dc; border-radius: 14px; background: #fffefa; box-shadow: 0 12px 34px rgb(48 45 36 / 5%); }
.de-notice { display: grid; gap: 3px; margin-bottom: 10px; border-radius: 9px; padding: 8px 11px; font-size: 11.5px; }
.de-notice-success { border: 1px solid #cfe0d3; background: #f2f8f3; color: #2c5540; }
.de-notice-pending { border: 1px solid #e6dcc0; background: #fbf6e8; color: #6b5a25; }
.de-notice-error { border: 1px solid #e9c6bd; background: #fff7f4; color: #994838; }
.de-notice-dismiss { justify-self: start; border: 0; padding: 0; background: none; color: inherit; cursor: pointer; font: inherit; font-size: 10.5px; text-decoration: underline; text-underline-offset: 2px; }
.de-toolbar { display: flex; flex-wrap: wrap; gap: 3px; border-bottom: 1px solid #eae8e0; padding: 7px 9px; }
.de-tool { min-width: 26px; border: 1px solid transparent; border-radius: 6px; padding: 3px 6px; background: none; color: #6b716a; cursor: pointer; font-size: 11.5px; font-weight: 600; }
.de-tool:hover { background: #f0efe9; }
.de-tool[aria-pressed="true"] { border-color: #ded4b4; background: #f6f0dd; color: #7a6534; }
.de-tool-divider { width: 1px; margin: 2px 3px; background: #e5e3dc; }
.de-surface { min-height: 52vh; padding: 26px 30px; color: #24241f; font-size: 14px; line-height: 1.65; outline: none; }
.de-surface:focus { box-shadow: inset 0 0 0 2px #d9e2da; }
.de-surface[contenteditable="false"] { background: #fbfaf6; color: #6f7168; cursor: default; }
.de-surface > :first-child { margin-top: 0; }
.de-surface p { margin: 0 0 0.7em; }
.de-surface h1, .de-surface h2, .de-surface h3 { margin: 1.1em 0 0.4em; font-weight: 650; letter-spacing: -0.02em; }
.de-surface h1 { font-size: 1.5em; }
.de-surface h2 { font-size: 1.25em; }
.de-surface h3 { font-size: 1.1em; }
.de-surface ul, .de-surface ol { margin: 0 0 0.7em; padding-left: 1.4em; }
.de-surface blockquote { margin: 0 0 0.7em; border-left: 3px solid #ddd8c8; padding-left: 12px; color: #5d5e56; }
.de-surface pre { margin: 0 0 0.7em; border-radius: 8px; padding: 10px 12px; background: #f5f4ef; font-family: ui-monospace, monospace; font-size: 12.5px; }
.de-surface code { border-radius: 4px; padding: 0 3px; background: #f2f1ea; font-family: ui-monospace, monospace; font-size: 0.92em; }
.de-surface table { width: 100%; margin: 0 0 0.7em; border-collapse: collapse; }
.de-surface th, .de-surface td { border: 1px solid #e2e0d7; padding: 5px 8px; text-align: left; vertical-align: top; }
.de-surface hr { margin: 1em 0; border: 0; border-top: 1px solid #dcd8c9; }
.de-preview-bar { display: flex; justify-content: space-between; border-bottom: 1px solid #eae8e0; padding: 8px 13px; color: #86877e; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; }
.de-preview-stage { display: flex; justify-content: center; overflow: auto; padding: 16px; background: #f4f3ef; }
.de-paper { box-sizing: border-box; width: 100%; max-width: 210mm; background: #fff; color: #1d1d19; font-family: Georgia, "Times New Roman", serif; font-size: 13.5px; line-height: 1.62; }
.de-paper[data-size="Letter"] { max-width: 8.5in; }
.de-paper[data-orientation="landscape"] { max-width: 297mm; }
.de-paper[data-orientation="landscape"][data-size="Letter"] { max-width: 11in; }
.de-paper[data-margin="compact"] { padding: 14mm 16mm; }
.de-paper[data-margin="normal"] { padding: 20mm; }
.de-paper[data-margin="wide"] { padding: 28mm 30mm; }
.de-paper > :first-child { margin-top: 0; }
.de-paper p { margin: 0 0 0.8em; }
.de-paper h1, .de-paper h2, .de-paper h3 { margin: 1.2em 0 0.4em; font-weight: 600; letter-spacing: -0.01em; }
.de-paper h1 { font-size: 1.6em; }
.de-paper h2 { font-size: 1.3em; }
.de-paper h3 { font-size: 1.12em; }
.de-paper ul, .de-paper ol { margin: 0 0 0.8em; padding-left: 1.4em; }
.de-paper blockquote { margin: 0 0 0.8em; border-left: 2px solid #d8d2be; padding-left: 12px; color: #55564e; }
.de-paper pre { border-radius: 6px; padding: 9px 11px; background: #f6f5f0; font-family: ui-monospace, monospace; font-size: 0.88em; white-space: pre-wrap; }
.de-paper table { width: 100%; margin: 0 0 1em; border-collapse: collapse; }
.de-paper th, .de-paper td { border: 1px solid #ddd9cb; padding: 5px 8px; text-align: left; vertical-align: top; }
.de-paper th { background: #f6f4ec; font-weight: 600; }
.de-paper .num { text-align: right; font-variant-numeric: tabular-nums; }
.de-paper .doc-eyebrow { color: #84744e; font-size: 0.72em; font-weight: 700; letter-spacing: .14em; }
.de-paper .doc-grid { border: 0; }
.de-paper .doc-grid td { border: 0; padding: 2px 6px 2px 0; }
.de-paper .doc-totals td { font-weight: 600; }
.de-assist { display: flex; max-height: 74vh; flex-direction: column; gap: 9px; overflow-y: auto; padding: 14px; }
.de-assist h2 { margin: 0; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #84744e; }
.de-assist p { margin: 0; color: #7c7b72; font-size: 11.5px; line-height: 1.55; }
.de-assist-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.de-assist-result { border: 1px solid #e4dcc2; border-radius: 9px; padding: 10px; background: #fbf7ea; }
.de-assist-result p { color: #3a3b35; }
.de-assist-answer { border-radius: 9px; padding: 10px; background: #f5f4ef; }
.de-assist-chat { margin-top: auto; border-top: 1px solid #eae8e0; padding-top: 10px; }
.de-assist-chat h3 { margin: 0 0 6px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #84744e; }
.de-backdrop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 24px; background: rgb(32 30 24 / 45%); }
.de-dialog { position: relative; width: min(100%, 640px); max-height: 86vh; overflow-y: auto; border: 1px solid #e2e0d7; border-radius: 14px; padding: 22px; background: #fffefa; box-shadow: 0 24px 70px rgb(30 28 20 / 26%); }
.de-dialog-close { position: absolute; top: 14px; right: 16px; border: 0; padding: 0 4px; background: none; color: #86877e; cursor: pointer; font-size: 18px; line-height: 1; }
.de-dialog h2 { padding-right: 28px; margin: 0 0 10px; font-family: Georgia, "Times New Roman", serif; font-size: 22px; font-weight: 500; letter-spacing: -0.02em; }
.de-dialog p { margin: 0 0 12px; color: #6f7168; font-size: 12.5px; line-height: 1.6; }
.de-dialog label { display: grid; gap: 5px; margin-bottom: 12px; color: #86877e; font-size: 11px; }
.de-dialog .de-input { width: 100%; font-size: 12.5px; }
.de-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.de-versions { margin: 0; padding: 0; list-style: none; }
.de-versions li { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #eeece4; padding: 9px 0; }
.de-version-number { width: 34px; color: #86877e; font-family: ui-monospace, monospace; font-size: 11.5px; }
.de-version-copy { min-width: 0; flex: 1; font-size: 12.5px; }
.de-version-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.de-version-meta { color: #9a9a91; font-size: 11px; }
.de-compare { display: grid; max-height: 62vh; grid-template-columns: 1fr 1fr; gap: 12px; overflow-y: auto; }
.de-compare-label { margin: 0 0 5px; color: #84744e; font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.de-compare-body { border: 1px solid #e2e0d7; border-radius: 9px; padding: 12px; font-size: 12.5px; line-height: 1.6; }
.de-compare-body p { margin: 0 0 0.6em; }
.de-failure { display: grid; gap: 10px; max-width: 620px; margin: 8vh auto; border: 1px solid #e4e2d9; border-radius: 14px; padding: 26px; background: #fffefa; }
.de-failure h2 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: 24px; font-weight: 500; }
.de-failure p { margin: 0; color: #6f7168; font-size: 13px; line-height: 1.6; }
.de-failure a { color: #354238; font-size: 12.5px; }
.de-print-only { display: none; }
@media (max-width: 1180px) {
  .de-workbench, .de-workbench.is-assisted { grid-template-columns: minmax(0, 1fr); }
  .de-view-switch { display: flex; }
  .de-mobile-hidden { display: none; }
  .de-compare { grid-template-columns: 1fr; }
}
@media print {
  .app-rail, .app-topbar, .de-header, .de-view-switch, .de-toolbar, .de-assist, .de-notice, .de-lock, .de-preview-bar { display: none !important; }
  .app-main { width: 100%; margin: 0; }
  .de-body, .de-workbench, .de-panel, .de-preview-stage { width: auto; max-width: none; margin: 0; border: 0; padding: 0; background: none; box-shadow: none; }
  .de-print-only { display: block; }
  .de-print-only .de-paper { max-width: none; padding: 0; }
}
`;

interface NoticeProps {
  notice: Notice;
  onDismiss: () => void;
}

function ActionNotice({ notice, onDismiss }: NoticeProps) {
  return (
    <div className={`de-notice de-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      <span>{notice.text}</span>
      <button type="button" className="de-notice-dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

interface ToolSpec {
  key: string;
  title: string;
  label: string;
  command: string;
  value?: string;
  active?: string;
}

const TOOL_GROUPS: ToolSpec[][] = [
  [
    { key: "undo", title: "Undo", label: "↺", command: "undo" },
    { key: "redo", title: "Redo", label: "↻", command: "redo" },
  ],
  [
    { key: "h1", title: "Heading 1", label: "H1", command: "formatBlock", value: "h1", active: "h1" },
    { key: "h2", title: "Heading 2", label: "H2", command: "formatBlock", value: "h2", active: "h2" },
    { key: "h3", title: "Heading 3", label: "H3", command: "formatBlock", value: "h3", active: "h3" },
    { key: "p", title: "Paragraph", label: "¶", command: "formatBlock", value: "p", active: "p" },
  ],
  [
    { key: "bold", title: "Bold", label: "B", command: "bold", active: "bold" },
    { key: "italic", title: "Italic", label: "I", command: "italic", active: "italic" },
    { key: "underline", title: "Underline", label: "U", command: "underline", active: "underline" },
    { key: "strikeThrough", title: "Strikethrough", label: "S", command: "strikeThrough", active: "strikeThrough" },
  ],
  [
    { key: "insertUnorderedList", title: "Bullet list", label: "•≡", command: "insertUnorderedList", active: "insertUnorderedList" },
    { key: "insertOrderedList", title: "Numbered list", label: "1≡", command: "insertOrderedList", active: "insertOrderedList" },
    { key: "blockquote", title: "Quote", label: "❝", command: "formatBlock", value: "blockquote", active: "blockquote" },
    { key: "pre", title: "Code block", label: "‹›", command: "formatBlock", value: "pre", active: "pre" },
  ],
];

function DocumentSurface({
  seedKey,
  seedHtml,
  readOnly,
  onChange,
  onReady,
}: {
  seedKey: number;
  seedHtml: string;
  readOnly: boolean;
  onChange: (json: Record<string, unknown>, html: string) => void;
  onReady: (handle: SurfaceHandle) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const [block, setBlock] = useState("");
  const [inTable, setInTable] = useState(false);

  const emit = useCallback(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const html = sanitizeDocumentHtml(element.innerHTML);
    onChange(documentHtmlToJson(html), html);
  }, [onChange]);

  // Seeding must follow the seed key alone: a re-created change handler (page
  // settings, for one) would otherwise rewrite the surface under the caret.
  const seedRef = useRef(seedHtml);
  const emitRef = useRef(emit);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    seedRef.current = seedHtml;
    emitRef.current = emit;
    onReadyRef.current = onReady;
  });

  const syncMarks = useCallback(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const active: Record<string, boolean> = {};
    if (typeof document.queryCommandState === "function") {
      for (const name of ["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"]) {
        active[name] = document.queryCommandState(name);
      }
    }
    setMarks(active);
    const value = typeof document.queryCommandValue === "function" ? String(document.queryCommandValue("formatBlock") ?? "") : "";
    setBlock(value.replace(/[<>]/g, "").toLowerCase());
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    setInTable(Boolean(anchor && element.contains(anchor) && closestTag(anchor, "table")));
  }, []);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    element.innerHTML = seedRef.current;
    onReadyRef.current({ element, emit: () => emitRef.current() });
  }, [seedKey]);

  useEffect(() => {
    const element = surfaceRef.current;
    const handler = (): void => syncMarks();
    document.addEventListener("selectionchange", handler);
    element?.addEventListener("keyup", handler);
    element?.addEventListener("mouseup", handler);
    return () => {
      document.removeEventListener("selectionchange", handler);
      element?.removeEventListener("keyup", handler);
      element?.removeEventListener("mouseup", handler);
    };
  }, [syncMarks, seedKey]);

  const run = useCallback((command: string, value?: string) => {
    const element = surfaceRef.current;
    if (!element || readOnly || typeof document.execCommand !== "function") return;
    element.focus();
    document.execCommand(command, false, value);
    emit();
    syncMarks();
  }, [emit, readOnly, syncMarks]);

  return (
    <div className="de-panel">
      <div className="de-toolbar" role="toolbar" aria-label="Formatting">
        {TOOL_GROUPS.map((group, groupIndex) => (
          <span className="de-group" key={group.map((tool) => tool.key).join("-")}>
            {groupIndex > 0 && <span className="de-tool-divider" aria-hidden="true" />}
            {group.map((tool) => (
              <button
                key={tool.key}
                type="button"
                className="de-tool"
                title={tool.title}
                aria-label={tool.title}
                aria-pressed={tool.active ? Boolean(marks[tool.active] || block === tool.active) : false}
                disabled={readOnly}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run(tool.command, tool.value)}
              >
                {tool.label}
              </button>
            ))}
          </span>
        ))}
        <span className="de-group">
          <span className="de-tool-divider" aria-hidden="true" />
          <button
            type="button"
            className="de-tool"
            title="Insert table"
            aria-label="Insert table"
            disabled={readOnly}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run("insertHTML", `<table><tbody><tr>${"<th><br></th>".repeat(3)}</tr><tr>${"<td><br></td>".repeat(3)}</tr><tr>${"<td><br></td>".repeat(3)}</tr></tbody></table><p><br></p>`)}
          >
            ⊞
          </button>
          <button type="button" className="de-tool" title="Horizontal rule" aria-label="Horizontal rule" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => run("insertHorizontalRule")}>―</button>
          <button type="button" className="de-tool" title="Clear formatting" aria-label="Clear formatting" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => run("removeFormat")}>Tx</button>
        </span>
        {inTable && (
          <span className="de-group">
            <span className="de-tool-divider" aria-hidden="true" />
            <button type="button" className="de-tool" title="Add row" aria-label="Add row" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => run("insertRowBelow")}>⊟+</button>
            <button type="button" className="de-tool" title="Add column" aria-label="Add column" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => run("insertColumnRight")}>⊞+</button>
            <button type="button" className="de-tool" title="Delete row" aria-label="Delete row" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => run("deleteRow")}>⊟×</button>
            <button type="button" className="de-tool" title="Delete column" aria-label="Delete column" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => run("deleteColumn")}>⊞×</button>
            <button type="button" className="de-tool" title="Delete table" aria-label="Delete table" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => run("deleteTable")}>⊞✕</button>
          </span>
        )}
      </div>
      <div
        ref={surfaceRef}
        className="de-surface"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-label="Document body"
        aria-multiline="true"
        spellCheck
        onInput={emit}
      />
    </div>
  );
}

function AssistPanel({ handle, documentId }: { handle: SurfaceHandle | null; documentId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; label: string } | null>(null);
  const [language, setLanguage] = useState(LANGUAGES[0] ?? "English");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  async function run(body: Record<string, unknown>, label: string) {
    setBusy(true);
    setError(null);
    try {
      const assist = await requestAssist(body);
      setResult({ text: assist.text, label });
    } catch (assistError) {
      setError(readableError(assistError));
    } finally {
      setBusy(false);
    }
  }

  function rewrite(action: string) {
    const facts = selectionFacts(handle?.element ?? null);
    if (!facts.text.trim()) {
      setError("Select some text first, then pick an action.");
      return;
    }
    void run({ kind: "selection", action, text: facts.text, language }, `Rewrite (${action})`);
  }

  function continueDrafting() {
    const facts = selectionFacts(handle?.element ?? null);
    void run({ kind: "continue", before: facts.before.slice(-1_500) }, "Continue drafting");
  }

  async function ask() {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const assist = await requestAssist({ kind: "chat", documentId, question });
      setAnswer(assist.text);
    } catch (assistError) {
      setError(readableError(assistError));
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!handle || !result) return;
    if (typeof document.execCommand === "function") {
      handle.element.focus();
      document.execCommand("insertText", false, result.text);
      handle.emit();
    }
    setResult(null);
  }

  return (
    <div className="de-panel de-assist" aria-label="Writing assist">
      <h2>Writing assist</h2>
      <p>Suggestions never touch the document on their own: review, then Apply.</p>
      <div className="de-assist-actions">
        {(["improve", "grammar", "tone", "shorten", "expand", "translate"] as const).map((action) => (
          <button key={action} type="button" className="de-button" disabled={busy} onClick={() => rewrite(action)}>
            {action[0]!.toUpperCase()}{action.slice(1)}
          </button>
        ))}
      </div>
      <label className="de-assist-language">
        Translation language
        <select className="de-select" aria-label="Translation language" value={language} onChange={(event) => setLanguage(event.target.value)}>
          {LANGUAGES.map((value) => <option key={value}>{value}</option>)}
        </select>
      </label>
      <button type="button" className="de-button" disabled={busy} onClick={continueDrafting}>Continue drafting from cursor</button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div className="de-assist-result">
          <p><strong>{result.label}</strong></p>
          <p>{result.text}</p>
          <div className="de-actions">
            <button type="button" className="de-button de-button-primary" onClick={apply}>Apply</button>
            <button type="button" className="de-button de-button-ghost" onClick={() => setResult(null)}>Dismiss</button>
          </div>
        </div>
      )}
      <div className="de-assist-chat">
        <h3>Ask this document</h3>
        <textarea className="de-textarea" rows={2} value={question} placeholder="What does this document commit us to?" onChange={(event) => setQuestion(event.target.value)} />
        <button type="button" className="de-button" disabled={busy} onClick={() => void ask()}>Ask</button>
        {answer && (
          <div className="de-assist-answer">
            <p>{answer}</p>
            <button type="button" className="de-button de-button-ghost" onClick={() => setAnswer(null)}>Clear</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function DocumentsEditorPage({ documentId }: { documentId?: string }) {
  const resolvedId = documentId ?? documentsEditorIdFromPath(window.location.pathname);
  const [retry, setRetry] = useState(0);
  const [boot, setBoot] = useState<BootState>({ status: "loading" });
  const [seed, setSeed] = useState<{ key: number; html: string }>({ key: 0, html: "" });
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [others, setOthers] = useState<PresenceUser[]>([]);
  const [lockHolder, setLockHolder] = useState<string | null>(null);
  const [pageSettings, setPageSettings] = useState<PageSettings>(DEFAULT_PAGE_SETTINGS);
  const [mobileView, setMobileView] = useState<"edit" | "preview">("edit");
  const [aiOpen, setAiOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [publishBusy, setPublishBusy] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [compare, setCompare] = useState<CompareState>(null);
  const [busy, setBusy] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [printHtml, setPrintHtml] = useState("");

  const contentRef = useRef<Record<string, unknown>>({ type: "doc", content: [] });
  const contentHtmlRef = useRef("");
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const revRef = useRef<number | undefined>(undefined);
  const lockRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceRef = useRef<SurfaceHandle | null>(null);
  const settingsRef = useRef<PageSettings>(pageSettings);
  settingsRef.current = pageSettings;
  const ready = boot.status === "ready";
  const documentType = ready ? boot.document.documentType ?? null : null;
  const folder = ready ? boot.document.folder ?? null : null;
  const linkedRecordLabel = ready ? boot.document.linkedRecordLabel ?? null : null;

  const registerSurface = useCallback((handle: SurfaceHandle) => {
    surfaceRef.current = handle;
  }, []);

  // Print and preview share one refinement pass, on a detached print surface
  // so the paper size never depends on the screen layout.
  useEffect(() => {
    const surface = document.createElement("div");
    surface.className = "de-print-only";
    surface.dataset.size = pageSettings.size;
    surface.dataset.orientation = pageSettings.orientation;
    surface.dataset.margin = pageSettings.margin;
    if (documentType) surface.dataset.docType = documentType;
    surface.innerHTML = printHtml;
    const settings = document.createElement("style");
    settings.media = "print";
    settings.textContent = `@page { size: ${pageSettings.size} ${pageSettings.orientation}; margin: 0; }`;
    document.body.append(settings, surface);
    return () => {
      settings.remove();
      surface.remove();
    };
  }, [documentType, pageSettings, printHtml]);

  useEffect(() => {
    if (!resolvedId) return;
    let alive = true;
    const controller = new AbortController();
    setBoot({ status: "loading" });
    void (async () => {
      try {
        const [payload, workspace] = await Promise.all([
          fetchEditorDocument(resolvedId, controller.signal),
          postEditorWorkspace(resolvedId, {}, controller.signal),
        ]);
        if (!alive || controller.signal.aborted) return;
        if (!payload.document) {
          setBoot({ status: "failed", message: "Document not found. It may have been deleted; head back to Documents." });
          return;
        }
        const candidate = workspace.draft;
        const draft = candidate && Object.keys(candidate.content).length > 0 ? candidate : null;
        const initial = draft ? draft.content : payload.document.content;
        if (draft) revRef.current = draft.rev;
        contentRef.current = initial;
        const html = documentJsonToHtml(initial) || sanitizeDocumentHtml(payload.document.html);
        contentHtmlRef.current = html;
        const paper = refineDocumentHtml(html);
        setPreviewHtml(paper);
        setPrintHtml(paper);
        setSeed((current) => ({ key: current.key + 1, html }));
        setTitle(payload.document.title);
        setVersions(payload.versions);
        setPageSettings(draft?.pageSettings ?? payload.document.pageSettings);
        setLockHolder(workspace.lock && !workspace.lock.mine ? workspace.lock.heldBy : null);
        setOthers(workspace.others);
        setBoot({ status: "ready", document: payload.document, versions: payload.versions });
      } catch (error) {
        if (!alive || controller.signal.aborted) return;
        setBoot({ status: "failed", message: readableError(error) });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [resolvedId, retry]);

  const saveDraft = useCallback(async (json: Record<string, unknown>, settings: PageSettings = settingsRef.current) => {
    if (!resolvedId || lockRef.current) return;
    setSaveState("saving");
    try {
      const tick = await postEditorWorkspace(resolvedId, { content: json, pageSettings: settings, rev: revRef.current });
      if (tick.conflict) {
        setSaveState("conflict");
        return;
      }
      if (tick.savedRev) revRef.current = tick.savedRev;
      pendingRef.current = null;
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, [resolvedId]);

  const onDocChange = useCallback((json: Record<string, unknown>, html: string) => {
    contentRef.current = json;
    contentHtmlRef.current = html;
    pendingRef.current = json;
    const paper = refineDocumentHtml(html);
    setPreviewHtml(paper);
    setPrintHtml(paper);
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const queued = pendingRef.current;
      if (queued) void saveDraft(queued);
    }, 800);
  }, [saveDraft]);

  // Page geometry is part of the draft, so a settings change saves too.
  useEffect(() => {
    if (!ready) return;
    const json = contentRef.current;
    pendingRef.current = json;
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveDraft(json, pageSettings), 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
  }, [ready, pageSettings, saveDraft]);

  // Presence heartbeat and lock observation.
  useEffect(() => {
    if (!ready || !resolvedId) return;
    const tick = window.setInterval(() => {
      void (async () => {
        try {
          const result = await postEditorWorkspace(resolvedId, pendingRef.current
            ? { content: pendingRef.current, pageSettings, rev: revRef.current }
            : {});
          if (result.conflict) {
            setSaveState("conflict");
            return;
          }
          if (pendingRef.current && result.savedRev) {
            revRef.current = result.savedRev;
            pendingRef.current = null;
            setSaveState("saved");
          }
          const holder = result.lock && !result.lock.mine ? result.lock.heldBy : null;
          lockRef.current = holder;
          setLockHolder(holder);
          setOthers(result.others);
        } catch {
          // A missed heartbeat is not worth interrupting the writer for.
        }
      })();
    }, 10_000);
    return () => window.clearInterval(tick);
  }, [ready, resolvedId, pageSettings]);

  useEffect(() => {
    const previous = document.title;
    if (title) document.title = `${title} | Chaste Business OS`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  // Release presence and the soft lock on exit.
  useEffect(() => {
    if (!resolvedId) return;
    const release = (): void => releaseEditorWorkspace(resolvedId);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [resolvedId]);

  useEffect(() => {
    if (lockHolder) lockRef.current = lockHolder;
  }, [lockHolder]);

  async function rename() {
    if (!resolvedId) return;
    const next = title.trim() || "Untitled document";
    try {
      const outcome = await updateDocumentMetadata(resolvedId, { title: next });
      setNotice(outcome.kind === "pending"
        ? { tone: "pending", text: "Rename proposed: the workmate's change waits for approval." }
        : { tone: "success", text: `Saved as "${next}".` });
    } catch (error) {
      setNotice({ tone: "error", text: readableError(error) });
    }
  }

  async function publish() {
    if (!resolvedId) return;
    setPublishBusy(true);
    try {
      const outcome = await publishDocumentVersion(resolvedId, {
        title: title.trim() || "Untitled document",
        content: contentRef.current,
        html: contentHtmlRef.current,
        pageSettings,
        ...(publishNote.trim() ? { note: publishNote.trim() } : {}),
      });
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", text: "Publish proposed: the workmate's version waits for approval." });
      } else {
        setNotice({ tone: "success", text: `Version ${outcome.data.version} published.` });
        const fresh = await fetchEditorDocument(resolvedId);
        setVersions(fresh.versions);
        revRef.current = undefined;
      }
      setPublishOpen(false);
      setPublishNote("");
    } catch (error) {
      setNotice({ tone: "error", text: readableError(error) });
    } finally {
      setPublishBusy(false);
    }
  }

  async function restore(version: number) {
    if (!resolvedId) return;
    setBusy(true);
    try {
      const outcome = await restoreDocumentVersion(resolvedId, version);
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", text: `Restoring version ${version} was proposed and waits for approval.` });
        return;
      }
      setNotice({ tone: "success", text: `Restored from version ${version} as version ${outcome.data.version}.` });
      const fresh = await fetchEditorDocument(resolvedId);
      if (fresh.document) {
        setVersions(fresh.versions);
        contentRef.current = fresh.document.content;
        const html = documentJsonToHtml(fresh.document.content);
        contentHtmlRef.current = html;
        const paper = refineDocumentHtml(html);
        setPreviewHtml(paper);
        setPrintHtml(paper);
        setSeed((current) => ({ key: current.key + 1, html }));
        revRef.current = undefined;
      }
    } catch (error) {
      setNotice({ tone: "error", text: readableError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function compareVersions(a: number, b: number) {
    if (!resolvedId) return;
    setBusy(true);
    try {
      const [older, newer] = await Promise.all([fetchArchivedVersion(resolvedId, a), fetchArchivedVersion(resolvedId, b)]);
      setCompare({ a: sanitizeDocumentHtml(older.html), b: sanitizeDocumentHtml(newer.html), aV: a, bV: b });
    } catch (error) {
      setNotice({ tone: "error", text: readableError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function saveAsTemplate() {
    const name = templateName.trim();
    if (!name || !resolvedId) return;
    setBusy(true);
    try {
      const outcome = await createDocumentTemplate(name, contentRef.current);
      setNotice(outcome.kind === "pending"
        ? { tone: "pending", text: `Template "${name}" was proposed and waits for approval.` }
        : { tone: "success", text: `Template "${name}" saved.` });
      setTemplateOpen(false);
      setTemplateName("");
    } catch (error) {
      setNotice({ tone: "error", text: readableError(error) });
    } finally {
      setBusy(false);
    }
  }

  function printNow() {
    setPrintHtml(refineDocumentHtml(contentHtmlRef.current));
    requestAnimationFrame(() => window.print());
  }

  if (!resolvedId) {
    return (
      <section className="de-failure">
        <h2>No document to edit</h2>
        <p>Open a document from the library to start writing.</p>
        <a href="/documents">Back to documents</a>
      </section>
    );
  }

  if (boot.status === "failed") {
    return (
      <section className="de-failure" role="alert">
        <h2>Could not open this document</h2>
        <p>{boot.message}</p>
        <div className="de-actions">
          <button type="button" className="de-button de-button-primary" onClick={() => setRetry((current) => current + 1)}>Try again</button>
          <a className="de-button" href="/documents">Back to documents</a>
        </div>
      </section>
    );
  }

  if (boot.status === "loading") {
    return <p className="auth-wait" role="status">Opening the document…</p>;
  }

  return (
    <>
      <style>{EDITOR_STYLES}</style>
      <div className="de-page">
        <div className="de-header">
          <div className="de-header-row">
            <a className="de-back" href="/documents">← Documents</a>
            <input
              className="de-title"
              value={title}
              aria-label="Document title"
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void rename()}
            />
            {folder && <span className="de-chip">{folder}</span>}
            {linkedRecordLabel && <span className="de-chip" title={linkedRecordLabel}>Source: {linkedRecordLabel}</span>}
            {others.length > 0 && (
              <span className="de-presence">
                {others.map((person) => <span key={person.userId}>{person.name}</span>)}
              </span>
            )}
            {saveState !== "idle" && (
              <span role="status" aria-live="polite" className={`de-save de-save-${saveState}`}>
                {saveState === "error" ? (
                  <button
                    type="button"
                    className="de-save-retry"
                    onClick={() => void saveDraft(contentRef.current)}
                  >
                    {SAVE_LABELS[saveState]}
                  </button>
                ) : SAVE_LABELS[saveState]}
              </span>
            )}
          </div>
          <div className="de-header-row">
            <div className="de-group">
              <select className="de-select" aria-label="Page size" value={pageSettings.size} onChange={(event) => setPageSettings((value) => ({ ...value, size: event.target.value as PageSettings["size"] }))}>
                <option>A4</option>
                <option>Letter</option>
              </select>
              <select className="de-select" aria-label="Page orientation" value={pageSettings.orientation} onChange={(event) => setPageSettings((value) => ({ ...value, orientation: event.target.value as PageSettings["orientation"] }))}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
              <select className="de-select" aria-label="Page margins" value={pageSettings.margin} onChange={(event) => setPageSettings((value) => ({ ...value, margin: event.target.value as PageSettings["margin"] }))}>
                <option value="compact">Compact margins</option>
                <option value="normal">Normal margins</option>
                <option value="wide">Wide margins</option>
              </select>
            </div>
            <div className="de-actions">
              <button type="button" className="de-button de-button-primary" disabled={publishBusy} onClick={() => setPublishOpen(true)}>Publish version</button>
              <button type="button" className="de-button de-button-ghost" onClick={printNow}>Print / PDF</button>
              <button type="button" className="de-button de-button-ghost" onClick={() => setVersionsOpen(true)}>Versions {versions.length > 0 ? `(${versions.length})` : ""}</button>
              <button type="button" className="de-button de-button-ghost" onClick={() => setTemplateOpen(true)}>Save as template</button>
              <button type="button" className="de-button de-button-ghost" onClick={() => downloadDocx(title.trim() || "Untitled document", contentRef.current)}>.docx</button>
              <button type="button" className="de-button de-button-ghost" aria-pressed={aiOpen} onClick={() => setAiOpen((value) => !value)}>Assist</button>
            </div>
          </div>
          {lockHolder && (
            <div className="de-lock">
              <p role="status">{lockHolder} is editing right now. You can read along; saving resumes when the pen is free.</p>
            </div>
          )}
        </div>

        <div className="de-body">
          <div className="de-view-switch" role="tablist" aria-label="Editor view">
            <button type="button" role="tab" aria-selected={mobileView === "edit"} onClick={() => setMobileView("edit")}>Edit</button>
            <button type="button" role="tab" aria-selected={mobileView === "preview"} onClick={() => setMobileView("preview")}>Preview</button>
          </div>
          <div className={`de-workbench${aiOpen ? " is-assisted" : ""}`}>
            <div className={mobileView === "preview" ? "de-mobile-hidden" : undefined}>
              {notice && <ActionNotice notice={notice} onDismiss={() => setNotice(null)} />}
              <DocumentSurface
                seedKey={seed.key}
                seedHtml={seed.html}
                readOnly={Boolean(lockHolder)}
                onChange={onDocChange}
                onReady={registerSurface}
              />
            </div>
            <aside className={`de-panel${mobileView === "edit" ? " de-mobile-hidden" : ""}`} aria-label="Live document preview">
              <div className="de-preview-bar">
                <span>Live preview</span>
                <span>{pageSettings.size} | {pageSettings.orientation}</span>
              </div>
              <div className="de-preview-stage">
                <article
                  className="de-paper"
                  data-size={pageSettings.size}
                  data-orientation={pageSettings.orientation}
                  data-margin={pageSettings.margin}
                  data-doc-type={documentType ?? undefined}
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            </aside>
            {aiOpen && <AssistPanel handle={surfaceRef.current} documentId={resolvedId} />}
          </div>
        </div>

        {publishOpen && (
          <div className="de-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPublishOpen(false); }}>
            <section className="de-dialog" role="dialog" aria-modal="true" aria-labelledby="de-publish-title">
              <button type="button" className="de-dialog-close" aria-label="Close publish dialog" onClick={() => setPublishOpen(false)}>×</button>
              <h2 id="de-publish-title">Publish a version</h2>
              <p>Publishing snapshots the current content into append-only history. Earlier versions stay comparable and restorable forever.</p>
              <label htmlFor="de-publish-note">Version note (optional)</label>
              <input id="de-publish-note" className="de-input" value={publishNote} placeholder="Added payment terms section" onChange={(event) => setPublishNote(event.target.value)} />
              <footer>
                <button type="button" className="de-button" onClick={() => setPublishOpen(false)}>Cancel</button>
                <button type="button" className="de-button de-button-primary" disabled={publishBusy} onClick={() => void publish()}>Publish</button>
              </footer>
            </section>
          </div>
        )}

        {templateOpen && (
          <div className="de-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemplateOpen(false); }}>
            <section className="de-dialog" role="dialog" aria-modal="true" aria-labelledby="de-template-title">
              <button type="button" className="de-dialog-close" aria-label="Close template dialog" onClick={() => setTemplateOpen(false)}>×</button>
              <h2 id="de-template-title">Save as template</h2>
              <p>Reuse this document as a starting point. Wrap any reusable value in double braces, like <code>{"{{customer.name}}"}</code>, and it becomes a fill-in field.</p>
              <label htmlFor="de-template-name">Template name</label>
              <input id="de-template-name" className="de-input" value={templateName} placeholder="Service quote" onChange={(event) => setTemplateName(event.target.value)} />
              <footer>
                <button type="button" className="de-button" onClick={() => setTemplateOpen(false)}>Cancel</button>
                <button type="button" className="de-button de-button-primary" disabled={busy || !templateName.trim()} onClick={() => void saveAsTemplate()}>Save template</button>
              </footer>
            </section>
          </div>
        )}

        {versionsOpen && (
          <div className="de-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setVersionsOpen(false); }}>
            <section className="de-dialog" role="dialog" aria-modal="true" aria-labelledby="de-versions-title">
              <button type="button" className="de-dialog-close" aria-label="Close version history" onClick={() => setVersionsOpen(false)}>×</button>
              <h2 id="de-versions-title">Version history</h2>
              {versions.length === 0 ? (
                <p>No published versions yet. Publish to start the history.</p>
              ) : (
                <ul className="de-versions">
                  {versions.map((version, index) => {
                    const previous = index > 0 ? versions[index - 1] : undefined;
                    return (
                    <li key={version.version}>
                      <span className="de-version-number">v{version.version}</span>
                      <span className="de-version-copy">
                        <span>{version.note ?? "(no note)"}</span>
                        <span className="de-version-meta">
                          {timeAgo(version.createdAt)}
                          {version.createdBy ? ` · ${version.createdBy.slice(0, 8)}` : ""}
                        </span>
                      </span>
                      {previous && (
                        <button type="button" className="de-button de-button-ghost" disabled={busy} onClick={() => void compareVersions(previous.version, version.version)}>Compare</button>
                      )}
                      <button type="button" className="de-button" disabled={busy} onClick={() => void restore(version.version)}>Restore</button>
                    </li>
                    );
                  })}
                </ul>
              )}
              <p>Restoring never deletes: the current content is archived first, and the restored copy becomes a new version.</p>
            </section>
          </div>
        )}

        {compare && (
          <div className="de-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCompare(null); }}>
            <section className="de-dialog" role="dialog" aria-modal="true" aria-labelledby="de-compare-title">
              <button type="button" className="de-dialog-close" aria-label="Close compare" onClick={() => setCompare(null)}>×</button>
              <h2 id="de-compare-title">Compare v{compare.aV} vs v{compare.bV}</h2>
              <div className="de-compare">
                <div>
                  <p className="de-compare-label">v{compare.aV} (older)</p>
                  <div className="de-compare-body" dangerouslySetInnerHTML={{ __html: compare.a }} />
                </div>
                <div>
                  <p className="de-compare-label">v{compare.bV} (newer)</p>
                  <div className="de-compare-body" dangerouslySetInnerHTML={{ __html: compare.b }} />
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
