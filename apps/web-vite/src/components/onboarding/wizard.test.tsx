import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./Wizard";
import { guessMapping, parseCsv } from "./CsvImport";

// The wizard renders a large tree in development React, and this file shares a
// loaded machine with the rest of the suite, so the default 5s per test is not
// enough headroom for a slow render.
vi.setConfig({ testTimeout: 20_000 });

/**
 * The setup wizard, driven the way a person drives it.
 *
 * The pure rules (screens, validation, deferred steps) live beside the wizard
 * in `Wizard.tsx`; these prove the rules are actually wired to the screen: the
 * button is disabled when it should be, a failure offers the way out it claims
 * to, and a step someone skipped comes back instead of disappearing.
 *
 * Everything goes through the real API clients against a stubbed `fetch`, so
 * these assertions are about the requests the wizard actually makes: urls,
 * methods and bodies, including the persisted bootstrap intent.
 */

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

const TEAM_BODY = { members: [], roles: [], catalog: [] };
const CREATE_BODY = { orgId: "3f1c9a52-0d2b-4c8f-9a51-5f2f7c2a1b30" };
const STATE_BODY = { state: { path: "fresh", steps: {}, startedAt: "2026-01-01T00:00:00.000Z" } };

let calls: FetchCall[] = [];
let respond: (call: FetchCall) => { status: number; body: Record<string, unknown> };

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  calls = [];
  respond = (call) => {
    if (call.url === "/api/onboarding" && call.method === "POST") return { status: 200, body: CREATE_BODY };
    if (call.url === "/api/onboarding") return { status: 200, body: STATE_BODY };
    if (call.url === "/api/team" && call.method === "GET") return { status: 200, body: TEAM_BODY };
    if (call.url === "/api/team") return { status: 200, body: { ok: true, data: {} } };
    return { status: 200, body: {} };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: FetchCall = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      };
      calls.push(call);
      const { status, body } = respond(call);
      return jsonResponse(status, body);
    }),
  );
  // jsdom has no layout engine, and the wizard scrolls to top between steps.
  window.scrollTo = vi.fn();
  window.history.replaceState(null, "", "/onboarding");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderWizard() {
  render(<OnboardingWizard email="owner@example.com" />);
}

function buttonNamed(name: RegExp | string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

const DESCRIPTION = "We design and sell handmade lighting fixtures online and to interior designers.";

async function choosePath(title: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: title }));
  fireEvent.click(buttonNamed(/^Continue/i));
  await screen.findByLabelText("What does your business do?");
}

async function fillProfile(orgName = "Glow Works") {
  fireEvent.change(screen.getByLabelText("Business name"), { target: { value: orgName } });
  fireEvent.change(screen.getByLabelText("What does your business do?"), {
    target: { value: DESCRIPTION },
  });
}

describe("OnboardingWizard - choosing a path", () => {
  it("opens on the path screen and will not continue until one is picked", () => {
    renderWizard();
    expect(screen.getByText("How would you like to start?")).toBeTruthy();
    expect(buttonNamed(/^Continue/i).disabled).toBe(true);
  });

  it("enables Continue once a path is chosen", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /Import a spreadsheet/i }));
    expect(buttonNamed(/^Continue/i).disabled).toBe(false);
  });

  it("marks the chosen path as selected and leaves the others alone", () => {
    renderWizard();
    const importPath = screen.getByRole("button", { name: /Import a spreadsheet/i });
    const freshPath = screen.getByRole("button", { name: /Start from scratch/i });
    fireEvent.click(importPath);
    expect(importPath.getAttribute("aria-pressed")).toBe("true");
    expect(freshPath.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("OnboardingWizard - describing the business", () => {
  it("keeps 'Open my books' disabled until the name and description are enough", async () => {
    renderWizard();
    await choosePath(/Start from scratch/i);
    expect(buttonNamed(/Open my books/i).disabled).toBe(true);

    await fillProfile();
    expect(buttonNamed(/Open my books/i).disabled).toBe(false);
  });

  it("counts the description down to the minimum instead of refusing silently", async () => {
    renderWizard();
    await choosePath(/Start from scratch/i);
    fireEvent.change(screen.getByLabelText("What does your business do?"), {
      target: { value: "We sell lamps" },
    });
    expect(screen.getByText("13/20 characters minimum")).toBeTruthy();
    expect(screen.getByText(/Add 7 more characters about what you do to continue/)).toBeTruthy();
  });

  it("goes back to the path screen without losing the choice", async () => {
    renderWizard();
    await choosePath(/Import a spreadsheet/i);
    fireEvent.click(buttonNamed(/^Back$/i));
    expect(screen.getByRole("button", { name: /Import a spreadsheet/i }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("OnboardingWizard - opening the books", () => {
  it("posts the profile and records the steps the chosen path defers", async () => {
    renderWizard();
    await choosePath(/Import a spreadsheet/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const create = calls.find((c) => c.method === "POST");
    expect(create?.url).toBe("/api/onboarding");
    expect(create?.body).toMatchObject({
      orgName: "Glow Works",
      businessDescription: DESCRIPTION,
      baseCurrency: "USD",
      path: "import",
      deferredSteps: ["import_customers", "import_products"],
    });
  });

  it("marks the profile done and moves to the data screen for the import path", async () => {
    renderWizard();
    await choosePath(/Import a spreadsheet/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByText("Bring your records over");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.body?.step === "business_profile")).toBe(true),
    );
  });

  it("skips the data screen entirely for 'start from scratch'", async () => {
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByText("Who else works here?");
    expect(screen.queryByText("Bring your records over")).toBeNull();
  });

  it("sends the chosen currency, including a hand-typed ISO code", async () => {
    renderWizard();
    await choosePath(/Start from scratch/i);
    fireEvent.change(screen.getByLabelText("Currency your books are kept in"), {
      target: { value: "other" },
    });
    fireEvent.change(screen.getByLabelText("Currency ISO code"), { target: { value: "ngn" } });
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ baseCurrency: "NGN" });
  });
});

describe("OnboardingWizard - when it fails", () => {
  it("offers a way back in when the session has expired", async () => {
    respond = (call) => (call.method === "POST" ? { status: 401, body: { code: "unauthorized" } } : { status: 200, body: STATE_BODY });
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your session ended");
    expect(screen.getByRole("link", { name: "Sign in again" })).toBeTruthy();
  });

  it("passes on the server's own countdown when rate limited", async () => {
    respond = (call) =>
      call.method === "POST"
        ? { status: 429, body: { code: "rate_limited", error: "Try again in 30 seconds." } }
        : { status: 200, body: STATE_BODY };
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many attempts");
    expect(alert.textContent).toContain("Try again in 30 seconds.");
  });

  it("never shows a raw server blob as the message", async () => {
    respond = (call) =>
      call.method === "POST"
        ? { status: 500, body: { code: "boom", error: '{"sql":"select 1"}' } }
        : { status: 200, body: STATE_BODY };
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That didn't work");
    expect(alert.textContent).not.toContain("select 1");
  });

  it("stays on the profile screen so nothing typed is lost", async () => {
    respond = (call) =>
      call.method === "POST" ? { status: 500, body: { code: "boom" } } : { status: 200, body: STATE_BODY };
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByRole("alert");
    expect((screen.getByLabelText("Business name") as HTMLInputElement).value).toBe("Glow Works");
  });

  it("holds the wizard when the create is parked for approval instead of advancing", async () => {
    respond = (call) =>
      call.method === "POST"
        ? { status: 202, body: { ok: false, pendingApproval: true, reason: "Owner review" } }
        : { status: 200, body: STATE_BODY };
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    const notice = await screen.findByText("Waiting for approval");
    expect(notice.parentElement?.textContent).toContain("Owner review");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("What does your business do?")).toBeTruthy();
  });
});

describe("OnboardingWizard - a lost response must not create two workspaces", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stamps the create with an intent id and retries the same one after a failure", async () => {
    let attempt = 0;
    respond = (call) => {
      if (call.method === "POST" && call.url === "/api/onboarding") {
        attempt += 1;
        if (attempt === 1) return { status: 502, body: { code: "server_error" } };
        return { status: 200, body: CREATE_BODY };
      }
      if (call.url === "/api/onboarding") return { status: 200, body: STATE_BODY };
      return { status: 200, body: TEAM_BODY };
    };
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));
    await screen.findByRole("alert");

    // The response was lost, but the intent was not: the retry reuses it.
    fireEvent.click(buttonNamed(/Open my books/i));
    await screen.findByText("Who else works here?");

    const creates = calls.filter((c) => c.method === "POST" && c.url === "/api/onboarding");
    expect(creates).toHaveLength(2);
    const ids = creates.map((c) => String(c.body?.intentId));
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it("clears the intent once the workspace exists, so a later setup gets its own", async () => {
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByText("Who else works here?");
    expect(window.localStorage.getItem("chaste:onboarding-intent")).toBeNull();
  });
});

describe("OnboardingWizard - skipping is remembered, not dropped", () => {
  it("brings deferred steps back on the done screen", async () => {
    renderWizard();
    await choosePath(/Import a spreadsheet/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByText("Bring your records over");
    fireEvent.click(buttonNamed(/Continue without importing/i));

    await screen.findByText("Who else works here?");
    fireEvent.click(buttonNamed(/Skip for now/i));

    await screen.findByText("Still on your list");
    expect(screen.getByText("Bring in your customers")).toBeTruthy();
  });

  it("records each skipped step as skipped, not as done", async () => {
    renderWizard();
    await choosePath(/Import a spreadsheet/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByText("Bring your records over");
    fireEvent.click(buttonNamed(/Continue without importing/i));
    await screen.findByText("Who else works here?");

    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PATCH" && c.body?.status === "skipped").map((c) => c.body?.step),
      ).toEqual(expect.arrayContaining(["import_customers", "import_products"])),
    );
  });
});

describe("OnboardingWizard - inviting the team", () => {
  it("loads real roles and reports an approval-pending invite as queued", async () => {
    const roleId = "8b5e2a10-1f4d-4d1e-9b31-2f0a7c6d5e44";
    respond = (call) => {
      if (call.url === "/api/team" && call.method === "GET") {
        return { status: 200, body: { ...TEAM_BODY, roles: [{ id: roleId, key: "accountant", name: "Accountant", isSystem: false, permissions: [] }] } };
      }
      if (call.url === "/api/team") return { status: 202, body: { ok: false, pendingApproval: true, reason: "Owner review" } };
      if (call.url === "/api/onboarding" && call.method === "POST") return { status: 200, body: CREATE_BODY };
      return { status: 200, body: STATE_BODY };
    };
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));
    await screen.findByText("Who else works here?");

    const roleSelect = await screen.findByLabelText("Role");
    await waitFor(() => expect((roleSelect as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "colleague@company.com" } });
    fireEvent.change(roleSelect, { target: { value: roleId } });
    fireEvent.click(buttonNamed(/Send invites/i));

    const note = await screen.findByText(/Queued for approval/);
    expect(note.textContent).toContain("colleague@company.com");
    const invite = calls.find((call) => call.url === "/api/team" && call.method === "POST");
    expect(invite?.body).toMatchObject({ action: "invite", email: "colleague@company.com", roleId });
    expect(String(invite?.body?.intentId)).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("OnboardingWizard - finishing", () => {
  it("completes setup and hands the user to their workspace", async () => {
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByText("Who else works here?");
    fireEvent.click(buttonNamed(/Skip for now/i));

    await screen.findByText(/is ready/);
    fireEvent.click(buttonNamed(/Go to my workspace/i));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.body?.complete === true)).toBe(true),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });
});

describe("OnboardingWizard - the CSV rules behind the import step", () => {
  it("reads quoted fields, drops a UTF-8 BOM and trims every cell", () => {
    const table = parseCsv("\uFEFFName,Note\r\n\"Glow, Works\",\"He said \"\"yes\"\"\"\r\nPantry Co,\r\n");
    expect(table.headers).toEqual(["Name", "Note"]);
    expect(table.rows).toEqual([
      { Name: "Glow, Works", Note: 'He said "yes"' },
      { Name: "Pantry Co", Note: "" },
    ]);
  });

  it("matches exact headings before substring synonyms, and asks instead of guessing", () => {
    expect(guessMapping("products", ["Item Code", "Unit Price", "Name", "Notes"])).toMatchObject({
      sku: "Item Code",
      name: "Name",
      salePrice: "Unit Price",
      // "Notes" is too short a synonym to claim the unit column by accident.
      unitLabel: null,
      barcode: null,
    });
  });
});