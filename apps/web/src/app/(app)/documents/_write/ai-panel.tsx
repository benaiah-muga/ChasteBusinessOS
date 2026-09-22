"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui";
import { postApi } from "@/lib/api";

/**
 * AI writing assist panel (Phase 4): selection rewrites, continue-drafting
 * and grounded chat about the document. The model only ever returns text;
 * the writer decides what lands in the document - nothing is inserted
 * without an explicit Apply.
 */

interface AssistResult {
  text: string;
  label: string;
  /** Insert at cursor (continue) or replace selection (rewrite). */
  mode: "replace" | "insert";
}

const LANGUAGES = ["English", "Swahili", "French", "Arabic", "Luganda", "Amharic"];

export function AiAssistPanel({ editor, documentId }: { editor: Editor | null; documentId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssistResult | null>(null);
  const [language, setLanguage] = useState(LANGUAGES[0]!);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  async function run(body: Record<string, unknown>, label: string, mode: AssistResult["mode"]) {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      const res = await postApi<{ ok?: boolean; text?: string }>("/api/docs/assist", body);
      if (!res.ok || !res.data?.text) setError(res.error?.title ?? "The assistant could not help with that, try again.");
      else setResult({ text: res.data.text, label, mode });
    } finally {
      setBusy(false);
    }
  }

  async function rewrite(action: string) {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, "\n");
    if (!text.trim()) {
      setError("Select some text first, then pick an action.");
      return;
    }
    await run({ kind: "selection", action, text, language }, `Rewrite (${action})`, "replace");
  }

  async function continueDrafting() {
    if (!editor) return;
    const pos = editor.state.selection.from;
    const before = editor.state.doc.textBetween(0, pos, "\n").slice(-1_500);
    await run({ kind: "continue", before }, "Continue drafting", "insert");
  }

  async function ask() {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await postApi<{ ok?: boolean; text?: string }>("/api/docs/assist", {
        kind: "chat",
        documentId,
        question,
      });
      if (!res.ok || !res.data?.text) setError(res.error?.title ?? "The assistant could not answer that.");
      else setAnswer(res.data.text);
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!editor || !result) return;
    const chain = editor.chain().focus();
    if (result.mode === "replace" && !editor.state.selection.empty) {
      chain.insertContentAt(editor.state.selection, result.text).run();
    } else {
      chain.insertContent(result.text).run();
    }
    setResult(null);
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <p className="figure-label">Writing assist</p>
      <p className="text-xs leading-relaxed text-stone-500">
        Suggestions never touch the document on their own: review, then Apply.
      </p>

      <div className="grid grid-cols-2 gap-1.5">
        <Button tone="secondary" size="sm" loading={busy} onClick={() => rewrite("improve")}>
          Improve
        </Button>
        <Button tone="secondary" size="sm" loading={busy} onClick={() => rewrite("grammar")}>
          Grammar
        </Button>
        <Button tone="secondary" size="sm" loading={busy} onClick={() => rewrite("tone")}>
          Tone
        </Button>
        <Button tone="secondary" size="sm" loading={busy} onClick={() => rewrite("shorten")}>
          Shorten
        </Button>
        <Button tone="secondary" size="sm" loading={busy} onClick={() => rewrite("expand")}>
          Expand
        </Button>
        <Button tone="secondary" size="sm" loading={busy} onClick={() => rewrite("translate")}>
          Translate
        </Button>
      </div>
      <select
        aria-label="Translation language"
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
        className="select text-xs"
      >
        {LANGUAGES.map((l) => (
          <option key={l}>{l}</option>
        ))}
      </select>

      <Button tone="secondary" size="sm" loading={busy} onClick={continueDrafting}>
        Continue drafting from cursor
      </Button>

      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      {result && (
        <div className="rounded-lg border border-gold-200 bg-gold-50/60 p-3">
          <p className="mb-1 text-xs font-semibold text-gold-900">{result.label}</p>
          <p className="max-h-48 overflow-y-auto text-sm whitespace-pre-wrap text-stone-800">{result.text}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={apply}>
              Apply
            </Button>
            <Button tone="ghost" size="sm" onClick={() => setResult(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="mt-auto border-t border-stone-100 pt-3">
        <p className="figure-label mb-2">Ask this document</p>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="What does this document commit us to?"
          className="textarea w-full resize-none text-xs"
        />
        <Button className="mt-2 w-full" tone="secondary" size="sm" loading={busy} onClick={ask}>
          Ask
        </Button>
        {answer && (
          <div className="mt-2 rounded-lg bg-stone-50 p-3">
            <p className="text-sm whitespace-pre-wrap text-stone-700">{answer}</p>
            <Button tone="ghost" size="sm" className="mt-1" onClick={() => setAnswer(null)}>
              Clear
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
