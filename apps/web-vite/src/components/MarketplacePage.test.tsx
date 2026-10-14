import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplacePage } from "./MarketplacePage";

const listing = {
  id: "7de066f0-4bdb-4f46-9b6a-193064f5b235",
  slug: "acme-warehouse",
  name: "Acme Warehouse Tools",
  version: "1.2.3",
  summary: "Cycle counting and bin transfer capabilities.",
  status: "verified",
  capabilityIds: ["inventory.cycleCount", "inventory.transfer"],
  installedByOrgIds: [],
  installedHere: false,
  updatedAt: "2026-09-20T09:30:00.000Z",
};

function modules(enabled = true) {
  return Response.json({
    catalog: [{ id: "creator", label: "Creator Mode", description: "Manage plugins", href: "/marketplace" }],
    enabledModules: enabled ? ["creator"] : [],
    usingDefaults: false,
  });
}

function isCapabilityRequest(input: RequestInfo | URL, init: RequestInit | undefined, capabilityId: string): boolean {
  if (String(input) !== "/api/capabilities/execute" || init?.method !== "POST") return false;
  try {
    return (JSON.parse(String(init.body ?? "{}")) as { capabilityId?: string }).capabilityId === capabilityId;
  } catch {
    return false;
  }
}

function marketplaceListings(listings: unknown[]) {
  return Response.json({ ok: true, data: { listings } });
}

function fillPublishForm() {
  fireEvent.change(screen.getByLabelText("Plugin manifest (JSON)"), { target: { value: '{"formatVersion":1,"slug":"acme-warehouse"}' } });
  fireEvent.change(screen.getByLabelText("Signature (base64)"), { target: { value: "signature" } });
  fireEvent.change(screen.getByLabelText("Publisher public key (base64)"), { target: { value: "public-key" } });
}

const retryScope = { actorId: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111" };

beforeEach(() => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() } });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Vite marketplace page", () => {
  it("rejects malformed listing rows instead of rendering untrusted metadata", async () => {
    const legacyListing = {
      ...listing,
      capabilityIds: ["inventory.cycleCount", { legacy: true }],
      installedByOrgIds: { unexpected: true },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([legacyListing]);
      return new Response(null, { status: 404 });
    }));

    render(<MarketplacePage {...retryScope} />);

    expect((await screen.findByRole("alert")).textContent).toContain("unexpected format");
  });

  it("loads full marketplace rows and installs through Go before refreshing installed state", async () => {
    let installed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.installListing")) {
        const payload = JSON.parse(String(init?.body)) as { input?: { listingId?: string }; intentId?: string };
        expect(payload).toMatchObject({ input: { listingId: listing.id } });
        expect(payload.intentId).toEqual(expect.any(String));
        installed = true;
        return Response.json({ ok: true, data: { installed: true, slug: listing.slug, version: listing.version } });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([{ ...listing, installedHere: installed }]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);

    expect(await screen.findByRole("heading", { name: "Acme Warehouse Tools" })).not.toBeNull();
    expect(screen.getByText("Capabilities: inventory.cycleCount, inventory.transfer")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install (signature-checked)" }));

    expect(await screen.findByText("Plugin installed after signature re-verification.")).not.toBeNull();
    await waitFor(() => expect(screen.getByText("installed")).not.toBeNull());
    expect(fetchMock.mock.calls.some(([input, callInit]) => isCapabilityRequest(input, callInit, "creator.installListing"))).toBe(true);
    expect(fetchMock.mock.calls.filter(([input, callInit]) => isCapabilityRequest(input, callInit, "creator.listMarketplace"))).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("offers install only for verified listings and keeps uninstall available for existing installs", async () => {
    const submitted = { ...listing, id: "8de066f0-4bdb-4f46-9b6a-193064f5b235", name: "Awaiting review", status: "submitted" };
    let rejectedInstalled = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.uninstallListing")) {
        const payload = JSON.parse(String(init?.body)) as { input?: { listingId?: string }; intentId?: string };
        expect(payload).toMatchObject({ input: { listingId: "9de066f0-4bdb-4f46-9b6a-193064f5b235" }, intentId: expect.any(String) });
        rejectedInstalled = false;
        return Response.json({ ok: true, data: { uninstalled: true } });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) {
        return marketplaceListings([
          submitted,
          { ...listing, id: "9de066f0-4bdb-4f46-9b6a-193064f5b235", name: "Previously installed package", status: "rejected", installedHere: rejectedInstalled },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);

    expect(await screen.findByRole("heading", { name: submitted.name })).not.toBeNull();
    expect(screen.getByText("Installation is unavailable while this listing is submitted.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Uninstall" })).not.toBeNull();
    expect(screen.getByText("rejected")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Install (signature-checked)" })).toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => isCapabilityRequest(input, init, "creator.installListing"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));

    expect(await screen.findByText("Plugin uninstalled.")).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull());
    expect(screen.getByText("Installation is unavailable while this listing is rejected.")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => isCapabilityRequest(input, init, "creator.uninstallListing"))).toBe(true);
    expect(fetchMock.mock.calls.filter(([input, init]) => isCapabilityRequest(input, init, "creator.listMarketplace"))).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("publishes through Go, clears the form, and refreshes listing data", async () => {
    let published = false;
    const publishedListing = { ...listing, name: "Published from Go", slug: "acme-warehouse" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.publishListing")) {
        const body = JSON.parse(String(init?.body)) as { input?: Record<string, unknown> };
        expect(body.input).toEqual({
          manifest: { formatVersion: 1, slug: "acme-warehouse" },
          signatureBase64: "signature",
          publisherPublicKeyBase64: "public-key",
        });
        published = true;
        return Response.json({ ok: true, data: {
          listingId: listing.id,
          slug: "acme-warehouse",
          status: "verified",
        } });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings(published ? [publishedListing] : []);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    await screen.findByRole("heading", { name: "Publish a plugin" });
    fillPublishForm();
    fireEvent.click(screen.getByRole("button", { name: "Publish listing" }));

    expect(await screen.findByText("Listing published and verified.")).not.toBeNull();
    expect(await screen.findByRole("heading", { name: publishedListing.name })).not.toBeNull();
    expect((screen.getByLabelText("Plugin manifest (JSON)") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Signature (base64)") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Publisher public key (base64)") as HTMLInputElement).value).toBe("");
    expect(fetchMock.mock.calls.some(([input, init]) => isCapabilityRequest(input, init, "creator.publishListing"))).toBe(true);
    expect(fetchMock.mock.calls.filter(([input, init]) => isCapabilityRequest(input, init, "creator.listMarketplace"))).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("shows a Go publish approval notice and retains the draft for review", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.publishListing")) {
        return Response.json({
          ok: false,
          pendingApproval: true,
          reason: "A second publisher must review this listing.",
          approvalId: "d81d8459-9a20-4c8e-a88c-27866dd552aa",
        }, { status: 202 });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    await screen.findByRole("heading", { name: "Publish a plugin" });
    fillPublishForm();
    fireEvent.click(screen.getByRole("button", { name: "Publish listing" }));

    expect(await screen.findByText("A second publisher must review this listing.")).not.toBeNull();
    expect((screen.getByLabelText("Plugin manifest (JSON)") as HTMLTextAreaElement).value).toContain("acme-warehouse");
    expect(fetchMock.mock.calls.filter(([input, init]) => isCapabilityRequest(input, init, "creator.listMarketplace"))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("shows Go publish errors without clearing the draft or calling the legacy route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.publishListing")) {
        return Response.json({ ok: false, error: "slug is owned by another publisher" }, { status: 422 });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    await screen.findByRole("heading", { name: "Publish a plugin" });
    fillPublishForm();
    fireEvent.click(screen.getByRole("button", { name: "Publish listing" }));

    expect((await screen.findByRole("alert")).textContent).toContain("slug is owned by another publisher");
    expect((screen.getByLabelText("Plugin manifest (JSON)") as HTMLTextAreaElement).value).toContain("acme-warehouse");
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("uninstalls through Go and refreshes installed state without the legacy route", async () => {
    let installedHere = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.uninstallListing")) {
        const payload = JSON.parse(String(init?.body)) as { input?: { listingId?: string }; intentId?: string };
        expect(payload.input).toEqual({ listingId: listing.id });
        expect(payload.intentId).toEqual(expect.any(String));
        installedHere = false;
        return Response.json({ ok: true, data: { uninstalled: true } });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) {
        return marketplaceListings([{ ...listing, installedHere }]);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    expect(await screen.findByRole("heading", { name: listing.name })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));

    expect(await screen.findByText("Plugin uninstalled.")).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Install (signature-checked)" })).not.toBeNull());
    expect(fetchMock.mock.calls.filter(([input, callInit]) => isCapabilityRequest(input, callInit, "creator.listMarketplace"))).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("does not report success when a mutation response violates its contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.installListing")) {
        return Response.json({ ok: true, data: { listingId: listing.id } });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([listing]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    expect(await screen.findByRole("heading", { name: listing.name })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install (signature-checked)" }));

    expect((await screen.findByRole("alert")).textContent).toContain("The marketplace returned an unexpected action response.");
    expect(screen.queryByText("Plugin installed after signature re-verification.")).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("does not treat an incomplete approval response as a pending action", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.installListing")) {
        return Response.json({ pendingApproval: true }, { status: 202 });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([listing]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    expect(await screen.findByRole("heading", { name: listing.name })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install (signature-checked)" }));

    expect((await screen.findByRole("alert")).textContent).toContain("The marketplace returned an unexpected approval response.");
    expect(screen.queryByText("Plugin installed after signature re-verification.")).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("reports failed signature verification without publishing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.verifyPlugin")) {
        return Response.json({ ok: true, data: { valid: false, reason: "signature does not match manifest digest" } });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    await screen.findByRole("heading", { name: "Publish a plugin" });
    fireEvent.change(screen.getByLabelText("Plugin manifest (JSON)"), { target: { value: '{"formatVersion":1}' } });
    fireEvent.change(screen.getByLabelText("Signature (base64)"), { target: { value: "signature" } });
    fireEvent.change(screen.getByLabelText("Publisher public key (base64)"), { target: { value: "public-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify signature" }));

    expect(await screen.findByText("Invalid: signature does not match manifest digest")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const verifyCall = fetchMock.mock.calls.find(([input, init]) => isCapabilityRequest(input, init, "creator.verifyPlugin"));
    expect(verifyCall).toBeDefined();
    expect(JSON.parse(String(verifyCall?.[1]?.body))).toMatchObject({
      capabilityId: "creator.verifyPlugin",
      input: { manifest: { formatVersion: 1 }, signatureBase64: "signature", publisherPublicKeyBase64: "public-key" },
      intentId: expect.any(String),
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("reports a valid Go verification verdict without calling the legacy route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.verifyPlugin")) return Response.json({ ok: true, data: { valid: true } });
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    await screen.findByRole("heading", { name: "Publish a plugin" });
    fireEvent.change(screen.getByLabelText("Plugin manifest (JSON)"), { target: { value: '{"formatVersion":1}' } });
    fireEvent.change(screen.getByLabelText("Signature (base64)"), { target: { value: "signature" } });
    fireEvent.change(screen.getByLabelText("Publisher public key (base64)"), { target: { value: "public-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify signature" }));

    expect(await screen.findByText("Signature valid")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => isCapabilityRequest(input, init, "creator.verifyPlugin"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("surfaces marketplace verification permission errors without hiding them as malformed responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (isCapabilityRequest(input, init, "creator.verifyPlugin")) {
        return Response.json({ ok: false, error: "missing capability permission platform.creator" }, { status: 403 });
      }
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);
    await screen.findByRole("heading", { name: "Publish a plugin" });
    fireEvent.change(screen.getByLabelText("Plugin manifest (JSON)"), { target: { value: '{"formatVersion":1}' } });
    fireEvent.change(screen.getByLabelText("Signature (base64)"), { target: { value: "signature" } });
    fireEvent.change(screen.getByLabelText("Publisher public key (base64)"), { target: { value: "public-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify signature" }));

    expect(await screen.findByText("Invalid: missing capability permission platform.creator")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("loads listings but hides Creator actions while Creator Mode is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return modules(false);
      if (isCapabilityRequest(input, init, "creator.listMarketplace")) return marketplaceListings([listing]);
      if (isCapabilityRequest(input, init, "creator.verifyPlugin")) return Response.json({ ok: true, data: { valid: false, reason: "signature mismatch" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage {...retryScope} />);

    expect(await screen.findByRole("heading", { name: listing.name })).not.toBeNull();
    expect(screen.getByText(/Creator Mode is disabled.*browse and verify packages/i)).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Publish a plugin" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Install|Uninstall/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish listing" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Plugin manifest (JSON)"), { target: { value: '{"formatVersion":1}' } });
    fireEvent.change(screen.getByLabelText("Signature (base64)"), { target: { value: "signature" } });
    fireEvent.change(screen.getByLabelText("Publisher public key (base64)"), { target: { value: "public-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify signature" }));
    expect(await screen.findByText("Invalid: signature mismatch")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => isCapabilityRequest(input, init, "creator.listMarketplace"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input, init]) => isCapabilityRequest(input, init, "creator.verifyPlugin"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input, init]) => ["creator.publishListing", "creator.installListing", "creator.uninstallListing"].some((id) => isCapabilityRequest(input, init, id)))).toBe(false);
  });
});
