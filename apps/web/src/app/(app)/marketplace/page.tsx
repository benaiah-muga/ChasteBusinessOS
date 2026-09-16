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
  type ActionNoticeState,
  PageHeader,
} from "@/components/ui";
import { IconCart } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

interface Listing {
  id: string;
  slug: string;
  name: string;
  version: string;
  summary: string;
  status: string;
  capabilityIds: string[];
  installedHere: boolean;
}

export default function MarketplacePage() {
  const __enabled = useModuleEnabled("creator");
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  // Publisher surface: signed manifests, verified before they go live.
  const [manifest, setManifest] = useState("");
  const [signature, setSignature] = useState("");
  const [publisherKey, setPublisherKey] = useState("");
  const [verdict, setVerdict] = useState<{ valid: boolean; problems?: string[] } | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await callApi<{ listings?: Listing[] }>("/api/marketplace");
    setListings(res.data?.listings ?? []);
    if (res.error) setNotice({ tone: "error", error: res.error });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function install(id: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/marketplace", { action: "install", listingId: id });
      if (res.status === 202) setNotice({ tone: "pending", text: "Install requires approval." });
      else if (!res.ok) if (res.error) setNotice({ tone: "error", error: res.error });
      else {
        setNotice({ tone: "success", text: "Plugin installed after signature re-verification." });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  function publishPayload() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      return null;
    }
    if (!signature.trim() || !publisherKey.trim()) return null;
    return { manifest: parsed, signatureBase64: signature.trim(), publisherPublicKeyBase64: publisherKey.trim() };
  }

  async function verify(): Promise<void> {
    const payload = publishPayload();
    if (!payload) {
      setVerdict({ valid: false, problems: ["Manifest must be valid JSON, and signature + publisher key are required."] });
      return;
    }
    setVerifyBusy(true);
    const res = await postApi<{ valid: boolean; problems?: string[] }>("/api/marketplace", { action: "verify", ...payload });
    setVerifyBusy(false);
    setVerdict(res.ok ? (res.data ?? { valid: true }) : { valid: false, problems: [res.error?.hint ?? "Verification failed"] });
  }

  async function publish(): Promise<void> {
    const payload = publishPayload();
    if (!payload) return;
    setBusy(true);
    const res = await postApi("/api/marketplace", { action: "publish", ...payload });
    setBusy(false);
    if (res.status === 202) setNotice({ tone: "pending", text: "Publishing requires approval." });
    else if (!res.ok) setNotice({ tone: "error", error: res.error! });
    else {
      setNotice({ tone: "success", text: "Listing published and verified." });
      setManifest("");
      setSignature("");
      setPublisherKey("");
      setVerdict(null);
      await load();
    }
  }

  if (!listings) return <LoadingPage />;

  if (!__enabled) return <ModuleDisabled label="Marketplace" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketplace"
        description="Community capability packages, every listing is cryptographically signed by its publisher and re-verified before install"
      />
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      <Card>
        <CardTitle>Publish a plugin</CardTitle>
        <div className="space-y-2 text-sm">
          <div>
            <label htmlFor="pub-manifest" className="label">
              Plugin manifest (JSON)
            </label>
            <textarea
              id="pub-manifest"
              rows={5}
              className="textarea w-full font-mono text-xs"
              placeholder='{"name":"…","version":"1.0.0","capabilities":[…]}'
              value={manifest}
              onChange={(e) => setManifest(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-56 flex-1">
              <label htmlFor="pub-signature" className="label">
                Signature (base64)
              </label>
              <input
                id="pub-signature"
                className="input font-mono text-xs"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
              />
            </div>
            <div className="min-w-56 flex-1">
              <label htmlFor="pub-key" className="label">
                Publisher public key (base64)
              </label>
              <input
                id="pub-key"
                className="input font-mono text-xs"
                value={publisherKey}
                onChange={(e) => setPublisherKey(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button tone="secondary" disabled={verifyBusy} onClick={() => void verify()}>
              {verifyBusy ? "Verifying…" : "Verify signature"}
            </Button>
            <Button loading={busy} disabled={!publishPayload()} onClick={() => void publish()}>
              Publish listing
            </Button>
            {verdict && (
              <span className={verdict.valid ? "text-sm text-emerald-700" : "text-sm text-red-700"}>
                {verdict.valid ? "signature valid" : `invalid: ${(verdict.problems ?? []).join("; ")}`}
              </span>
            )}
          </div>
          <p className="text-xs opacity-50">
            Every listing is cryptographically signed by its publisher and re-verified before anyone can install it.
          </p>
        </div>
      </Card>

      {listings.length === 0 ? (
        <Card>
          <EmptyState icon={<IconCart />} title="No published packages yet" hint="Publish one from Creator Mode with creator.publishListing." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {listings.map((l) => (
            <Card key={l.id}>
              <CardTitle
                right={
                  <Badge tone={l.installedHere ? "green" : l.status === "verified" ? "blue" : "amber"}>
                    {l.installedHere ? "installed" : l.status}
                  </Badge>
                }
              >
                {l.name}
              </CardTitle>
              <p className="text-sm opacity-70">{l.summary}</p>
              <p className="mt-1 font-mono text-xs opacity-60">
                {l.slug} v{l.version}
              </p>
              <p className="mt-1 text-xs opacity-60">Capabilities: {l.capabilityIds.join(", ")}</p>
              <div className="mt-3">
                {l.installedHere ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      await postApi("/api/marketplace", { action: "uninstall", listingId: l.id });
                      await load();
                    }}
                  >
                    Uninstall
                  </Button>
                ) : (
                  <Button size="sm" loading={busy} onClick={() => install(l.id)}>
                    Install (signature-checked)
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
