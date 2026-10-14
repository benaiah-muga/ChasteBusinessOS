import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OnboardingWizard, screenForResume } from "./Wizard";
import { CsvImportPanel, guessMapping, parseCsv, parseCurrencyMinor } from "./CsvImport";
import { stubWebLocks } from "../../test/web-locks";

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
let productImportSequence = 0;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  stubWebLocks();
  calls = [];
  productImportSequence = 0;
  respond = (call) => {
    if (call.url === "/api/onboarding" && call.method === "POST") return { status: 200, body: CREATE_BODY };
    if (call.url === "/api/onboarding") return { status: 200, body: STATE_BODY };
    if (call.url === "/api/team" && call.method === "GET") return { status: 200, body: TEAM_BODY };
    if (call.url === "/api/team") return { status: 200, body: { ok: true, data: {} } };
    if (call.url === "/api/capabilities/execute" && call.body?.capabilityId === "crm.importCustomers") {
      return { status: 200, body: { ok: true, data: {
        createdIds: ["10000000-0000-4000-8000-000000000020"], imported: 1, skippedDuplicateRows: [], importIntentId: call.body.intentId,
      } } };
    }
    if (call.url === "/api/capabilities/execute" && call.body?.capabilityId === "crm.undoCustomerImport") {
      const input = call.body.input as { customerIds: string[]; importIntentId: string };
      return { status: 200, body: { ok: true, data: {
        customerIds: input.customerIds, deactivated: input.customerIds.length, importIntentId: input.importIntentId, undoIntentId: call.body.intentId,
      } } };
    }
    if (call.url === "/api/capabilities/execute" && call.body?.capabilityId === "inventory.importItems") {
      productImportSequence += 1;
      return { status: 200, body: { ok: true, data: {
        createdIds: [`10000000-0000-4000-8000-${String(20 + productImportSequence).padStart(12, "0")}`], imported: 1, skippedDuplicateRows: [],
      } } };
    }
    if (call.url === "/api/capabilities/execute" && call.body?.capabilityId === "inventory.undoItemImport") {
      const input = call.body.input as { itemIds: string[] };
      return { status: 200, body: { ok: true, data: { itemIds: input.itemIds, archived: input.itemIds.length } } };
    }
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
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function renderWizard() {
  render(<OnboardingWizard email="owner@example.com" actorId="10000000-0000-4000-8000-000000000010" />);
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

describe("OnboardingWizard - resuming saved setup", () => {
  it("reopens the data step for unfinished imports with the existing workspace context", async () => {
    const actorId = "10000000-0000-4000-8000-000000000010";
    const itemId = "10000000-0000-4000-8000-000000000021";
    window.localStorage.setItem(
      `chaste:onboarding:import-undo:v1:${encodeURIComponent(actorId)}:${CREATE_BODY.orgId}:products`,
      JSON.stringify([{ entity: "products", inserted: 1, skippedDuplicates: 0, createdIds: [itemId], receiptId: itemId }]),
    );
    const resumeState = {
      path: "import" as const,
      steps: { business_profile: "done" as const, import_customers: "done" as const, import_products: "pending" as const },
      startedAt: "2026-01-01T00:00:00Z",
    };
    expect(screenForResume(resumeState)).toBe("data");

    render(
      <OnboardingWizard
        email="owner@example.com"
        actorId={actorId}
        organizationId={CREATE_BODY.orgId}
        baseCurrency="UGX"
        resumeState={resumeState}
      />,
    );

    expect(await screen.findByText("Bring your records over")).toBeTruthy();
    expect(screen.getByLabelText("Choose a CSV file")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Products/i }));
    await screen.findByText(/1 products imported/i);
    fireEvent.click(buttonNamed(/Undo this import/i));
    await screen.findByText(/Undid the import/);
    const undoCall = calls.find((call) => call.body?.capabilityId === "inventory.undoItemImport");
    expect(undoCall?.body?.input).toMatchObject({ itemIds: [itemId] });
  });

  it("keeps unfinished import setup on the data step after imports are marked done", () => {
    expect(screenForResume({
      path: "import",
      steps: { business_profile: "done", import_customers: "done", import_products: "done" },
      startedAt: "2026-01-01T00:00:00Z",
    })).toBe("data");
  });

  it("does not change completed imports to skipped when continuing a resumed setup", async () => {
    render(
      <OnboardingWizard
        email="owner@example.com"
        actorId="10000000-0000-4000-8000-000000000010"
        organizationId={CREATE_BODY.orgId}
        baseCurrency="USD"
        resumeState={{
          path: "import",
          steps: { business_profile: "done", import_customers: "done", import_products: "pending" },
          startedAt: "2026-01-01T00:00:00Z",
        }}
      />,
    );

    await screen.findByText("Bring your records over");
    fireEvent.click(buttonNamed(/Continue without importing/i));

    await waitFor(() => expect(
      calls.filter((call) => call.method === "PATCH" && call.body?.status === "skipped").map((call) => call.body?.step),
    ).toEqual(["import_products"]));
  });

  it("returns to the team step when connection setup is complete", () => {
    expect(screenForResume({
      path: "connect",
      steps: { business_profile: "done", connect_source: "done" },
      startedAt: "2026-01-01T00:00:00Z",
    })).toBe("team");
  });
});

describe("OnboardingWizard - the CSV rules behind the import step", () => {
  it("converts amounts using the selected currency's minor-unit scale", () => {
    expect(parseCurrencyMinor("5000", "UGX")).toBe(5000);
    expect(parseCurrencyMinor("1.234", "KWD")).toBe(1234);
    expect(parseCurrencyMinor("1.2345", "KWD")).toBeNull();
  });

  it("imports only valid customer rows through Go and keeps the Go receipt for undo", async () => {
    const panelProps = {
      actorId: "10000000-0000-4000-8000-000000000010",
      organizationId: CREATE_BODY.orgId,
      currency: "KWD",
      onImported: vi.fn(),
      onSkipped: vi.fn(),
    };
    const view = render(<CsvImportPanel {...panelProps} />);
    const file = new File([
      "Name,Credit limit,Email,Payment terms\nGlow Works,1.234,owner@example.com,30\nBad Row,2.000,not-an-email,15\n",
    ], "customers.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose a CSV file"), { target: { files: [file] } });
    await screen.findByText("customers.csv");
    fireEvent.click(buttonNamed(/Import 1 customers/i));
    await screen.findByText(/1 customers imported/i);
    const importCall = calls.find((call) => call.url === "/api/capabilities/execute" && call.body?.capabilityId === "crm.importCustomers");
    expect(importCall?.body).toMatchObject({
      capabilityId: "crm.importCustomers",
      input: { rows: [{ rowNumber: 2, creditLimitMinor: 1234, paymentTermDays: 30 }] },
    });
    expect(screen.getByText(/Row 3/)).toBeTruthy();
    view.unmount();
    render(<CsvImportPanel {...panelProps} />);
    await screen.findByText(/1 customers imported/i);
    fireEvent.click(buttonNamed(/Undo this import/i));
    await screen.findByText(/Undid the import/);
    const undoCall = calls.find((call) => call.url === "/api/capabilities/execute" && call.body?.capabilityId === "crm.undoCustomerImport");
    expect(undoCall?.body?.input).toMatchObject({ customerIds: ["10000000-0000-4000-8000-000000000020"] });
    expect(undoCall?.body?.input).toHaveProperty("importIntentId", importCall?.body?.intentId);
    expect(calls.some((call) => call.url === "/api/import")).toBe(false);
  });

  it("maps minor-unit credit limit headers without currency scaling", async () => {
    const panelProps = {
      actorId: "10000000-0000-4000-8000-000000000010",
      organizationId: CREATE_BODY.orgId,
      currency: "USD",
      onImported: vi.fn(),
      onSkipped: vi.fn(),
    };
    render(<CsvImportPanel {...panelProps} />);
    const file = new File(["Name,Credit limit minor\nGlow Works,500000\n"], "customers-minor.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose a CSV file"), { target: { files: [file] } });
    await screen.findByText("customers-minor.csv");
    expect(guessMapping("customers", ["Name", "Credit limit minor"])).toMatchObject({
      name: "Name",
      creditLimit: null,
      creditLimitMinor: "Credit limit minor",
    });
    fireEvent.click(buttonNamed(/Import 1 customers/i));
    await screen.findByText(/1 customers imported/i);
    const importCall = calls.find((call) => call.body?.capabilityId === "crm.importCustomers");
    expect(importCall?.body?.input).toMatchObject({ rows: [{ rowNumber: 2, creditLimitMinor: 500000 }] });
  });

  it("rejects rows with both major-unit and minor-unit credit limit columns", async () => {
    const panelProps = {
      actorId: "10000000-0000-4000-8000-000000000010",
      organizationId: CREATE_BODY.orgId,
      currency: "USD",
      onImported: vi.fn(),
      onSkipped: vi.fn(),
    };
    render(<CsvImportPanel {...panelProps} />);
    const file = new File(["Name,Credit limit,Credit limit minor\nGlow Works,5000,500000\n"], "customers-conflict.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose a CSV file"), { target: { files: [file] } });
    await screen.findByText("customers-conflict.csv");
    fireEvent.click(buttonNamed("Review row errors"));
    expect(await screen.findByText(/Use either a major-unit credit limit or a minor-unit credit limit, not both/i)).toBeTruthy();
    expect(calls.some((call) => call.body?.capabilityId === "crm.importCustomers")).toBe(false);
  });

  it("imports and undoes product rows through Go with currency minor units", async () => {
    const panelProps = {
      initialEntity: "products" as const,
      actorId: "10000000-0000-4000-8000-000000000010",
      organizationId: CREATE_BODY.orgId,
      currency: "KWD",
      onImported: vi.fn(),
      onSkipped: vi.fn(),
    };
    const view = render(<CsvImportPanel {...panelProps} />);
    const file = new File(["Name,SKU,Price\nGlow Lamp,GLOW-1,1.234\n"], "products.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose a CSV file"), { target: { files: [file] } });
    await screen.findByText("products.csv");
    fireEvent.click(buttonNamed(/Import 1 products/i));
    await screen.findByText(/1 products imported/i);
    const importCall = calls.find((call) => call.url === "/api/capabilities/execute" && call.body?.capabilityId === "inventory.importItems");
    expect(importCall?.body).toMatchObject({
      capabilityId: "inventory.importItems",
      input: { rows: [{ rowNumber: 2, sku: "GLOW-1", salePriceMinor: 1234 }] },
    });
    view.unmount();
    render(<CsvImportPanel {...panelProps} />);
    await screen.findByText(/1 products imported/i);
    fireEvent.click(buttonNamed(/Undo this import/i));
    await screen.findByText(/Undid the import/);
    expect(calls.some((call) => call.url === "/api/capabilities/execute" && call.body?.capabilityId === "inventory.undoItemImport")).toBe(true);
    expect(calls.some((call) => call.url === "/api/import")).toBe(false);
  });

  it("keeps generated service SKUs and capability intents stable when reuploading after a lost response", async () => {
    let importAttempts = 0;
    const requestBodies: Record<string, unknown>[] = [];
    const defaultRespond = respond;
    respond = (call) => {
      if (call.url === "/api/capabilities/execute" && call.body?.capabilityId === "inventory.importItems") {
        importAttempts += 1;
        requestBodies.push(call.body);
        if (importAttempts === 1) throw new TypeError("connection reset");
        return { status: 200, body: { ok: true, data: {
          createdIds: ["10000000-0000-4000-8000-000000000023"], imported: 1, skippedDuplicateRows: [],
        } } };
      }
      return defaultRespond(call);
    };
    const panelProps = {
      initialEntity: "products" as const,
      actorId: "10000000-0000-4000-8000-000000000010",
      organizationId: CREATE_BODY.orgId,
      currency: "USD",
      onImported: vi.fn(),
      onSkipped: vi.fn(),
    };
    render(<CsvImportPanel {...panelProps} />);
    const csv = "Name,Type,Price\nConsultation,service,12.34\n";
    fireEvent.change(screen.getByLabelText("Choose a CSV file"), { target: { files: [new File([csv], "services.csv", { type: "text/csv" })] } });
    await screen.findByText("services.csv");
    fireEvent.click(buttonNamed(/Import 1 products/i));
    await screen.findByText(/The import could not be completed/i);
    fireEvent.click(buttonNamed("Use a different file"));
    fireEvent.change(screen.getByLabelText("Choose a CSV file"), { target: { files: [new File([csv], "services.csv", { type: "text/csv" })] } });
    await screen.findByText("services.csv");
    fireEvent.click(buttonNamed(/Import 1 products/i));
    await screen.findByText(/1 products imported/i);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toEqual(requestBodies[0]);
  });

  it("keeps split product batch undo receipts visible and lets the user undo an older batch", async () => {
    const panelProps = {
      initialEntity: "products" as const,
      actorId: "10000000-0000-4000-8000-000000000010",
      organizationId: CREATE_BODY.orgId,
      currency: "USD",
      onImported: vi.fn(),
      onSkipped: vi.fn(),
    };
    render(<CsvImportPanel {...panelProps} />);
    let expectedBatchCount = 0;
    for (const [filename, csv] of ([
      ["part-1.csv", "Name,SKU,Price\nPart One,PART-1,1.00\n"],
      ["part-2.csv", "Name,SKU,Price\nPart Two,PART-2,2.00\n"],
    ] satisfies [string, string][])) {
      if (filename !== "part-1.csv") fireEvent.click(buttonNamed("Use a different file"));
      fireEvent.change(screen.getByLabelText("Choose a CSV file"), { target: { files: [new File([csv], filename, { type: "text/csv" })] } });
      await screen.findByText(filename);
      fireEvent.click(buttonNamed(/Import 1 products/i));
      expectedBatchCount += 1;
      await waitFor(() => expect(calls.filter((call) => call.body?.capabilityId === "inventory.importItems")).toHaveLength(expectedBatchCount));
      await waitFor(() => expect(screen.getAllByText(/1 products imported/i)).toHaveLength(expectedBatchCount));
    }
    expect(screen.getAllByRole("button", { name: /Undo this import/i })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: /Undo this import/i })[0]!);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Undo this import/i })).toHaveLength(1));
    const undoCall = calls.find((call) => call.body?.capabilityId === "inventory.undoItemImport");
    expect(undoCall?.body?.input).toMatchObject({ itemIds: ["10000000-0000-4000-8000-000000000021"] });
  });

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
