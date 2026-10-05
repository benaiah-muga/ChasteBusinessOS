import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingPage } from "./OnboardingPage";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetchOrganizations: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../api/auth", () => ({
  authClient: { getSession: mocks.getSession },
}));

vi.mock("../api/organizations", () => ({
  fetchOrganizations: mocks.fetchOrganizations,
  OrganizationApiError: class OrganizationApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  },
}));

vi.mock("../navigation", () => ({ navigate: mocks.navigate }));
vi.mock("./onboarding/Wizard", () => ({
  OnboardingWizard: ({ email }: { email: string }) => <div>Wizard for {email}</div>,
}));

describe("Vite onboarding route", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { user: { id: "user-id", email: "ada@example.test" } } });
    mocks.fetchOrganizations.mockResolvedValue({ orgs: [], activeOrgId: null });
    mocks.navigate.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("redirects signed-out visitors to sign-in", async () => {
    mocks.getSession.mockResolvedValue({ data: { user: null } });
    render(<OnboardingPage />);

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login", true));
    expect(mocks.fetchOrganizations).not.toHaveBeenCalled();
  });

  it("opens setup only when the signed-in user has no workspace", async () => {
    render(<OnboardingPage />);

    expect(await screen.findByText("Wizard for ada@example.test")).toBeTruthy();
    expect(mocks.fetchOrganizations).toHaveBeenCalledOnce();
  });

  it("redirects users who already have a workspace to the app", async () => {
    mocks.fetchOrganizations.mockResolvedValue({
      orgs: [{ id: "org-id", name: "Ada's workspace", baseCurrency: "USD" }],
      activeOrgId: "org-id",
    });
    render(<OnboardingPage />);

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/", true));
    expect(screen.queryByText("Wizard for ada@example.test")).toBeNull();
  });

  it("keeps the failure visible and retries the workspace check", async () => {
    mocks.fetchOrganizations.mockRejectedValueOnce(new Error("offline"));
    render(<OnboardingPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We could not check whether you already have a workspace");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Wizard for ada@example.test")).toBeTruthy();
    expect(mocks.fetchOrganizations).toHaveBeenCalledTimes(2);
  });
});
