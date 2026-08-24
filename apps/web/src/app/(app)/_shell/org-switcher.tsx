"use client";

import { useTransition } from "react";
import { IconBuilding, IconSpinner } from "@/components/icons";
import { switchOrgAction } from "./actions";

export function OrgSwitcher({
  orgs,
  activeId,
}: {
  orgs: { id: string; name: string }[];
  activeId: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <label className="relative flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-sm">
      <IconBuilding className="size-3.5 shrink-0 text-stone-400" aria-hidden="true" />
      {pending && <IconSpinner className="absolute right-2 size-3.5 text-stone-400" />}
      <span className="sr-only">Active organization</span>
      <select
        value={activeId}
        disabled={pending}
        onChange={(e) => startTransition(() => switchOrgAction(e.target.value))}
        className="w-full cursor-pointer appearance-none bg-transparent pr-4 text-[13px] font-medium text-stone-700 outline-none"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pointer-events-none absolute right-2 size-3 text-stone-400">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </label>
  );
}
