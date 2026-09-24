"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { HarperExtension, lintAt, requestHarperRefresh, type HarperActiveLint } from "./harper-extension";
import { addToUserDictionary } from "@/lib/harper";
import { cn } from "@/lib/format";

/**
 * Rich text editor (Phase 4): Tiptap with headings, lists, tables and
 * images, plus optional Harper spell-check underlines with an apply /
 * ignore / add-to-dictionary popover. The parent owns persistence; this
 * component owns the document surface.
 */

const IMAGE_MAX_BYTES = 1_000_000;

interface ToolbarProps {
  editor: Editor;
}

function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active ?? false}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-7 cursor-pointer items-center justify-center rounded px-1.5 text-xs font-semibold transition-colors",
        active ? "bg-gold-100 text-gold-900" : "text-stone-600 hover:bg-stone-100",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-stone-200" aria-hidden />;
}

function Toolbar({ editor, onImageFile }: ToolbarProps & { onImageFile: (f: File) => void }) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-stone-200 px-2 py-1.5">
      <ToolButton title="Undo" onClick={() => editor.chain().focus().undo().run()}>
        ↺
      </ToolButton>
      <ToolButton title="Redo" onClick={() => editor.chain().focus().redo().run()}>
        ↻
      </ToolButton>
      <Divider />
      {[1, 2, 3].map((level) => (
        <ToolButton
          key={level}
          title={`Heading ${level}`}
          active={editor.isActive("heading", { level })}
          onClick={() => editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 }).run()}
        >
          H{level}
        </ToolButton>
      ))}
      <ToolButton title="Paragraph" active={editor.isActive("paragraph")} onClick={() => editor.chain().focus().setParagraph().run()}>
        ¶
      </ToolButton>
      <Divider />
      <ToolButton title="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        B
      </ToolButton>
      <ToolButton
        title="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <span className="italic">I</span>
      </ToolButton>
      <ToolButton title="Underline" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <span className="underline">U</span>
      </ToolButton>
      <ToolButton
        title="Strikethrough"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <span className="line-through">S</span>
      </ToolButton>
      <ToolButton title="Code" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
        {"</>"}
      </ToolButton>
      <Divider />
      <ToolButton
        title="Bullet list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        •≡
      </ToolButton>
      <ToolButton
        title="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1≡
      </ToolButton>
      <ToolButton
        title="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        ❝
      </ToolButton>
      <Divider />
      <ToolButton
        title="Insert table"
        active={editor.isActive("table")}
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        ⊞
      </ToolButton>
      <ToolButton title="Insert image" onClick={() => imageInputRef.current?.click()}>
        ▣
      </ToolButton>
      <ToolButton title="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        ―
      </ToolButton>
      <ToolButton title="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
        Tx
      </ToolButton>
      {editor.isActive("table") && (
        <>
          <Divider />
          <ToolButton title="Add column" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            ⊞+
          </ToolButton>
          <ToolButton title="Add row" onClick={() => editor.chain().focus().addRowAfter().run()}>
            ⊟+
          </ToolButton>
          <ToolButton title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
            ⊞✕
          </ToolButton>
        </>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        aria-label="Insert image"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImageFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export interface TiptapEditorProps {
  initialContent: Record<string, unknown>;
  harperEnabled: boolean;
  /** Fires on every content change with the serializable snapshot. */
  onDocChange: (json: Record<string, unknown>, html: string) => void;
  onReady?: (editor: Editor) => void;
}

export function TiptapEditor({ initialContent, harperEnabled, onDocChange, onReady }: TiptapEditorProps) {
  const [activeLint, setActiveLint] = useState<HarperActiveLint | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const lintAnchor = useRef<{ top: number; left: number }>({ top: 0, left: 0 });

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: false, allowBase64: true }),
      HarperExtension.configure({ enabled: harperEnabled }),
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: "tiptap-focus min-h-[55vh] outline-none prose-sm prose-stone max-w-none px-6 py-5 sm:px-10",
      },
      handleClickOn: (view, pos) => {
        const lint = lintAt(view.state, pos);
        if (lint) {
          const coords = view.coordsAtPos(pos);
          const rect = view.dom.getBoundingClientRect();
          lintAnchor.current = { top: coords.bottom - rect.top + 4, left: coords.left - rect.left };
        }
        setActiveLint(lint);
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      onDocChange(e.getJSON() as Record<string, unknown>, e.getHTML());
    },
  });

  useEffect(() => {
    if (editor && onReady) onReady(editor);
    // onReady must fire exactly once when the editor mounts.
  }, [editor]);

  const insertImage = useCallback(
    (f: File) => {
      if (!editor || !f.type.startsWith("image/") || f.size > IMAGE_MAX_BYTES) {
        setImageError("That image was not inserted. Choose a PNG, JPEG, GIF, or WebP file smaller than 1 MB.");
        return;
      }
      setImageError(null);
      const reader = new FileReader();
      reader.onload = () => editor.chain().focus().setImage({ src: String(reader.result) }).run();
      reader.readAsDataURL(f);
    },
    [editor],
  );

  if (!editor) return <div className="min-h-[55vh] animate-pulse bg-stone-50" aria-busy />;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-stone-200 bg-stone-100 p-2 shadow-xs sm:p-3">
      {imageError && <p role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{imageError}</p>}
      <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <Toolbar editor={editor} onImageFile={insertImage} />
        <div className="mx-auto min-h-[55vh] max-w-4xl bg-white">
          <EditorContent
            editor={editor}
            onClick={() => {
              // Popover closes on any click that did not land on a lint.
              setActiveLint(null);
            }}
          />
        </div>
      </div>
      {harperEnabled && activeLint && (
        <div
          className="absolute z-20 w-56 rounded-lg border border-stone-200 bg-white p-2 shadow-lg"
          style={lintAnchor.current}
          role="menu"
          aria-label="Spelling suggestions"
        >
          <p className="mb-1 px-1 text-xs font-medium text-stone-500">{activeLint.word}</p>
          {activeLint.suggestions.length > 0 ? (
            activeLint.suggestions.map((s) => (
              <button
                key={s}
                type="button"
                role="menuitem"
                className="block w-full cursor-pointer rounded px-2 py-1 text-left text-sm hover:bg-emerald-50 hover:text-emerald-900"
                onClick={() => {
                  editor.chain().focus().insertContentAt({ from: activeLint.from, to: activeLint.to }, s).run();
                  setActiveLint(null);
                  requestHarperRefresh(editor);
                }}
              >
                {s}
              </button>
            ))
          ) : (
            <p className="px-2 py-1 text-xs text-stone-400">No suggestions</p>
          )}
          <div className="mt-1 flex gap-1 border-t border-stone-100 pt-1">
            <button
              type="button"
              role="menuitem"
              className="flex-1 cursor-pointer rounded px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
              onClick={() => {
                addToUserDictionary(activeLint.word);
                setActiveLint(null);
                requestHarperRefresh(editor);
              }}
            >
              Add to dictionary
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex-1 cursor-pointer rounded px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
              onClick={() => setActiveLint(null)}
            >
              Ignore
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
