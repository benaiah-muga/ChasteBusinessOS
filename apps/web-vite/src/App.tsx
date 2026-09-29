import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ApprovalsPage } from "./components/ApprovalsPage";
import { LedgerPage } from "./components/LedgerPage";
import { SessionsPage } from "./components/SessionsPage";
import { ProjectsPage } from "./components/ProjectsPage";
import { AnalyticsPage } from "./components/AnalyticsPage";
import { TeamPage } from "./components/TeamPage";
import { CRMPage } from "./components/CRMPage";
import { SalesPage } from "./components/SalesPage";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { DashboardPage } from "./components/DashboardPage";
import { ActiveOrganization } from "./components/ActiveOrganization";
import { LoginPage } from "./components/LoginPage";
import { authClient } from "./api/auth";
import { navigate } from "./navigation";
import { legacyUrl, redirectToLegacy } from "./legacy";
import "./app-shell.css";

const InventoryPage = lazy(() => import("./components/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const PosShiftSummaryPage = lazy(() => import("./components/PosShiftSummaryPage").then((module) => ({ default: module.PosShiftSummaryPage })));
const AccountingInvoicesPage = lazy(() => import("./components/AccountingInvoicesPage").then((module) => ({ default: module.AccountingInvoicesPage })));
const AccountingCloseReadinessPage = lazy(() => import("./components/AccountingCloseReadinessPage").then((module) => ({ default: module.AccountingCloseReadinessPage })));
const PurchasingPaymentRunsPage = lazy(() => import("./components/PurchasingPaymentRunsPage").then((module) => ({ default: module.PurchasingPaymentRunsPage })));
const PurchasingReceiptsPage = lazy(() => import("./components/PurchasingReceiptsPage").then((module) => ({ default: module.PurchasingReceiptsPage })));

const SessionUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  email: z.string().email(),
});

type SessionUser = z.infer<typeof SessionUserSchema>;
type AuthState =
  | { status: "loading" }
  | { status: "signed-in"; user: SessionUser }
  | { status: "failed" };

const navigationItems = [
  { label: "Approvals", href: "/approvals", icon: "✓" },
  { label: "Accounting", href: "/accounting/invoices", icon: "▤" },
  { label: "Close readiness", href: "/accounting/close", icon: "◷" },
  { label: "Sales", href: "/sales", icon: "↗" },
  { label: "POS summary", href: "/pos/shift-summary", icon: "$" },
  { label: "Purchasing", href: "/purchasing/payment-runs", icon: "⇣" },
  { label: "Receipts", href: "/purchasing/receipts", icon: "⇢" },
  { label: "Inventory", href: "/inventory", icon: "▦" },
  { label: "People", href: "/hr", icon: "◎" },
  { label: "Documents", href: "/documents", icon: "▧" },
  { label: "Ledger", href: "/ledger", icon: "≋" },
  { label: "Sessions", href: "/sessions", icon: "⌁" },
  { label: "Projects", href: "/projects", icon: "▣" },
  { label: "Analytics", href: "/analytics", icon: "◷" },
  { label: "Team", href: "/team", icon: "♙" },
  { label: "CRM", href: "/crm", icon: "◎" },
];
const viteAppPaths = new Set(["/", ...navigationItems.map((item) => item.href)]);

function AuthenticatedApp({ pathname }: { pathname: string }) {
  const approvalsPage = pathname === "/approvals";
  const ledgerPage = pathname === "/ledger";
  const sessionsPage = pathname === "/sessions";
  const projectsPage = pathname === "/projects";
  const analyticsPage = pathname === "/analytics";
  const teamPage = pathname === "/team";
  const crmPage = pathname === "/crm";
  const salesPage = pathname === "/sales";
  const posSummaryPage = pathname === "/pos/shift-summary";
  const inventoryPage = pathname === "/inventory";
  const accountingInvoicesPage = pathname === "/accounting/invoices";
  const accountingClosePage = pathname === "/accounting/close";
  const purchasingPaymentRunsPage = pathname === "/purchasing/payment-runs";
  const purchasingReceiptsPage = pathname === "/purchasing/receipts";
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [organizationRevision, setOrganizationRevision] = useState(0);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const refreshSession = useCallback(async () => {
    setAuth({ status: "loading" });
    try {
      const result = await authClient.getSession();
      const user = SessionUserSchema.safeParse(result.data?.user);
      if (!user.success) {
        navigate("/login", true);
        setAuth({ status: "loading" });
        return;
      }
      setAuth({ status: "signed-in", user: user.data });
    } catch {
      setAuth({ status: "failed" });
    }
  }, []);
  const sendNewWorkspaceToSetup = useCallback(() => {
    window.location.assign(legacyUrl("/onboarding"));
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  async function signOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? "Sign out failed");
      navigate("/login", true);
    } catch {
      setSignOutError("Sign out failed. Check your connection and try again.");
    } finally {
      setSigningOut(false);
    }
  }

  if (auth.status === "loading") {
    return <main className="auth-wait" role="status">Checking your workspace session…</main>;
  }

  if (auth.status === "failed") {
    return (
      <main className="auth-problem">
        <p className="shell-kicker">Workspace access</p>
        <h1>We could not check your session.</h1>
        <p>The existing sign-in service did not respond. Try again before opening business data.</p>
        <button className="shell-button" type="button" onClick={() => void refreshSession()}>Try again</button>
        <a href="/login">Go to sign in</a>
      </main>
    );
  }

  return (
    <div className="business-app">
      <aside className="app-rail" aria-label="Main navigation">
        <a className="rail-brand" href="/" aria-label="Chaste BusinessOS home">
          <span className="brand-mark" aria-hidden="true">C</span>
          <span className="rail-brand-copy">Chaste <strong>BusinessOS</strong></span>
        </a>
        <nav className="rail-nav">
          <a className={`rail-link${pathname === "/" ? " rail-link-current" : ""}`} href="/" {...(pathname === "/" ? { "aria-current": "page" as const } : {})}>
            <span aria-hidden="true">⌂</span><span>Home</span>
          </a>
          <p className="rail-caption">Workspace</p>
          {navigationItems.map((item) => (
            <a
              className={`rail-link${pathname === item.href ? " rail-link-current" : ""}`}
              key={item.href}
              href={viteAppPaths.has(item.href) ? item.href : legacyUrl(item.href)}
              {...(pathname === item.href ? { "aria-current": "page" as const } : {})}
            >
              <span aria-hidden="true">{item.icon}</span><span>{item.label}</span>
            </a>
          ))}
          <p className="rail-note">{pathname === "/" ? "Approvals, the event ledger, agent sessions, projects, analytics, team roles, CRM, sales orders, accounting invoices and close readiness, purchasing payment runs and receipts, POS shift summaries, and inventory stock levels are available in this Vite preview. Other pages still open in the current app." : "This Vite preview uses the existing workspace APIs. Other pages still open in the current app."}</p>
        </nav>
        <div className="rail-account">
          <div className="account-initial" aria-hidden="true">{(auth.user.name || auth.user.email).slice(0, 1).toUpperCase()}</div>
          <div className="account-copy">
            <strong>{auth.user.name || "Your account"}</strong>
            <span>{auth.user.email}</span>
          </div>
          <button className="sign-out-button" type="button" onClick={() => void signOut()} disabled={signingOut}>
            {signingOut ? "Signing out" : "Sign out"}
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <a className="mobile-brand" href="/" aria-label="Chaste BusinessOS home"><span className="brand-mark" aria-hidden="true">C</span> Chaste BusinessOS</a>
          <div className="topbar-context"><span className="context-light" aria-hidden="true" />Company workspace</div>
          <div className="topbar-org">
            <ActiveOrganization
              key={organizationRevision}
              onChanged={() => setOrganizationRevision((revision) => revision + 1)}
              onCurrencyChanged={setBaseCurrency}
              onNoOrganizations={sendNewWorkspaceToSetup}
            />
          </div>
        </header>
        {signOutError && <p className="shell-error" role="alert">{signOutError}</p>}
        <PageErrorBoundary key={pathname}>
          <Suspense fallback={<main className="auth-wait" role="status">Loading workspace page…</main>}>
            {approvalsPage
              ? <ApprovalsPage key={organizationRevision} baseCurrency={baseCurrency} />
              : ledgerPage
                ? <LedgerPage key={organizationRevision} />
                : sessionsPage
                  ? <SessionsPage key={organizationRevision} />
                  : projectsPage
                    ? <ProjectsPage key={organizationRevision} />
                    : analyticsPage
                      ? <AnalyticsPage key={organizationRevision} />
                      : teamPage
                        ? <TeamPage key={organizationRevision} />
                        : crmPage
                          ? <CRMPage key={organizationRevision} />
                          : salesPage
                            ? <SalesPage key={organizationRevision} baseCurrency={baseCurrency} />
                            : posSummaryPage
                              ? <PosShiftSummaryPage key={organizationRevision} baseCurrency={baseCurrency} />
                              : inventoryPage
                                ? <InventoryPage key={organizationRevision} baseCurrency={baseCurrency} />
                                : accountingInvoicesPage
                                  ? <AccountingInvoicesPage key={organizationRevision} />
                                  : accountingClosePage
                                    ? <AccountingCloseReadinessPage key={organizationRevision} />
                                    : purchasingPaymentRunsPage
                                      ? <PurchasingPaymentRunsPage key={organizationRevision} />
                                      : purchasingReceiptsPage
                                        ? <PurchasingReceiptsPage key={organizationRevision} />
                                        : <DashboardPage key={organizationRevision} baseCurrency={baseCurrency} />}
          </Suspense>
        </PageErrorBoundary>
      </div>
    </div>
  );
}

function LegacyRoute({ pathname }: { pathname: string }) {
  const destination = legacyUrl(`${pathname}${window.location.search}${window.location.hash}`);

  useEffect(() => {
    redirectToLegacy(`${pathname}${window.location.search}${window.location.hash}`);
  }, [pathname]);

  return (
    <main className="legacy-route">
      <p className="shell-kicker">Existing workspace</p>
      <h1>Opening this page in the current app.</h1>
      <p>This business page has not moved to the React workspace yet.</p>
      <a className="shell-button" href={destination}>Continue to the existing app</a>
    </main>
  );
}

export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const updatePathname = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", updatePathname);
    return () => window.removeEventListener("popstate", updatePathname);
  }, []);

  if (pathname === "/login") return <LoginPage />;
  if (!viteAppPaths.has(pathname) && pathname !== "/login") return <LegacyRoute pathname={pathname} />;
  return <AuthenticatedApp pathname={pathname} />;
}
