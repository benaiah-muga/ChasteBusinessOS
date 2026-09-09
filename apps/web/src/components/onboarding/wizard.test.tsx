// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./wizard";

/**
 * The setup wizard, driven the way a person drives it.
 *
 * The unit tests in `lib/onboarding-flow.test.ts` prove the rules; these prove
 * the rules are actually wired to the screen — that the button is disabled when
 * it should be, that a failure offers the way out it claims to, and that a
 * step someone skipped comes back instead of disappearing.
 *
 * `next/navigation` and `next/link` are stubbed: the wizard only needs a router
 * it can push to and anchors it can render, not the real app router.
 */

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock("@/lib/api", () => ({
  callApi: vi.fn(async () => ({ ok: true, data: { roles: [] } })),
  postApi: vi.fn(async () => ({ ok: true, data: {} })),
}));

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

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
  respond = () => ({ status: 200, body: {} });
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

describe("OnboardingWizard — choosing a path", () => {
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

describe("OnboardingWizard — describing the business", () => {
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

describe("OnboardingWizard — opening the books", () => {
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

describe("OnboardingWizard — when it fails", () => {
  it("offers a way back in when the session has expired", async () => {
    respond = () => ({ status: 401, body: { code: "unauthorized" } });
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your session ended");
    expect(screen.getByRole("link", { name: "Sign in again" })).toBeTruthy();
  });

  it("passes on the server's own countdown when rate limited", async () => {
    respond = () => ({ status: 429, body: { code: "rate_limited", error: "Try again in 30 seconds." } });
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many attempts");
    expect(alert.textContent).toContain("Try again in 30 seconds.");
  });

  it("never shows a raw server blob as the message", async () => {
    respond = () => ({ status: 500, body: { code: "boom", error: '{"sql":"select 1"}' } });
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That didn't work");
    expect(alert.textContent).not.toContain("select 1");
  });

  it("stays on the profile screen so nothing typed is lost", async () => {
    respond = () => ({ status: 500, body: { code: "boom" } });
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByRole("alert");
    expect((screen.getByLabelText("Business name") as HTMLInputElement).value).toBe("Glow Works");
  });
});

describe("OnboardingWizard — skipping is remembered, not dropped", () => {
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

describe("OnboardingWizard — finishing", () => {
  it("completes setup and hands the user to their workspace", async () => {
    renderWizard();
    await choosePath(/Start from scratch/i);
    await fillProfile();
    fireEvent.click(buttonNamed(/Open my books/i));

    await screen.findByText("Who else works here?");
    fireEvent.click(buttonNamed(/Skip for now/i));

    await screen.findByText(/is ready/);
    fireEvent.click(buttonNamed(/Go to my workspace/i));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.body?.complete === true)).toBe(true),
    );
    expect(refresh).toHaveBeenCalled();
  });
});
