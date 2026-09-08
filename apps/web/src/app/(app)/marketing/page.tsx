"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  LoadingPage,
  Notice,
  type ActionNoticeState,
} from "@/components/ui";
import { IconListTree, IconSend, IconChartBar } from "@/components/icons";
import { formatDateTime, formatMoney, timeAgo, toMinor } from "@/lib/format";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

interface Segment {
  id: string;
  name: string;
  minSpendMinor: number;
  createdAt: string;
}
interface Campaign {
  id: string;
  segmentId: string;
  name: string;
  subject: string;
  body: string;
  sentAt: string | null;
  createdAt: string;
}
interface SendCount {
  campaignId: string;
  count: number;
}
interface SendLogEntry {
  id: string;
  campaignId: string;
  customerName: string;
  customerEmail: string | null;
  sentAt: string;
}
interface Payload {
  segments?: Segment[];
  campaigns?: Campaign[];
  sendCounts?: SendCount[];
  recentSends?: SendLogEntry[];
}
interface SendResult {
  recipients: number;
  skippedOptOut: number;
  alreadySent: number;
}
interface AnalyticsData {
  campaignName: string;
  sentCount: number;
  sentAt: string | null;
}
type CapabilityResult = SendResult | AnalyticsData | { segmentId: string } | { campaignId: string };

export default function MarketingPage() {
  const enabled = useModuleEnabled("marketing");
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [segmentForm, setSegmentForm] = useState({ name: "", minSpend: "0.00" });
  const [campaignForm, setCampaignForm] = useState({ segmentId: "", name: "", subject: "", body: "" });
  const [sendResults, setSendResults] = useState<Record<string, SendResult>>({});
  const [analytics, setAnalytics] = useState<Record<string, AnalyticsData>>({});

  const load = useCallback(async () => {
    const res = await callApi<Payload>("/api/marketing");
    if (!res.ok) {
      setNotice({ tone: "error", error: res.error ?? { title: "Couldn't load marketing", hint: "Try again." } });
      setData({});
      return;
    }
    setSendResults({});
    setAnalytics({});
    setData(res.data ?? {});
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const post = useCallback(
    async (body: Record<string, unknown>, label: string): Promise<CapabilityResult | null> => {
      setBusy(true);
      try {
        const res = await postApi("/api/marketing", body);
        if (res.status === 202) {
          setNotice({ tone: "pending", text: `${label} requires approval.` });
        } else if (!res.ok) {
          setNotice({ tone: "error", error: res.error ?? { title: `${label} failed`, hint: "Try again." } });
        } else {
          // Success results arrive as { ok: true, data } from the kernel executor.
          const payload = (res.data as { data?: CapabilityResult } | null)?.data ?? null;
          await load();
          return payload;
        }
      } finally {
        setBusy(false);
      }
      return null;
    },
    [load],
  );

  if (!enabled) return <ModuleDisabled label="Marketing" />;
  if (!data) return <LoadingPage />;

  const segments = data.segments ?? [];
  const campaigns = data.campaigns ?? [];
  const sendsByCampaign = new Map((data.sendCounts ?? []).map((s) => [s.campaignId, s.count]));
  const recentSends = data.recentSends ?? [];
  const segmentName = (id: string) => segments.find((s) => s.id === id)?.name ?? "unknown segment";

  return (
    <div>
      <p className="mb-6 text-xl font-semibold tracking-tight text-stone-900">Marketing</p>
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ------------------------------------------------------ segments --- */}
        <Card>
          <CardTitle>Segments</CardTitle>
          <div className="mb-5 flex flex-wrap gap-2 text-sm">
            <input
              className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
              placeholder="Segment name, e.g. Big spenders"
              value={segmentForm.name}
              onChange={(e) => setSegmentForm({ ...segmentForm, name: e.target.value })}
            />
            <input
              className="w-40 rounded border bg-transparent px-2 py-1.5"
              placeholder="Min lifetime spend ($)"
              inputMode="decimal"
              value={segmentForm.minSpend}
              onChange={(e) => setSegmentForm({ ...segmentForm, minSpend: e.target.value })}
            />
            <Button
              disabled={busy || !segmentForm.name.trim()}
              onClick={() =>
                void post(
                  { action: "createSegment", name: segmentForm.name.trim(), minSpendMinor: toMinor(segmentForm.minSpend) },
                  "Create segment",
                ).then((ok) => {
                  if (ok) {
                    setNotice({ tone: "success", text: "Segment saved. Campaigns against it target the same people every time." });
                    setSegmentForm({ name: "", minSpend: "0.00" });
                  }
                })
              }
            >
              Create segment
            </Button>
          </div>
          {segments.length === 0 ? (
            <EmptyState
              icon={<IconListTree />}
              title="No segments yet"
              hint="A segment is a deterministic filter — everyone whose lifetime spend clears the threshold."
            />
          ) : (
            <ul className="divide-y text-sm">
              {segments.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate font-medium">{s.name}</span>
                  <span className="shrink-0 text-xs whitespace-nowrap text-stone-500">
                    spend ≥ {formatMoney(s.minSpendMinor)} · {timeAgo(s.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ----------------------------------------------------- campaigns --- */}
        <Card>
          <CardTitle>Campaigns</CardTitle>
          <div className="mb-5 space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <select
                className="rounded border bg-transparent px-2 py-1.5"
                aria-label="Segment"
                value={campaignForm.segmentId}
                onChange={(e) => setCampaignForm({ ...campaignForm, segmentId: e.target.value })}
              >
                <option value="">Pick a segment…</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <input
                className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
                placeholder="Campaign name"
                value={campaignForm.name}
                onChange={(e) => setCampaignForm({ ...campaignForm, name: e.target.value })}
              />
            </div>
            <input
              className="w-full rounded border bg-transparent px-2 py-1.5"
              placeholder="Subject"
              value={campaignForm.subject}
              onChange={(e) => setCampaignForm({ ...campaignForm, subject: e.target.value })}
            />
            <textarea
              className="textarea min-h-16 w-full py-2 text-sm"
              rows={3}
              placeholder="Body — what every recipient will read"
              value={campaignForm.body}
              onChange={(e) => setCampaignForm({ ...campaignForm, body: e.target.value })}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-stone-400">Drafting sends nothing — delivery is a separate, logged step.</span>
              <Button
                disabled={
                  busy ||
                  !campaignForm.segmentId ||
                  !campaignForm.name.trim() ||
                  !campaignForm.subject.trim() ||
                  !campaignForm.body.trim()
                }
                onClick={() =>
                  void post(
                    {
                      action: "createCampaign",
                      segmentId: campaignForm.segmentId,
                      name: campaignForm.name.trim(),
                      subject: campaignForm.subject.trim(),
                      body: campaignForm.body,
                    },
                    "Create campaign",
                  ).then((ok) => {
                    if (ok) {
                      setNotice({ tone: "success", text: "Campaign drafted. Nothing goes out until you press Send." });
                      setCampaignForm({ segmentId: "", name: "", subject: "", body: "" });
                    }
                  })
                }
              >
                Create campaign
              </Button>
            </div>
          </div>
          {campaigns.length === 0 ? (
            <EmptyState
              icon={<IconSend />}
              title="No campaigns yet"
              hint="Draft a campaign against a saved segment; sending writes one append-only log row per recipient."
            />
          ) : (
            <ul className="divide-y text-sm">
              {campaigns.map((c) => {
                const sent = sendResults[c.id];
                const stats = analytics[c.id];
                return (
                  <li key={c.id} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Badge tone={c.sentAt ? "green" : "amber"}>{c.sentAt ? "sent" : "draft"}</Badge>
                      <span className="text-xs text-stone-400">
                        to {segmentName(c.segmentId)} · {sendsByCampaign.get(c.id) ?? 0} in log
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-stone-500" title={`${c.subject}: ${c.body}`}>
                      {c.subject} — {c.body}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void post({ action: "sendCampaign", campaignId: c.id }, "Send campaign").then((res) => {
                            if (res && "recipients" in res) {
                              setSendResults((prev) => ({ ...prev, [c.id]: res as SendResult }));
                              setNotice({
                                tone: "success",
                                text: `Sent to ${res.recipients} recipients, ${res.skippedOptOut} opted-out skipped${
                                  res.alreadySent ? `, ${res.alreadySent} already sent earlier` : ""
                                }.`,
                              });
                            }
                          })
                        }
                      >
                        Send
                      </Button>
                      <Button
                        size="sm"
                        tone="secondary"
                        disabled={busy}
                        onClick={() =>
                          void post({ action: "campaignAnalytics", campaignId: c.id }, "Campaign analytics").then((res) => {
                            if (res && "sentCount" in res) setAnalytics((prev) => ({ ...prev, [c.id]: res as AnalyticsData }));
                          })
                        }
                      >
                        Analytics
                      </Button>
                    </div>
                    {sent && (
                      <p className="mt-1.5 text-xs text-stone-600">
                        Sent to {sent.recipients} recipients, {sent.skippedOptOut} opted-out skipped
                        {sent.alreadySent ? `, ${sent.alreadySent} already sent earlier` : ""}.
                      </p>
                    )}
                    {stats && (
                      <p className="mt-1 text-xs text-stone-500">
                        {stats.campaignName}: {stats.sentCount} {stats.sentCount === 1 ? "send" : "sends"} logged
                        {stats.sentAt ? ` · sent ${formatDateTime(stats.sentAt)}` : " · not sent yet"}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* ------------------------------------------------ honest send log --- */}
      <Card className="mt-6">
        <CardTitle>Send log</CardTitle>
        <Notice tone="info">
          <span className="font-semibold">Honest analytics:</span> the append-only send log below is the only tracking.
          No pixels, no open tracking, no click capture — &ldquo;sent&rdquo; means a row in this log, nothing more.
        </Notice>
        {recentSends.length === 0 ? (
          <EmptyState
            icon={<IconChartBar />}
            title="Nothing sent yet"
            hint="When a campaign goes out, every delivery is recorded here — permanently and auditably."
          />
        ) : (
          <ul className="divide-y text-sm">
            {recentSends.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">
                  {s.customerName}
                  {s.customerEmail ? <span className="opacity-50"> · {s.customerEmail}</span> : null}
                </span>
                <span className="shrink-0 text-xs whitespace-nowrap text-stone-500">
                  {campaigns.find((c) => c.id === s.campaignId)?.name ?? "campaign"} · {timeAgo(s.sentAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
