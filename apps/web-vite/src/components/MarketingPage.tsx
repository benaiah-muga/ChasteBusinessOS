import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { currencyMinorUnits } from "@chaste/erp-core";
import "./MarketingPage.css";
import {
  fetchMarketingEnabled,
  fetchMarketingSnapshot,
  MarketingApiError,
  submitMarketingAction,
  type MarketingSnapshot,
} from "../api/marketing";
import "./MarketingPage.css";

const styles = `
.mk-page { width: min(100% - 48px, 1320px); margin: 0 auto; padding: clamp(30px, 5vw, 56px) 0 68px; color: #354137; }
.mk-header { margin-bottom: 20px; }
.mk-eyebrow { margin: 0 0 7px; color: #927b4d; font-size: 9px; font-weight: 750; letter-spacing: .15em; text-transform: uppercase; }
.mk-header h1 { margin: 0 0 8px; color: #29372d; font-family: Georgia, "Times New Roman", serif; font-size: clamp(32px, 4vw, 44px); font-weight: 500; letter-spacing: -.045em; }
.mk-header p:last-child { margin: 0; max-width: 620px; color: #777970; font-size: 12px; line-height: 1.6; }
.mk-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 14px; border: 1px solid; border-radius: 8px; padding: 10px 13px; font-size: 11px; }
.mk-notice-success { border-color: #cfdfce; background: #f1f7ef; color: #476346; }
.mk-notice-pending { border-color: #eadcad; background: #fbf7e9; color: #796439; }
.mk-notice-error { border-color: #e7c8c0; background: #fff7f4; color: #8c4c40; }
.mk-notice button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 10px; opacity: .75; }
.mk-error { border-color: #e7c8c0; border-radius: 9px; padding: 16px; background: #fff7f4; color: #8c4c40; }
.mk-error h2 { margin: 0 0 6px; font-family: Georgia, "Times New Roman", serif; font-size: 19px; font-weight: 500; }
.mk-error p { margin: 0 0 11px; font-size: 11px; line-height: 1.6; }
.mk-disabled { border: 1px solid #e5e3da; border-radius: 12px; padding: 22px; background: #fffefa; }
.mk-disabled h2 { margin: 0 0 6px; font-family: Georgia, "Times New Roman", serif; font-size: 20px; font-weight: 500; }
.mk-disabled p { margin: 0; color: #777970; font-size: 11px; line-height: 1.6; }
.mk-grid { display: grid; grid-template-columns: 1fr 1fr; align-items: start; gap: 13px; }
.mk-panel { min-width: 0; border: 1px solid #e5e3da; border-radius: 10px; padding: 15px; background: #fffefa; box-shadow: 0 6px 19px rgb(44 40 29 / 3%); }
.mk-panel h2 { margin: 0 0 12px; color: #38443a; font-family: Georgia, "Times New Roman", serif; font-size: 18px; font-weight: 500; }
.mk-form { display: grid; gap: 8px; margin: 0 -15px 13px; border-top: 1px solid #efede7; border-bottom: 1px solid #efede7; padding: 12px 15px; }
.mk-form-row { display: flex; flex-wrap: wrap; gap: 8px; }
.mk-form label { display: grid; min-width: 0; flex: 1; gap: 5px; color: #72756c; font-size: 9px; font-weight: 650; }
.mk-form input, .mk-form select, .mk-form textarea { width: 100%; min-width: 0; min-height: 34px; border: 1px solid #dfddd4; border-radius: 6px; padding: 6px 8px; background: #fffefa; color: #41483f; font: inherit; font-size: 11px; }
.mk-form textarea { min-height: 84px; resize: vertical; }
.mk-form button, .mk-campaign button, .mk-error button { min-height: 33px; border: 1px solid #dfddd4; border-radius: 6px; padding: 0 11px; background: #fffefa; color: #596157; cursor: pointer; font: inherit; font-size: 10px; font-weight: 650; }
.mk-form button:disabled, .mk-campaign button:disabled, .mk-error button:disabled { cursor: wait; opacity: .55; }
.mk-form button:not(:disabled):hover, .mk-campaign button:not(:disabled):hover, .mk-error button:not(:disabled):hover { border-color: #c7b780; background: #faf7ed; }
.mk-form-hint { margin: 0; color: #85877d; font-size: 9px; line-height: 1.55; }
.mk-list { margin: 0; padding: 0; list-style: none; }
.mk-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid #efede7; padding: 9px 2px; font-size: 11px; }
.mk-row:first-child { border-top: 0; }
.mk-row > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.mk-row-meta { flex: 0 0 auto; color: #8b8c83; font-size: 9px; white-space: nowrap; }
.mk-badge { display: inline-block; border-radius: 99px; padding: 2px 7px; background: #f0efe7; color: #75776d; font-size: 8px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.mk-badge-queued { background: #e6f0e5; color: #456b47; }
.mk-badge-draft { background: #f7efd9; color: #8a6f34; }
.mk-campaign { display: grid; gap: 6px; border-top: 1px solid #efede7; padding: 11px 2px; }
.mk-campaign:first-child { border-top: 0; }
.mk-campaign-head { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; font-size: 11px; }
.mk-campaign-head strong { font-size: 11px; }
.mk-campaign-meta { color: #8b8c83; font-size: 9px; }
.mk-campaign-preview { margin: 0; color: #6d7269; font-size: 10px; line-height: 1.55; overflow-wrap: anywhere; }
.mk-campaign-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.mk-result { margin: 0; border-radius: 6px; padding: 7px 9px; background: #f6f5f0; color: #5c625a; font-size: 9px; line-height: 1.6; }
.mk-result-unconfirmed { background: #fbf5e5; color: #7c6036; }
.mk-honest { display: grid; gap: 3px; margin: 0 0 12px; border: 1px solid #e5e3da; border-radius: 8px; padding: 10px 12px; background: #f8f7f2; color: #6f736a; font-size: 10px; line-height: 1.6; }
.mk-honest strong { color: #465347; }
.mk-send-status { font-weight: 700; }
.mk-send-delivered { color: #456b47; }
.mk-send-queued { color: #8a6f34; }
.mk-send-failed { color: #a04a3a; }
.mk-empty { padding: 15px 4px; color: #92938a; font-size: 10px; line-height: 1.6; text-align: center; }
.mk-empty span { display: block; margin-bottom: 5px; font-size: 15px; }
.mk-wait { color: #777970; font-size: 11px; }
.mk-log { margin-top: 13px; }
@media (max-width: 900px) { .mk-grid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .mk-page { width: min(100% - 28px, 1320px); padding-top: 27px; } }
`;

const EmptyCampaignForm = { segmentId: "", name: "", subject: "", body: "" };
const PersistedCampaignFormSchema = z.object({
  campaignForm: z.object({
    segmentId: z.string(),
    name: z.string().max(120),
    subject: z.string().max(200),
    body: z.string().max(10000),
  }).strict(),
  unresolved: z.boolean(),
}).strict();

const styleTag = <style>{styles}</style>;

type SendResult = { recipients: number; skippedOptOut: number; skippedNoAddress: number; alreadySent: number };
type CampaignAnalytics = { campaignName: string; sentCount: number; queuedAt: string | null };

type ModuleState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; enabled: boolean };
type DataState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; snapshot: MarketingSnapshot };
type Notice = { tone: "success" | "pending" | "error"; message: string };

const emptySnapshot: MarketingSnapshot = { segments: [], campaigns: [], sendCounts: [], recentSends: [] };

function messageFor(error: unknown): string {
  if (error instanceof MarketingApiError) return error.message;
  return "Could not reach the marketing service. Check your connection and try again.";
}

function formatMoney(minor: number, currency: string): string {
  const units = currencyMinorUnits(currency) ?? 2;
  const amount = minor / 10 ** units;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(units)}`;
  }
}

/** Presentation-currency major units typed by a human become integer minor units. */
function parseMinor(value: string, minorUnits: number): number | null {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const minor = Math.round(Number(text) * 10 ** minorUnits);
  return Number.isSafeInteger(minor) ? minor : null;
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "just now";
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function sendSummary(result: SendResult): string {
  const already = result.alreadySent ? `, ${result.alreadySent} already sent earlier` : "";
  return `Queued ${result.recipients} recipients, ${result.skippedOptOut} opted-out skipped, ${result.skippedNoAddress} without an address skipped${already}.`;
}

export function MarketingPage({ baseCurrency = null, actorId = null, organizationId = null }: { baseCurrency?: string | null; actorId?: string | null; organizationId?: string | null }) {
  const currency = baseCurrency ?? "USD";
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  const [moduleState, setModuleState] = useState<ModuleState>({ status: "loading" });
  const [dataState, setDataState] = useState<DataState>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [segmentForm, setSegmentForm] = useState({ name: "", minSpend: "0.00" });
  const [campaignForm, setCampaignForm] = useState(EmptyCampaignForm);
  const goCampaignWritesEnabled = typeof __GO_MARKETING_CAMPAIGN_WRITES__ !== "undefined" && __GO_MARKETING_CAMPAIGN_WRITES__;
  const campaignScopeIdentity = actorId?.trim() && organizationId?.trim()
    ? JSON.stringify({ actorId: actorId.trim(), organizationId: organizationId.trim() })
    : null;
  const [campaignDraftStorageKey, setCampaignDraftStorageKey] = useState<string | null>(null);
  const [campaignDraftKeyScopeIdentity, setCampaignDraftKeyScopeIdentity] = useState<string | null>(null);
  const [campaignDraftStatus, setCampaignDraftStatus] = useState<"loading" | "ready" | "failed">(goCampaignWritesEnabled ? "loading" : "ready");
  const [campaignDraftLocked, setCampaignDraftLocked] = useState(false);
  const campaignDraftReady = !goCampaignWritesEnabled || Boolean(campaignScopeIdentity && campaignDraftStorageKey && campaignDraftKeyScopeIdentity === campaignScopeIdentity && campaignDraftStatus === "ready");
  const [sendResults, setSendResults] = useState<Record<string, SendResult>>({});
  const [analytics, setAnalytics] = useState<Record<string, CampaignAnalytics>>({});

  useEffect(() => {
    if (!goCampaignWritesEnabled) return;
    let active = true;
    setCampaignDraftStorageKey(null);
    setCampaignDraftKeyScopeIdentity(null);
    setCampaignDraftStatus("loading");
    setCampaignForm(EmptyCampaignForm);
    setCampaignDraftLocked(false);
    if (!campaignScopeIdentity) {
      setCampaignDraftStatus("failed");
      return () => { active = false; };
    }
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(campaignScopeIdentity)).then((digest) => {
      if (!active) return;
      const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      setCampaignDraftStorageKey(`chaste.marketing.campaign-draft.v1:${hex}`);
      setCampaignDraftKeyScopeIdentity(campaignScopeIdentity);
    }).catch(() => {
      if (active) setCampaignDraftStatus("failed");
    });
    return () => { active = false; };
  }, [campaignScopeIdentity, goCampaignWritesEnabled]);

  useEffect(() => {
    if (!goCampaignWritesEnabled || !campaignDraftStorageKey || !campaignScopeIdentity || campaignDraftKeyScopeIdentity !== campaignScopeIdentity) return;
    try {
      const raw = window.localStorage.getItem(campaignDraftStorageKey);
      if (raw === null) {
        setCampaignForm(EmptyCampaignForm);
        setCampaignDraftLocked(false);
      } else {
        const parsed = PersistedCampaignFormSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw new Error("saved campaign draft has an invalid shape");
        setCampaignForm(parsed.data.campaignForm);
        setCampaignDraftLocked(parsed.data.unresolved);
      }
      setCampaignDraftStatus("ready");
    } catch {
      setCampaignDraftStatus("failed");
    }
  }, [campaignDraftKeyScopeIdentity, campaignDraftStorageKey, campaignScopeIdentity, goCampaignWritesEnabled]);

  useEffect(() => {
    if (!goCampaignWritesEnabled || !campaignDraftStorageKey || !campaignScopeIdentity || campaignDraftKeyScopeIdentity !== campaignScopeIdentity || campaignDraftStatus !== "ready") return;
    try {
      const serialized = JSON.stringify({ campaignForm, unresolved: campaignDraftLocked });
      window.localStorage.setItem(campaignDraftStorageKey, serialized);
      if (window.localStorage.getItem(campaignDraftStorageKey) !== serialized) throw new Error("campaign draft did not persist");
    } catch {
      setCampaignDraftStatus("failed");
    }
  }, [campaignDraftKeyScopeIdentity, campaignDraftStorageKey, campaignDraftStatus, campaignDraftLocked, campaignDraftReady, campaignForm, campaignScopeIdentity, goCampaignWritesEnabled]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setDataState({ status: "loading" });
    setSendResults({});
    setAnalytics({});
    try {
      const snapshot = await fetchMarketingSnapshot(signal);
      if (!signal?.aborted) setDataState({ status: "ready", snapshot });
    } catch (error) {
      if (!signal?.aborted) setDataState({ status: "failed", message: messageFor(error) });
    }
  }, []);

  const loadModules = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setModuleState({ status: "loading" });
    try {
      const enabled = await fetchMarketingEnabled(signal);
      if (signal?.aborted) return;
      setModuleState({ status: "ready", enabled });
      if (enabled) await load(signal);
      else setDataState({ status: "ready", snapshot: emptySnapshot });
    } catch (error) {
      if (signal?.aborted) return;
      setModuleState({ status: "failed", message: messageFor(error) });
    }
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void loadModules(controller.signal);
    return () => controller.abort();
  }, [loadModules]);

  async function run<Output>(label: string, send: () => Promise<{ kind: "pending"; reason: string } | { kind: "completed"; data: Output }>, lifecycle?: { onPending?: () => void; onError?: (error: unknown) => void }): Promise<Output | null> {
    if (busy) return null;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await send();
      if (outcome.kind === "pending") {
        lifecycle?.onPending?.();
        setNotice({ tone: "pending", message: outcome.reason || `${label} needs human approval. It is in the Approvals inbox.` });
        return null;
      }
      await load();
      return outcome.data;
    } catch (error) {
      lifecycle?.onError?.(error);
      setNotice({ tone: "error", message: messageFor(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createSegment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = segmentForm.name.trim();
    if (!name) return;
    const minSpendMinor = parseMinor(segmentForm.minSpend, minorUnits);
    if (minSpendMinor === null) {
      setNotice({ tone: "error", message: "Enter the minimum lifetime spend as a whole, non-negative amount." });
      return;
    }
    const done = await run("Create segment", () => submitMarketingAction({ action: "createSegment", name, minSpendMinor }));
    if (done) {
      setNotice({ tone: "success", message: "Segment saved. Campaigns against it target the same people every time." });
      setSegmentForm({ name: "", minSpend: "0.00" });
    }
  }

  async function createCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const name = campaignForm.name.trim();
    const subject = campaignForm.subject.trim();
    const body = campaignForm.body;
    if (!campaignForm.segmentId || !name || !subject || !body.trim()) return;
    if (goCampaignWritesEnabled) {
      if (!campaignDraftReady || !campaignDraftStorageKey) {
        setNotice({ tone: "error", message: "Wait for the scoped campaign draft to finish loading before submitting." });
        return;
      }
      try {
        const serialized = JSON.stringify({ campaignForm, unresolved: true });
        window.localStorage.setItem(campaignDraftStorageKey, serialized);
        if (window.localStorage.getItem(campaignDraftStorageKey) !== serialized) throw new Error("campaign draft did not persist");
        setCampaignDraftLocked(true);
      } catch {
        setCampaignDraftStatus("failed");
        setNotice({ tone: "error", message: "Browser storage could not save this campaign draft, so it was not submitted." });
        return;
      }
    }
    const done = await run("Create campaign", () => submitMarketingAction({
      action: "createCampaign",
      segmentId: campaignForm.segmentId,
      name,
      subject,
      body,
    }, crypto.randomUUID(), { actorId, organizationId }), {
      onPending: () => {
        if (goCampaignWritesEnabled) setCampaignDraftLocked(true);
      },
      onError: (error) => {
        if (!goCampaignWritesEnabled) return;
        const unresolved = error instanceof MarketingApiError && error.requestMayHaveReachedServer;
        setCampaignDraftLocked(unresolved);
        if (!unresolved && campaignDraftStorageKey) {
          try {
            const serialized = JSON.stringify({ campaignForm, unresolved: false });
            window.localStorage.setItem(campaignDraftStorageKey, serialized);
            if (window.localStorage.getItem(campaignDraftStorageKey) !== serialized) throw new Error("campaign draft did not persist");
          } catch {
            setCampaignDraftStatus("failed");
          }
        }
      },
    });
    if (done) {
      setNotice({ tone: "success", message: "Campaign drafted. Nothing goes out until you press Send." });
      setCampaignForm(EmptyCampaignForm);
      setCampaignDraftLocked(false);
      if (goCampaignWritesEnabled && campaignDraftStorageKey) {
        try {
          const serialized = JSON.stringify({ campaignForm: EmptyCampaignForm, unresolved: false });
          window.localStorage.setItem(campaignDraftStorageKey, serialized);
          if (window.localStorage.getItem(campaignDraftStorageKey) !== serialized) throw new Error("campaign draft did not persist");
        } catch {
          setCampaignDraftStatus("failed");
          setNotice({ tone: "error", message: "Campaign was created, but browser storage could not clear its saved draft. Reload after enabling browser storage." });
        }
      }
    }
  }

  async function sendCampaign(campaignId: string) {
    const result = await run("Send campaign", () => submitMarketingAction({ action: "sendCampaign", campaignId }, crypto.randomUUID(), { actorId, organizationId }));
    if (!result) return;
    setSendResults((current) => ({ ...current, [campaignId]: result }));
    setNotice({ tone: "success", message: sendSummary(result) });
  }

  async function loadAnalytics(campaignId: string) {
    const stats = await run("Campaign analytics", () => submitMarketingAction({ action: "campaignAnalytics", campaignId }));
    if (stats) setAnalytics((current) => ({ ...current, [campaignId]: stats }));
  }

  if (moduleState.status === "loading") {
    return <main className="mk-page">{styleTag}<p className="mk-wait" role="status">Checking whether marketing is available…</p></main>;
  }
  if (moduleState.status === "failed") {
    return (
      <main className="mk-page">
        {styleTag}
        <header className="mk-header"><p className="mk-eyebrow">Workspace settings unavailable</p><h1>Could not check marketing availability</h1></header>
        <section className="mk-error" role="alert"><h2>Marketing is unavailable</h2><p>{moduleState.message}</p><button type="button" onClick={() => void loadModules()}>Try again</button></section>
      </main>
    );
  }
  if (!moduleState.enabled) {
    return (
      <main className="mk-page">
        {styleTag}
        <header className="mk-header"><p className="mk-eyebrow">Workspace</p><h1>Marketing</h1></header>
        <section className="mk-disabled">
          <h2>Marketing is disabled</h2>
          <p>This module is switched off for your organization. An org admin can re-enable it under Team &amp; roles → Modules.</p>
        </section>
      </main>
    );
  }

  const snapshot = dataState.status === "ready" ? dataState.snapshot : emptySnapshot;
  const segments = snapshot.segments;
  const campaigns = snapshot.campaigns;
  const confirmedByCampaign = new Map(snapshot.sendCounts.map((row) => [row.campaignId, row.count]));
  const segmentName = (id: string) => segments.find((segment) => segment.id === id)?.name ?? "unknown segment";

  return (
    <main className="mk-page">
      {styleTag}
      <header className="mk-header">
        <p className="mk-eyebrow">Workspace</p>
        <h1>Marketing</h1>
        <p>Saved deterministic segments, campaigns, and the delivery log that is the only honest analytics here.</p>
      </header>

      {notice && (
        <div className={`mk-notice mk-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="mk-grid">
        <section className="mk-panel" aria-labelledby="mk-segments-heading">
          <h2 id="mk-segments-heading">Segments</h2>
          <form className="mk-form" onSubmit={(event) => void createSegment(event)}>
            <div className="mk-form-row">
              <label htmlFor="mk-segment-name">Segment name<input id="mk-segment-name" maxLength={120} placeholder="Big spenders" value={segmentForm.name} onChange={(event) => setSegmentForm({ ...segmentForm, name: event.currentTarget.value })} /></label>
              <label htmlFor="mk-segment-min-spend">Min lifetime spend<input id="mk-segment-min-spend" inputMode="decimal" placeholder="0.00" value={segmentForm.minSpend} onChange={(event) => setSegmentForm({ ...segmentForm, minSpend: event.currentTarget.value })} /></label>
            </div>
            <div><button type="submit" disabled={busy || !segmentForm.name.trim()}>{busy ? "Working…" : "Create segment"}</button></div>
          </form>
          {segments.length === 0 ? (
            <p className="mk-empty"><span aria-hidden="true">⌥</span>No segments yet. A segment is a deterministic filter: everyone whose lifetime spend clears the threshold.</p>
          ) : (
            <ul className="mk-list">
              {segments.map((segment) => (
                <li className="mk-row" key={segment.id}>
                  <span>{segment.name}</span>
                  <span className="mk-row-meta">spend ≥ {formatMoney(segment.minSpendMinor, currency)} · {timeAgo(segment.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mk-panel" aria-labelledby="mk-campaigns-heading">
          <h2 id="mk-campaigns-heading">Campaigns</h2>
          {goCampaignWritesEnabled && campaignDraftStatus === "loading" && <p role="status" className="mk-form-hint">Loading the scoped campaign draft before enabling campaign actions.</p>}
          {goCampaignWritesEnabled && campaignDraftStatus === "failed" && (
            <p role="alert" className="mk-error">
              {campaignScopeIdentity
                ? "Browser storage could not retain this scoped campaign draft. Enable browser storage and reload before submitting campaign actions."
                : "Wait for the active user and organization to load before using campaign actions."}
            </p>
          )}
          {goCampaignWritesEnabled && campaignDraftReady && campaignDraftLocked && <p role="status" className="mk-form-hint">This create attempt is pending or uncertain. Its exact draft is locked; submit again to retry with the same intent.</p>}
          <form className="mk-form" onSubmit={(event) => void createCampaign(event)}>
            <div className="mk-form-row">
              <label htmlFor="mk-campaign-segment">Segment
                <select id="mk-campaign-segment" disabled={busy || !campaignDraftReady || campaignDraftLocked} value={campaignForm.segmentId} onChange={(event) => setCampaignForm({ ...campaignForm, segmentId: event.currentTarget.value })}>
                  <option value="">Pick a segment…</option>
                  {segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
                </select>
              </label>
              <label htmlFor="mk-campaign-name">Campaign name<input id="mk-campaign-name" disabled={busy || !campaignDraftReady || campaignDraftLocked} maxLength={120} placeholder="Spring renewal" value={campaignForm.name} onChange={(event) => setCampaignForm({ ...campaignForm, name: event.currentTarget.value })} /></label>
            </div>
            <label htmlFor="mk-campaign-subject">Subject<input id="mk-campaign-subject" disabled={busy || !campaignDraftReady || campaignDraftLocked} maxLength={200} placeholder="Subject" value={campaignForm.subject} onChange={(event) => setCampaignForm({ ...campaignForm, subject: event.currentTarget.value })} /></label>
            <label htmlFor="mk-campaign-body">Body<textarea id="mk-campaign-body" disabled={busy || !campaignDraftReady || campaignDraftLocked} maxLength={10000} rows={3} placeholder="What every recipient will read" value={campaignForm.body} onChange={(event) => setCampaignForm({ ...campaignForm, body: event.currentTarget.value })} /></label>
            <p className="mk-form-hint">Drafting sends nothing. Delivery is a separate, logged step.</p>
            <div><button type="submit" disabled={busy || !campaignDraftReady || !campaignForm.segmentId || !campaignForm.name.trim() || !campaignForm.subject.trim() || !campaignForm.body.trim()}>{busy ? "Working…" : campaignDraftLocked ? "Retry campaign attempt" : "Create campaign"}</button></div>
          </form>
          {campaigns.length === 0 ? (
            <p className="mk-empty"><span aria-hidden="true">✉</span>No campaigns yet. Draft one against a saved segment; sending writes one append-only log row per recipient.</p>
          ) : (
            <ul className="mk-list">
              {campaigns.map((campaign) => {
                const sent = sendResults[campaign.id];
                const stats = analytics[campaign.id];
                return (
                  <li className="mk-campaign" key={campaign.id}>
                    <div className="mk-campaign-head">
                      <strong>{campaign.name}</strong>
                      <span className={`mk-badge ${campaign.queuedAt ? "mk-badge-queued" : "mk-badge-draft"}`}>{campaign.queuedAt ? "queued" : "draft"}</span>
                      <span className="mk-campaign-meta">to {segmentName(campaign.segmentId)} · {confirmedByCampaign.get(campaign.id) ?? 0} provider-confirmed</span>
                    </div>
                    <p className="mk-campaign-preview" title={`${campaign.subject}: ${campaign.body}`}>{campaign.subject} - {campaign.body}</p>
                    <div className="mk-campaign-actions">
                      <button type="button" disabled={busy || !campaignDraftReady || campaign.queuedAt !== null} onClick={() => void sendCampaign(campaign.id)}>Send</button>
                      <button type="button" disabled={busy} onClick={() => void loadAnalytics(campaign.id)}>Analytics</button>
                    </div>
                    {sent && (
                      <p className="mk-result">
                        {sendSummary(sent)}{" "}
                        {sent.recipients === 0
                          ? "Nothing was handed to the provider, so nothing counts as delivered."
                          : "Those rows are queued, not delivered: only the send log below can say a provider acknowledged them."}
                      </p>
                    )}
                    {stats && (
                      <p className="mk-result">
                        {stats.campaignName}: {stats.sentCount} provider-confirmed {stats.sentCount === 1 ? "delivery" : "deliveries"}
                        {stats.queuedAt ? ` · queued ${new Date(stats.queuedAt).toLocaleString()}` : " · not queued yet"}. Nothing else is counted.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="mk-panel mk-log" aria-labelledby="mk-send-log-heading">
        <h2 id="mk-send-log-heading">Send log</h2>
        <p className="mk-honest">
          <strong>Honest analytics.</strong>
          <span>The durable delivery log below is the only tracking. No pixels, no open tracking, no click capture: a row reads as delivered only when the provider acknowledged the outbox operation. Anything still queued stays queued, and a failed delivery stays visible as failed.</span>
        </p>
        {snapshot.recentSends.length === 0 ? (
          <p className="mk-empty"><span aria-hidden="true">≋</span>Nothing sent yet. When a campaign is queued, every recipient operation is recorded here, permanently and auditably.</p>
        ) : (
          <ul className="mk-list">
            {snapshot.recentSends.map((entry) => {
              const deliveredAt = entry.status === "sent" ? entry.sentAt : null;
              const failed = entry.status === "failed";
              const label = deliveredAt ? "delivered" : failed ? "delivery failed" : "queued, not confirmed";
              return (
                <li className="mk-row" key={entry.id}>
                  <span>{entry.customerName}{entry.customerEmail ? ` · ${entry.customerEmail}` : ""}</span>
                  <span className="mk-row-meta">
                    {campaigns.find((campaign) => campaign.id === entry.campaignId)?.name ?? "campaign"} ·{" "}
                    <span className={`mk-send-status ${deliveredAt ? "mk-send-delivered" : failed ? "mk-send-failed" : "mk-send-queued"}`}>{label}</span>
                    {deliveredAt ? ` · ${timeAgo(deliveredAt)}` : ` · queued ${timeAgo(entry.queuedAt)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
