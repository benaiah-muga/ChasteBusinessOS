"use client";

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { lintText, type WritingLint } from "@/lib/harper";

/**
 * Harper spell/grammar underlines for the Tiptap editor (Phase 4).
 * Debounced ~400ms: the document's text is mirrored to a plain string,
 * linted in the harper.js worker, and the word offsets are mapped back to
 * ProseMirror positions for inline decorations. The popover (apply /
 * ignore / add to dictionary) lives in the React layer; this extension
 * exposes the plugin key so the editor can ask "is there a lint under the
 * cursor?" and re-lint after dictionary changes.
 */

export interface HarperActiveLint {
  from: number;
  to: number;
  word: string;
  suggestions: string[];
}

interface TextSegment {
  from: number;
  mirrorStart: number;
  length: number;
}

interface HarperState {
  decorations: DecorationSet;
  lints: Array<{ from: number; to: number; lint: WritingLint }>;
}

export const harperKey = new PluginKey<HarperState>("harperWritingAids");

const DEBOUNCE_MS = 400;

function buildMirror(doc: PMNode): { text: string; segments: TextSegment[] } {
  let text = "";
  const segments: TextSegment[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      segments.push({ from: pos, mirrorStart: text.length, length: node.text.length });
      text += node.text;
    } else if (node.isBlock && text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
    }
    return true;
  });
  return { text, segments };
}

function mirrorToDocRange(segments: TextSegment[], start: number, end: number): { from: number; to: number } | null {
  let from: number | null = null;
  let to: number | null = null;
  for (const seg of segments) {
    const segEnd = seg.mirrorStart + seg.length;
    if (start >= seg.mirrorStart && start < segEnd) from = seg.from + (start - seg.mirrorStart);
    if (end > seg.mirrorStart && end <= segEnd) to = seg.from + (end - seg.mirrorStart);
    if (from !== null && to !== null) break;
  }
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}

export const HarperExtension = Extension.create<{ enabled: boolean }>({
  name: "harperWritingAids",

  addOptions() {
    return { enabled: true };
  },

  addProseMirrorPlugins() {
    const enabled = () => this.options.enabled;

    return [
      new Plugin<HarperState>({
        key: harperKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty, lints: [] }),
          apply: (tr, old) => {
            if (!tr.docChanged) return old;
            // Map existing decorations through the change so underlines
            // stay anchored while typing, then refresh after the debounce.
            return { decorations: old.decorations.map(tr.mapping, tr.doc), lints: old.lints };
          },
        },
        props: {
          decorations(state) {
            return harperKey.getState(state)?.decorations;
          },
        },
        view(editorView) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          let run = 0;

          const schedule = () => {
            if (!enabled()) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
          };

          const refresh = async () => {
            if (!enabled()) return;
            const current = ++run;
            const { text, segments } = buildMirror(editorView.state.doc);
            if (!text.trim()) return;
            const lints = await lintText(text);
            if (current !== run) return;
            const decorations: Decoration[] = [];
            const mapped: Array<{ from: number; to: number; lint: WritingLint }> = [];
            for (const lint of lints) {
              const range = mirrorToDocRange(segments, lint.start, lint.end);
              if (!range) continue;
              decorations.push(Decoration.inline(range.from, range.to, { class: "harper-underline", "aria-label": "possible spelling or grammar issue" }));
              mapped.push({ ...range, lint });
            }
            const tr = editorView.state.tr.setMeta(harperKey, {
              decorations: DecorationSet.create(editorView.state.doc, decorations),
              lints: mapped,
            });
            editorView.dispatch(tr);
          };

          const handler = () => schedule();

          editorView.dom.addEventListener("paste", handler);
          schedule();
          return {
            update: (view, prevState) => {
              // Selection-only transactions skip the linter; doc changes reschedule.
              if (!view.state.doc.eq(prevState.doc)) schedule();
            },
            destroy: () => {
              if (timer) clearTimeout(timer);
              editorView.dom.removeEventListener("paste", handler);
            },
          };
        },
      }),
    ];
  },
});

/** The lint under (or immediately before) the given position, if any. */
export function lintAt(state: EditorState, pos: number): HarperActiveLint | null {
  const harper = harperKey.getState(state);
  if (!harper) return null;
  for (const { from, to, lint } of harper.lints) {
    if (pos >= from && pos <= to) {
      return { from, to, word: lint.problemText, suggestions: lint.suggestions };
    }
  }
  return null;
}

/** Re-run the linter now (after apply / add-to-dictionary). */
export function requestHarperRefresh(editor: { view: EditorView }): void {
  // A no-op metadata transaction nudges the plugin view's update hook,
  // which reschedules the debounced lint.
  editor.view.dispatch(editor.view.state.tr.setMeta("harper-refresh", 1));
}
