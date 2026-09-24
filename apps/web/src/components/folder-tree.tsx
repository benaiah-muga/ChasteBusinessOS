"use client";

import { useEffect, useState } from "react";
import { IconChevronRight, IconFileText, IconListTree, IconPlus, IconTrash, IconX } from "@/components/icons";
import { cn } from "@/lib/format";

function normalize(paths: string[]) {
  const all = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").map((part) => part.trim()).filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) all.add(parts.slice(0, index).join("/"));
  }
  return [...all].sort((a, b) => a.localeCompare(b));
}

interface FolderTreeProps {
  paths: string[];
  active: string | null;
  onSelect: (path: string | null) => void;
  counts?: Record<string, number>;
  onCreate?: (path: string) => Promise<boolean>;
  onRename?: (path: string, newPath: string) => Promise<boolean>;
  onDelete?: (path: string) => Promise<boolean>;
  onDropDocument?: (path: string | null, documentId: string) => Promise<boolean>;
  createSignal?: number;
}

export function FolderTree({ paths, active, onSelect, counts = {}, onCreate, onRename, onDelete, onDropDocument, createSignal = 0 }: FolderTreeProps) {
  const folders = normalize(paths);
  const [mode, setMode] = useState<{ kind: "create" | "rename"; path?: string } | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOverPath, setDragOverPath] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (createSignal > 0) {
      setMode({ kind: "create" });
      setValue(active ? `${active}/` : "");
    }
  }, [active, createSignal]);

  async function submit() {
    const next = value.trim();
    if (!next || !mode) return;
    setBusy(true);
    const ok = mode.kind === "create" ? await onCreate?.(next) : await onRename?.(mode.path!, next);
    setBusy(false);
    if (ok) {
      setMode(null);
      setValue("");
    }
  }

  function canDrop(event: React.DragEvent<HTMLButtonElement>): boolean {
    return Boolean(onDropDocument && event.dataTransfer.types.includes("text/plain"));
  }

  function handleDrop(event: React.DragEvent<HTMLButtonElement>, path: string | null): void {
    event.preventDefault();
    setDragOverPath(undefined);
    const payload = event.dataTransfer.getData("text/plain");
    const documentId = payload.startsWith("document:") ? payload.slice("document:".length) : "";
    if (documentId && onDropDocument) void onDropDocument(path, documentId);
  }

  return (
    <nav aria-label="Document folders" className="doc-folder-tree">
      <div className="doc-folder-tree__head">
        <span className="flex items-center gap-2"><IconListTree className="size-3.5" /> Folders</span>
        {onCreate && (
          <button type="button" className="doc-folder-tree__icon" onClick={() => { setMode({ kind: "create" }); setValue(active ? `${active}/` : ""); }} aria-label="Create folder" title="Create folder">
            <IconPlus className="size-4" />
          </button>
        )}
      </div>
      {mode && (
        <form className="doc-folder-tree__form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label htmlFor="folder-path" className="sr-only">{mode.kind === "create" ? "New folder path" : "Rename folder"}</label>
          <input id="folder-path" autoFocus value={value} onChange={(event) => setValue(event.target.value)} className="input h-9 min-w-0 text-xs" placeholder="Finance/2026" />
          <button type="submit" disabled={busy || !value.trim()} className="doc-folder-tree__icon" aria-label={mode.kind === "create" ? "Create folder" : "Save folder name"}><IconChevronRight className="size-4" /></button>
          <button type="button" className="doc-folder-tree__icon" onClick={() => setMode(null)} aria-label="Cancel"><IconX className="size-4" /></button>
        </form>
      )}
      <button
        type="button"
        onClick={() => onSelect(null)}
        onDragOver={(event) => { if (canDrop(event)) { event.preventDefault(); setDragOverPath(null); } }}
        onDragLeave={() => setDragOverPath((current) => current === null ? undefined : current)}
        onDrop={(event) => handleDrop(event, null)}
        className={cn("doc-folder-tree__row", active === null && "is-active", dragOverPath === null && "ring-2 ring-gold-300")}
      >
        <IconFileText className="size-4 text-stone-400" />
        <span>All documents</span>
      </button>
      {folders.map((path) => {
        const depth = path.split("/").length - 1;
        const name = path.split("/").at(-1) ?? path;
        return (
          <div key={path} className="group relative">
            <button
              type="button"
              onClick={() => onSelect(path)}
              onDragOver={(event) => { if (canDrop(event)) { event.preventDefault(); setDragOverPath(path); } }}
              onDragLeave={() => setDragOverPath((current) => current === path ? undefined : current)}
              onDrop={(event) => handleDrop(event, path)}
              style={{ paddingInlineStart: `${0.7 + depth * 0.85}rem` }}
              className={cn("doc-folder-tree__row pr-16", active === path && "is-active", dragOverPath === path && "ring-2 ring-gold-300")}
              title={path}
            >
              <IconChevronRight className="size-3 shrink-0 text-stone-300" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {counts[path] !== undefined && <span className="tnum text-[10px] text-stone-400">{counts[path]}</span>}
            </button>
            {(onRename || onDelete) && (
              <span className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                {onRename && <button type="button" className="doc-folder-tree__icon" onClick={() => { setMode({ kind: "rename", path }); setValue(path); }} aria-label={`Rename ${path}`}>Aa</button>}
                {onDelete && <button type="button" className="doc-folder-tree__icon hover:text-red-700" onClick={() => void onDelete(path)} aria-label={`Delete ${path}`}><IconTrash className="size-3.5" /></button>}
              </span>
            )}
          </div>
        );
      })}
      {folders.length === 0 && !mode && <p className="px-2 py-4 text-xs leading-5 text-stone-500">No folders yet. Create one to keep contracts, sales, and supplier records easy to find.</p>}
    </nav>
  );
}
