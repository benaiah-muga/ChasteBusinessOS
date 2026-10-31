import { useEffect, useMemo, useState } from "react";
import { Bookmark, Check, Plus, X } from "lucide-react";
import "./saved-view-bar.css";

type SavedView<T> = { id: string; name: string; value: T };

function readViews<T>(key: string): SavedView<T>[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.name !== "string" || record.value === undefined) return [];
      return [{ id: record.id, name: record.name, value: record.value as T }];
    }).slice(0, 12);
  } catch {
    return [];
  }
}

export function SavedViewBar<T>({
  module,
  organizationId,
  current,
  onApply,
  label = "Saved views",
}: {
  module: string;
  organizationId?: string | null;
  current: T;
  onApply: (value: T) => void;
  label?: string;
}) {
  const key = `chaste:saved-views:v1:${organizationId ?? "personal"}:${module}`;
  const [views, setViews] = useState<SavedView<T>[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    setViews(readViews<T>(key));
    setActiveId(null);
    setSaving(false);
  }, [key]);

  const serializedCurrent = useMemo(() => JSON.stringify(current), [current]);

  function save() {
    const clean = name.trim();
    if (!clean) return;
    const next = [...views, { id: crypto.randomUUID(), name: clean.slice(0, 60), value: current }].slice(-12);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* A blocked store loses only the view. */ }
    setViews(next);
    setActiveId(next.at(-1)?.id ?? null);
    setName("");
    setSaving(false);
  }

  function remove(id: string) {
    const next = views.filter((view) => view.id !== id);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* A blocked store loses only the view. */ }
    setViews(next);
    if (activeId === id) setActiveId(null);
  }

  return (
    <div className="saved-view-bar" aria-label={label}>
      <span className="saved-view-label" title="Saved on this browser for the active organization"><Bookmark size={11} aria-hidden="true" /> {label}</span>
      {views.map((view) => {
        const active = view.id === activeId || JSON.stringify(view.value) === serializedCurrent;
        return (
          <span className={`saved-view-chip${active ? " is-active" : ""}`} key={view.id}>
            <button type="button" onClick={() => { setActiveId(view.id); onApply(view.value); }} aria-pressed={active}>
              {active && <Check size={10} aria-hidden="true" />}{view.name}
            </button>
            <button type="button" className="saved-view-remove" aria-label={`Delete saved view ${view.name}`} onClick={() => remove(view.id)}><X size={9} aria-hidden="true" /></button>
          </span>
        );
      })}
      {saving ? (
        <span className="saved-view-save">
          <input autoFocus value={name} maxLength={60} placeholder="View name" aria-label="Saved view name" onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") save(); if (event.key === "Escape") setSaving(false); }} />
          <button type="button" onClick={save} disabled={!name.trim()}>Save</button>
          <button type="button" aria-label="Cancel saving view" onClick={() => setSaving(false)}><X size={9} /></button>
        </span>
      ) : (
        <button type="button" className="saved-view-add" onClick={() => setSaving(true)}><Plus size={10} aria-hidden="true" /> Save view</button>
      )}
    </div>
  );
}
