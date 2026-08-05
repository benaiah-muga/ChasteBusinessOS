"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Building2, Check, ChevronDown, GitBranch } from "lucide-react";
import { getApiClient } from "@/lib/api";

type Branch = { id: string; name: string; code: string; isActiveBranch: boolean };

/**
 * Shows a real branch switcher only when the org actually has more than one
 * accessible branch (multibranch support enabled) and the user holds the
 * branch-read permission. Otherwise it renders the current branch as a label.
 */
export function BranchSwitcher({
  canRead,
  orgName,
  autonomy,
}: {
  canRead: boolean;
  orgName?: string;
  autonomy?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    getApiClient()
      .listBranches()
      .then((res) => {
        if (cancelled) return;
        setBranches(res.branches);
        setActiveName(res.branches.find((b) => b.isActiveBranch)?.name ?? res.branches[0]?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const multiple = (branches?.length ?? 0) > 1;
  const label = (branches?.length ?? 0) === 0 ? (orgName ?? "Local workspace") : (activeName ?? "—");

  if (!canRead) {
    return (
      <div className="status-pill">
        <GitBranch size={15} />
        <span>{orgName ?? "Local workspace"}</span>
      </div>
    );
  }

  async function switchTo(branchId: string, name: string) {
    setBusy(true);
    try {
      await getApiClient().setActiveBranch({ branchId });
      setActiveName(name);
      setOpen(false);
      router.refresh();
    } catch {
      /* keep current */
    } finally {
      setBusy(false);
    }
  }

  if (!multiple) {
    return (
      <div className="status-pill">
        <GitBranch size={15} />
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div className="select-pop branch-switcher" ref={ref}>
      <button
        type="button"
        className="select-pop-trigger"
        data-open={open ? "true" : "false"}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title="Switch branch"
      >
        <span className="value">
          <Building2 size={14} />
          {label}
        </span>
        <span className="chev">
          <ChevronDown size={14} />
        </span>
      </button>
      {open && branches ? (
        <div className="menu" role="listbox">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              className={b.isActiveBranch || b.name === activeName ? "selected" : ""}
              role="option"
              aria-selected={b.name === activeName}
              onClick={() => switchTo(b.id, b.name)}
            >
              <span className="option-label">
                {b.name}
                <span className="option-meta">{b.code}</span>
              </span>
              {(b.name === activeName || b.isActiveBranch) && (
                <span className="check">
                  <Check size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
      {autonomy ? <span className="sr-only">{autonomy}</span> : null}
    </div>
  );
}