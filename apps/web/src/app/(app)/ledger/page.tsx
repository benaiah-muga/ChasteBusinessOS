"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, LoadingPage, PageHeader } from "@/components/ui";
import { IconAlertTriangle, IconHash, IconListTree, IconSearch } from "@/components/icons";
import { formatDateTime, timeAgo } from "@/lib/format";
import { callApi } from "@/lib/api";

interface LedgerEvent {
  seq: number;
  kind: string;
  capabilityId: string | null;
  actorType: string;
  payload: unknown;
  hash: string | null;
  prevHash: string | null;
  occurredAt: string;
}

export default function LedgerPage() {
  const [events, setEvents] = useState<LedgerEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    const res = await callApi<{ events?: LedgerEvent[] }>("/api/ledger?limit=100");
    if (!res.ok) {
      setLoadError(res.error?.title ?? "Couldn't load the ledger");
      setEvents([]);
      return;
    }
    setEvents(res.data?.events ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!events) return [];
    const q = search.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (e) =>
        e.kind.toLowerCase().includes(q) ||
        (e.capabilityId ?? "").toLowerCase().includes(q) ||
        e.actorType.toLowerCase().includes(q),
    );
  }, [events, search]);

  return (
    <div>
      <PageHeader
        title="Event Ledger"
        description="Append-only and hash-chained. Every action, human or agent, with its evidence. Each entry commits to the previous one; tampering breaks the chain visibly."
        actions={
          <label className="relative">
            <span className="sr-only">Filter ledger events</span>
            <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-stone-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by kind, capability, actor…"
              className="input h-9 w-64 pl-8 text-xs sm:w-72"
            />
          </label>
        }
      />

      {loadError && events?.length === 0 ? (
        <EmptyState icon={<IconAlertTriangle />} title={loadError} hint="Check your connection, then retry."
          action={<Button tone="secondary" onClick={() => void load()}>Retry</Button>} />
      ) : events === null ? (
        <LoadingPage />
      ) : events.length === 0 ? (
        <EmptyState
          icon={<IconListTree />}
          title="Nothing in the ledger yet"
          hint="Do anything in the console, every governed action lands here with its hash chain."
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<IconSearch />} title="No events match" hint="Try a different filter." />
      ) : (
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Event</th>
                <th>Capability</th>
                <th>Actor</th>
                <th>When</th>
                <th>Chain</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.seq}>
                  <td className="num font-mono text-xs text-stone-400">{e.seq}</td>
                  <td className="font-medium whitespace-nowrap">{e.kind}</td>
                  <td className="max-w-52 truncate font-mono text-xs text-stone-500" title={e.capabilityId ?? ""}>
                    {e.capabilityId ?? "-"}
                  </td>
                  <td>
                    <Badge tone={e.actorType === "agent" ? "violet" : "neutral"}>{e.actorType}</Badge>
                  </td>
                  <td className="text-xs whitespace-nowrap text-stone-500" title={formatDateTime(e.occurredAt)}>
                    {timeAgo(e.occurredAt)}
                  </td>
                  <td className="whitespace-nowrap">
                    <span
                      className="inline-flex items-center gap-1.5 font-mono text-xs text-stone-400"
                      title={`hash ${e.hash ?? "-"} · prev ${e.prevHash ?? "-"}`}
                    >
                      <IconHash className="size-3 shrink-0 text-stone-300" aria-hidden="true" />
                      {e.hash?.slice(0, 12)}…
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
