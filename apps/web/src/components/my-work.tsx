"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardTitle } from "@/components/ui";
import { callApi, postApi } from "@/lib/api";
import { pilotBegin, record } from "@/lib/pilot-metrics";

/**
 * P01 — "My work": one ranked list of what needs attention, each card with
 * what changed, why it matters and one primary action. Ranking is
 * deterministic server-side; the optional brief is AI-written over the
 * already-authorized cards and degrades honestly when unavailable.
 */

interface WorkCard {
  kind: "approval" | "receipt_remainder" | "signal";
  id: string;
  title: string;
  detail: string;
  whyItMatters: string;
  actionLabel: string;
  actionHref: string;
  createdAt: string | null;
}

export function MyWork() {
  const [cards, setCards] = useState<WorkCard[] | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefState, setBriefState] = useState<"idle" | "loading" | "unavailable">("idle");

  useEffect(() => {
    pilotBegin("home");
    callApi<{ cards: WorkCard[] }>("/api/my-work").then((res) => {
      setCards(res.ok && res.data ? res.data.cards : []);
    });
  }, []);

  const onCardAction = useCallback(() => {
    record("first_action", "my-work card", "home");
  }, []);

  const summarize = useCallback(async () => {
    setBriefState("loading");
    const res = await postApi<{ brief: string }>("/api/my-work/summarize", { cards });
    if (res.ok && res.data?.brief) {
      setBrief(res.data.brief);
      setBriefState("idle");
    } else {
      setBrief(res.error?.hint ?? "The brief is unavailable right now; the ranked list itself is unaffected.");
      setBriefState("unavailable");
    }
  }, [cards]);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>My work</CardTitle>
        <Button onClick={summarize} disabled={!cards || cards.length === 0 || briefState === "loading"}>
          {briefState === "loading" ? "Summarizing…" : "Brief me"}
        </Button>
      </div>
      {brief && (
        <p className={`mb-2 rounded border p-2 text-sm ${briefState === "unavailable" ? "opacity-60" : ""}`}>{brief}</p>
      )}
      {cards === null ? (
        <p className="text-sm opacity-60">Checking what needs you…</p>
      ) : cards.length === 0 ? (
        <p className="text-sm opacity-60">Nothing needs you right now. New approvals, short deliveries and module checks appear here.</p>
      ) : (
        <ul className="space-y-2">
          {cards.map((c) => (
            <li key={`${c.kind}-${c.id}`} className="rounded border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{c.title}</span>
                <Badge>{c.kind === "approval" ? "approval" : c.kind === "receipt_remainder" ? "outstanding delivery" : "signal"}</Badge>
              </div>
              <div className="text-sm">{c.detail}</div>
              <div className="mt-1 text-xs opacity-70">{c.whyItMatters}</div>
              <a className="mt-2 inline-block text-sm underline" href={c.actionHref} onClick={onCardAction}>
                {c.actionLabel} →
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
