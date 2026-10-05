import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveOrganization } from "./ActiveOrganization";

const firstOrgId = "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12";
const secondOrgId = "21e89f2b-996f-4b18-9078-c0f2f743a5ab";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(orgResponse: Response, switchResponse = Response.json({ ok: true })) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(init?.method === "POST" ? switchResponse : orgResponse),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("active organization selector", () => {
  it("shows only the memberships returned for the signed-in user", async () => {
    stubFetch(Response.json({
      activeOrgId: firstOrgId,
      orgs: [
        { id: firstOrgId, name: "First workspace" },
        { id: secondOrgId, name: "Second workspace" },
      ],
    }));

    const onActiveOrgIdChange = vi.fn();
    render(<ActiveOrganization onActiveOrgIdChange={onActiveOrgIdChange} />);

    const selector = await screen.findByRole("combobox", { name: "Active organization" });
    expect((selector as HTMLSelectElement).value).toBe(firstOrgId);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "First workspace",
      "Second workspace",
    ]);
    await waitFor(() => expect(onActiveOrgIdChange).toHaveBeenCalledWith(firstOrgId));
  });

  it("keeps existing sign-in as the session authority", async () => {
    stubFetch(new Response(null, { status: 401 }));

    render(<ActiveOrganization />);

    expect(await screen.findByText("Sign in to the existing application to view your organizations.")).not.toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("turns a slow organization service into a recoverable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Request timed out", "TimeoutError")));

    render(<ActiveOrganization />);

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("The organization service took too long. Try again.");
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
  });

  it("waits for the server to set the active-org cookie before reloading", async () => {
    let resolveSwitch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => { resolveSwitch = resolve; });
      }
      return Promise.resolve(Response.json({
        activeOrgId: firstOrgId,
        orgs: [
          { id: firstOrgId, name: "First workspace" },
          { id: secondOrgId, name: "Second workspace" },
        ],
      }));
    });
    const onChanged = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ActiveOrganization onChanged={onChanged} />);
    const selector = await screen.findByRole("combobox", { name: "Active organization" });
    fireEvent.change(selector, { target: { value: secondOrgId } });

    expect((selector as HTMLSelectElement).disabled).toBe(true);
    expect((await screen.findByRole("status")).textContent).toContain("Saving");
    expect(fetchMock).toHaveBeenCalledWith("/api/org", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ orgId: secondOrgId }),
    }));
    expect(onChanged).not.toHaveBeenCalled();

    await act(async () => resolveSwitch?.(Response.json({ ok: true })));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(secondOrgId));
    expect((selector as HTMLSelectElement).disabled).toBe(false);
  });

  it("reports the active and newly selected org currency after the cookie switch succeeds", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(
      init?.method === "POST"
        ? Response.json({ ok: true })
        : Response.json({
            activeOrgId: firstOrgId,
            orgs: [
              { id: firstOrgId, name: "First workspace", baseCurrency: "USD" },
              { id: secondOrgId, name: "Second workspace", baseCurrency: "UGX" },
            ],
          }),
    ));
    const onCurrencyChanged = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ActiveOrganization onCurrencyChanged={onCurrencyChanged} onChanged={() => undefined} />);
    const selector = await screen.findByRole("combobox", { name: "Active organization" });
    await waitFor(() => expect(onCurrencyChanged).toHaveBeenCalledWith("USD"));

    fireEvent.change(selector, { target: { value: secondOrgId } });
    await waitFor(() => expect(onCurrencyChanged).toHaveBeenLastCalledWith("UGX"));
    expect((selector as HTMLSelectElement).value).toBe(secondOrgId);
  });

  it("shows server rejection and leaves the current organization unchanged", async () => {
    stubFetch(
      Response.json({ activeOrgId: firstOrgId, orgs: [{ id: firstOrgId, name: "First workspace" }, { id: secondOrgId, name: "Second workspace" }] }),
      new Response(null, { status: 403 }),
    );
    const onChanged = vi.fn();

    render(<ActiveOrganization onChanged={onChanged} />);
    const selector = await screen.findByRole("combobox", { name: "Active organization" });
    fireEvent.change(selector, { target: { value: secondOrgId } });

    expect((await screen.findByRole("alert")).textContent).toContain("Your account or organization access needs attention.");
    expect((selector as HTMLSelectElement).value).toBe(firstOrgId);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not create an organization selector when no memberships are available", async () => {
    stubFetch(Response.json({ activeOrgId: null, orgs: [] }));

    render(<ActiveOrganization />);

    expect(await screen.findByText("No organization access is available for this account.")).not.toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
