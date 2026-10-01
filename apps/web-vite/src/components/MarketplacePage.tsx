import { useCallback, useEffect, useState } from "react";
import {
  fetchMarketplaceEnabled,
  fetchMarketplaceListings,
  MarketplaceApiError,
  submitMarketplaceAction,
  verifyMarketplaceListing,
  type MarketplaceListing,
} from "../api/marketplace";
import "./MarketplacePage.css";

type LoadState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "disabled" }
  | { status: "ready"; listings: MarketplaceListing[] };
type Notice = { tone: "success" | "pending" | "error"; message: string };

function messageFor(error: unknown): string {
  return error instanceof MarketplaceApiError
    ? error.message
    : "Could not reach the marketplace service. Check your connection and try again.";
}

export function MarketplacePage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyListingId, setBusyListingId] = useState<string | null>(null);
  const [manifest, setManifest] = useState("");
  const [signature, setSignature] = useState("");
  const [publisherKey, setPublisherKey] = useState("");
  const [verdict, setVerdict] = useState<{ valid: boolean; reason?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setState({ status: "loading" });
    try {
      const enabled = await fetchMarketplaceEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const listings = await fetchMarketplaceListings(signal);
      if (!signal?.aborted) setState({ status: "ready", listings });
    } catch (error) {
      if (!signal?.aborted) setState({ status: "failed", message: messageFor(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function publishPayload(): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      return null;
    }
    if (!signature.trim() || !publisherKey.trim()) return null;
    return { manifest: parsed, signatureBase64: signature.trim(), publisherPublicKeyBase64: publisherKey.trim() };
  }

  async function verify() {
    const payload = publishPayload();
    if (!payload) {
      setVerdict({ valid: false, reason: "Manifest must be valid JSON, and signature and publisher key are required." });
      return;
    }
    setVerifying(true);
    try {
      setVerdict(await verifyMarketplaceListing({ action: "verify", ...payload }));
    } catch (error) {
      setVerdict({ valid: false, reason: messageFor(error) });
    } finally {
      setVerifying(false);
    }
  }

  async function publish() {
    const payload = publishPayload();
    if (!payload) return;
    setPublishing(true);
    setNotice(null);
    try {
      const result = await submitMarketplaceAction({ action: "publish", ...payload });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", message: result.reason });
      } else {
        setNotice({ tone: "success", message: "Listing published and verified." });
        setManifest("");
        setSignature("");
        setPublisherKey("");
        setVerdict(null);
        await load();
      }
    } catch (error) {
      setNotice({ tone: "error", message: messageFor(error) });
    } finally {
      setPublishing(false);
    }
  }

  async function listingAction(listing: MarketplaceListing, action: "install" | "uninstall") {
    setBusyListingId(listing.id);
    setNotice(null);
    try {
      const result = await submitMarketplaceAction({ action, listingId: listing.id });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", message: result.reason });
      } else {
        setNotice({ tone: "success", message: action === "install" ? "Plugin installed after signature re-verification." : "Plugin uninstalled." });
        await load();
      }
    } catch (error) {
      setNotice({ tone: "error", message: messageFor(error) });
    } finally {
      setBusyListingId(null);
    }
  }

  if (state.status === "loading") {
    return <main className="marketplace-page" role="status">Checking Creator Mode and loading marketplace…</main>;
  }
  if (state.status === "failed") {
    return (
      <main className="marketplace-page">
        <header className="marketplace-header"><p className="shell-kicker">Creator Mode</p><h1>Marketplace</h1></header>
        <section className="marketplace-empty" role="alert">
          <p>{state.message}</p>
          <button className="shell-button" type="button" onClick={() => void load()}>Try again</button>
        </section>
      </main>
    );
  }
  if (state.status === "disabled") {
    return <main className="marketplace-page"><header className="marketplace-header"><p className="shell-kicker">Creator Mode</p><h1>Marketplace</h1></header><p className="marketplace-empty">Enable Creator Mode in organization settings to use the marketplace.</p></main>;
  }

  const listings = state.listings;
  const payloadReady = publishPayload() !== null;
  return (
    <main className="marketplace-page">
      <header className="marketplace-header">
        <p className="shell-kicker">Creator Mode</p>
        <h1>Marketplace</h1>
        <p>Community capability packages, cryptographically signed by their publishers and re-verified before install.</p>
      </header>
      {notice && <div className={`marketplace-notice marketplace-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</div>}

      <section className="marketplace-panel" aria-labelledby="publish-plugin-heading">
        <h2 id="publish-plugin-heading">Publish a plugin</h2>
        <label htmlFor="marketplace-manifest">Plugin manifest (JSON)</label>
        <textarea
          id="marketplace-manifest"
          rows={5}
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          placeholder='{"name":"Plugin name","version":"1.0.0","capabilities":[]}'
        />
        <div className="marketplace-credentials">
          <div><label htmlFor="marketplace-signature">Signature (base64)</label><input id="marketplace-signature" value={signature} onChange={(event) => setSignature(event.target.value)} /></div>
          <div><label htmlFor="marketplace-public-key">Publisher public key (base64)</label><input id="marketplace-public-key" value={publisherKey} onChange={(event) => setPublisherKey(event.target.value)} /></div>
        </div>
        <div className="marketplace-actions">
          <button className="shell-button shell-button-secondary" type="button" disabled={verifying} onClick={() => void verify()}>{verifying ? "Verifying…" : "Verify signature"}</button>
          <button className="shell-button" type="button" disabled={!payloadReady || publishing} onClick={() => void publish()}>{publishing ? "Publishing…" : "Publish listing"}</button>
          {verdict && <span className={verdict.valid ? "marketplace-valid" : "marketplace-invalid"}>{verdict.valid ? "Signature valid" : `Invalid: ${verdict.reason ?? "signature check failed"}`}</span>}
        </div>
        <p className="marketplace-help">Every listing is cryptographically signed by its publisher and re-verified before anyone can install it.</p>
      </section>

      {listings.length === 0 ? (
        <section className="marketplace-empty"><h2>No published packages yet</h2><p>Publish one from Creator Mode with creator.publishListing.</p></section>
      ) : (
        <section className="marketplace-listings" aria-label="Marketplace listings">
          {listings.map((listing) => (
            <article className="marketplace-listing" key={listing.id}>
              <div className="marketplace-listing-heading">
                <h2>{listing.name}</h2>
                <span className={`marketplace-status${listing.installedHere ? " marketplace-status-installed" : ""}`}>{listing.installedHere ? "installed" : listing.status}</span>
              </div>
              <p>{listing.summary}</p>
              <p className="marketplace-metadata">{listing.slug} v{listing.version}</p>
              <p className="marketplace-metadata">Capabilities: {listing.capabilityIds.join(", ")}</p>
              <button
                className="shell-button shell-button-secondary"
                type="button"
                disabled={busyListingId !== null}
                onClick={() => void listingAction(listing, listing.installedHere ? "uninstall" : "install")}
              >
                {busyListingId === listing.id ? "Working…" : listing.installedHere ? "Uninstall" : "Install (signature-checked)"}
              </button>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
