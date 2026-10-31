import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingPage } from "./OnboardingPage";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetchOrganizations: vi.fn(),
  readOnboardingState: vi.fn(),
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
vi.mock("../api/onboarding", () => ({
  readOnboardingState: mocks.readOnboardingState,
  OnboardingApiError: class OnboardingApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  },
}));

vi.mock("../navigation", () => ({ navigate: mocks.navigate }));
vi.mock("./onboarding/Wizard", () => ({
  OnboardingWizard: (props: {
    email: string;
    actorId: string;
    organizationId?: string;
    baseCurrency?: string;
    resumeState?: { path: string; steps: Record<string, string> };
  }) => <div data-testid="wizard">{JSON.stringify(props)}</div>,
}));

describe("Vite onboarding route", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { user: { id: "user-id", email: "ada@example.test" } } });
    mocks.fetchOrganizations.mockResolvedValue({ orgs: [], activeOrgId: null });
    mocks.readOnboardingState.mockResolvedValue(null);
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

    expect(await screen.findByTestId("wizard")).toBeTruthy();
    expect(mocks.fetchOrganizations).toHaveBeenCalledOnce();
  });

  it("redirects users who already have a workspace to the app", async () => {
    mocks.fetchOrganizations.mockResolvedValue({
      orgs: [{ id: "org-id", name: "Ada's workspace", baseCurrency: "USD" }],
      activeOrgId: "org-id",
    });
    render(<OnboardingPage />);

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/", true));
    expect(screen.queryByTestId("wizard")).toBeNull();
    expect(mocks.readOnboardingState).toHaveBeenCalledOnce();
  });

  it("resumes an unfinished setup with the active workspace context", async () => {
    const state = {
      path: "import",
      steps: { business_profile: "done", import_customers: "done", import_products: "pending" },
      startedAt: "2026-01-01T00:00:00Z",
    };
    mocks.fetchOrganizations.mockResolvedValue({
      orgs: [{ id: "org-id", name: "Ada's workspace", baseCurrency: "UGX" }],
      activeOrgId: "org-id",
    });
    mocks.readOnboardingState.mockResolvedValue(state);

    render(<OnboardingPage />);

    const wizard = await screen.findByTestId("wizard");
    expect(JSON.parse(wizard.textContent ?? "{}")).toEqual({
      email: "ada@example.test",
      actorId: "user-id",
      organizationId: "org-id",
      baseCurrency: "UGX",
      resumeState: state,
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("keeps the failure visible and retries the workspace check", async () => {
    mocks.fetchOrganizations.mockRejectedValueOnce(new Error("offline"));
    render(<OnboardingPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We could not check whether you already have a workspace");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("wizard")).toBeTruthy();
    expect(mocks.fetchOrganizations).toHaveBeenCalledTimes(2);
  });
});
