import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Vite marketplace page", () => {
  it("accepts legacy JSON arrays and opaque installation metadata", async () => {
    const legacyListing = {
      ...listing,
      capabilityIds: ["inventory.cycleCount", { legacy: true }],
      installedByOrgIds: { unexpected: true },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/modules") return modules();
      if (String(input) === "/api/marketplace") return Response.json({ listings: [legacyListing] });
      return new Response(null, { status: 404 });
    }));

    render(<MarketplacePage />);

    expect(await screen.findByRole("heading", { name: legacyListing.name })).not.toBeNull();
    expect(screen.getByText("Capabilities: inventory.cycleCount, [object Object]")).not.toBeNull();
  });

  it("loads full marketplace rows and installs a listing through the same-origin API", async () => {
    let installed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketplace" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as { action?: string; listingId?: string; intentId?: string };
        expect(payload).toMatchObject({ action: "install", listingId: listing.id });
        expect(payload.intentId).toEqual(expect.any(String));
        installed = true;
        return Response.json({ ok: true, data: { installed: true, slug: listing.slug, version: listing.version } });
      }
      if (path === "/api/marketplace") return Response.json({ listings: [{ ...listing, installedHere: installed }] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage />);

    expect(await screen.findByRole("heading", { name: "Acme Warehouse Tools" })).not.toBeNull();
    expect(screen.getByText("Capabilities: inventory.cycleCount, inventory.transfer")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install (signature-checked)" }));

    expect(await screen.findByText("Plugin installed after signature re-verification.")).not.toBeNull();
    await waitFor(() => expect(screen.getByText("installed")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/marketplace", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("does not report success when a mutation response violates its contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketplace" && init?.method === "POST") {
        return Response.json({ ok: true, data: { listingId: listing.id } });
      }
      if (path === "/api/marketplace") return Response.json({ listings: [listing] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage />);
    expect(await screen.findByRole("heading", { name: listing.name })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install (signature-checked)" }));

    expect((await screen.findByRole("alert")).textContent).toContain("The marketplace returned an unexpected action response.");
    expect(screen.queryByText("Plugin installed after signature re-verification.")).toBeNull();
  });

  it("does not treat an incomplete approval response as a pending action", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketplace" && init?.method === "POST") {
        return Response.json({ pendingApproval: true }, { status: 202 });
      }
      if (path === "/api/marketplace") return Response.json({ listings: [listing] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage />);
    expect(await screen.findByRole("heading", { name: listing.name })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install (signature-checked)" }));

    expect((await screen.findByRole("alert")).textContent).toContain("The marketplace returned an unexpected approval response.");
    expect(screen.queryByText("Plugin installed after signature re-verification.")).toBeNull();
  });

  it("reports failed signature verification without publishing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketplace" && init?.method === "POST") {
        return Response.json({ valid: false, reason: "signature does not match manifest digest" }, { status: 422 });
      }
      if (path === "/api/marketplace") return Response.json({ listings: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage />);
    await screen.findByRole("heading", { name: "Publish a plugin" });
    fireEvent.change(screen.getByLabelText("Plugin manifest (JSON)"), { target: { value: '{"formatVersion":1}' } });
    fireEvent.change(screen.getByLabelText("Signature (base64)"), { target: { value: "signature" } });
    fireEvent.change(screen.getByLabelText("Publisher public key (base64)"), { target: { value: "public-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify signature" }));

    expect(await screen.findByText("Invalid: signature does not match manifest digest")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces marketplace verification permission errors without hiding them as malformed responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketplace" && init?.method === "POST") {
        return Response.json({ ok: false, error: "missing capability permission platform.creator" }, { status: 403 });
      }
      if (path === "/api/marketplace") return Response.json({ listings: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage />);
    await screen.findByRole("heading", { name: "Publish a plugin" });
    fireEvent.change(screen.getByLabelText("Plugin manifest (JSON)"), { target: { value: '{"formatVersion":1}' } });
    fireEvent.change(screen.getByLabelText("Signature (base64)"), { target: { value: "signature" } });
    fireEvent.change(screen.getByLabelText("Publisher public key (base64)"), { target: { value: "public-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify signature" }));

    expect(await screen.findByText("Invalid: missing capability permission platform.creator")).not.toBeNull();
  });

  it("does not load listing data while Creator Mode is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/modules") return modules(false);
      return Response.json({ listings: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketplacePage />);

    expect(await screen.findByText("Enable Creator Mode in organization settings to use the marketplace.")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
