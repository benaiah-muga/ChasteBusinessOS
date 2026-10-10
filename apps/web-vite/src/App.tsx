import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ApprovalsPage } from "./components/ApprovalsPage";
import { LedgerPage } from "./components/LedgerPage";
import { SessionsPage } from "./components/SessionsPage";
import { NotificationsBell } from "./components/NotificationsBell";
import { ProjectsPage } from "./components/ProjectsPage";
import { AnalyticsPage } from "./components/AnalyticsPage";
import { TeamPage } from "./components/TeamPage";
import { CRMPage } from "./components/CRMPage";
import { MarketplacePage } from "./components/MarketplacePage";
import { SalesPage } from "./components/SalesPage";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { DashboardPage } from "./components/DashboardPage";
import { ActiveOrganization } from "./components/ActiveOrganization";
import { LoginPage } from "./components/LoginPage";
import { PasswordResetPage } from "./components/PasswordResetPage";
import { PortalInvoicePage } from "./components/PortalInvoicePage";
import { WidgetPage } from "./components/WidgetPage";
import { InvoicePrintPage } from "./components/InvoicePrintPage";
import { authClient } from "./api/auth";
import { navigate } from "./navigation";
import { legacyUrl, redirectToLegacy } from "./legacy";
import "./app-shell.css";

const InventoryPage = lazy(() => import("./components/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const ProductsPage = lazy(() => import("./components/ProductsPage").then((module) => ({ default: module.ProductsPage })));
const PosShiftSummaryPage = lazy(() => import("./components/PosShiftSummaryPage").then((module) => ({ default: module.PosShiftSummaryPage })));
const AccountingInvoicesPage = lazy(() => import("./components/AccountingInvoicesPage").then((module) => ({ default: module.AccountingInvoicesPage })));
const AccountingCloseReadinessPage = lazy(() => import("./components/AccountingCloseReadinessPage").then((module) => ({ default: module.AccountingCloseReadinessPage })));
const PurchasingPaymentRunsPage = lazy(() => import("./components/PurchasingPaymentRunsPage").then((module) => ({ default: module.PurchasingPaymentRunsPage })));
const PurchasingReceiptsPage = lazy(() => import("./components/PurchasingReceiptsPage").then((module) => ({ default: module.PurchasingReceiptsPage })));
const PurchasingAgingPage = lazy(() => import("./components/PurchasingAgingPage").then((module) => ({ default: module.PurchasingAgingPage })));
const DocumentsPage = lazy(() => import("./components/DocumentsPage").then((module) => ({ default: module.DocumentsPage })));
const HrPage = lazy(() => import("./components/HrPage").then((module) => ({ default: module.HrPage })));
const AccountingPage = lazy(() => import("./components/AccountingPage").then((module) => ({ default: module.AccountingPage })));
const MessagesPage = lazy(() => import("./components/MessagesPage").then((module) => ({ default: module.MessagesPage })));
const SettingsPage = lazy(() => import("./components/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const PurchasingPage = lazy(() => import("./components/PurchasingPage").then((module) => ({ default: module.PurchasingPage })));
const PurchasingReceivingPage = lazy(() => import("./components/PurchasingReceivingPage").then((module) => ({ default: module.PurchasingReceivingPage })));
const SupportPage = lazy(() => import("./components/SupportPage").then((module) => ({ default: module.SupportPage })));
const ManufacturingPage = lazy(() => import("./components/ManufacturingPage").then((module) => ({ default: module.ManufacturingPage })));
const MarketingPage = lazy(() => import("./components/MarketingPage").then((module) => ({ default: module.MarketingPage })));
const ProposalsPage = lazy(() => import("./components/ProposalsPage").then((module) => ({ default: module.ProposalsPage })));
const OnboardingPage = lazy(() => import("./components/OnboardingPage").then((module) => ({ default: module.OnboardingPage })));
const DocumentsEditorPage = lazy(() => import("./components/DocumentsEditorPage").then((module) => ({ default: module.DocumentsEditorPage })));
const PosPage = lazy(() => import("./components/PosPage").then((module) => ({ default: module.PosPage })));

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
  { label: "Register", href: "/pos", icon: "$" },
  { label: "Purchasing", href: "/purchasing/payment-runs", icon: "⇣" },
  { label: "Payables aging", href: "/purchasing/ap-aging", icon: "◷" },
  { label: "Receipts", href: "/purchasing/receipts", icon: "⇢" },
  { label: "Inventory", href: "/inventory", icon: "▦" },
  { label: "Products", href: "/products", icon: "□" },
  { label: "People", href: "/hr", icon: "◎" },
  { label: "Documents", href: "/documents", icon: "▧" },
  { label: "Ledger", href: "/ledger", icon: "≋" },
  { label: "Sessions", href: "/sessions", icon: "⌁" },
  { label: "Projects", href: "/projects", icon: "▣" },
  { label: "Analytics", href: "/analytics", icon: "◷" },
  { label: "Team", href: "/team", icon: "♙" },
  { label: "Marketplace", href: "/marketplace", icon: "◇" },
  { label: "CRM", href: "/crm", icon: "◎" },
  { label: "Messages", href: "/messages", icon: "✉" },
  { label: "Support", href: "/support", icon: "?" },
  { label: "Manufacturing", href: "/manufacturing", icon: "⚙" },
  { label: "Marketing", href: "/marketing", icon: "◈" },
  { label: "Proposals", href: "/proposals", icon: "✦" },
  { label: "Receiving", href: "/purchasing/receiving", icon: "⇥" },
  { label: "Settings", href: "/settings", icon: "⚙" },
];
// Paths the Vite app serves that deliberately have no rail item of their own,
// because an existing rail item already points at a sibling view in the same
// workspace. They must stay in the routing set or they fall back to legacy.
const additionalVitePaths = ["/accounting", "/purchasing"];

const viteAppPaths = new Set(["/", "/login", ...navigationItems.map((item) => item.href), ...additionalVitePaths]);

export function isViteAppPath(pathname: string): boolean {
  return viteAppPaths.has(pathname) || /^\/documents\/editor\/[^/]+$/.test(pathname);
}

function AuthenticatedApp({ pathname }: { pathname: string }) {
  const approvalsPage = pathname === "/approvals";
  const ledgerPage = pathname === "/ledger";
  const sessionsPage = pathname === "/sessions";
  const projectsPage = pathname === "/projects";
  const analyticsPage = pathname === "/analytics";
  const teamPage = pathname === "/team";
  const marketplacePage = pathname === "/marketplace";
  const documentsPage = pathname === "/documents";
  const hrPage = pathname === "/hr";
  const crmPage = pathname === "/crm";
  const salesPage = pathname === "/sales";
  const posSummaryPage = pathname === "/pos/shift-summary";
  const inventoryPage = pathname === "/inventory";
  const productsPage = pathname === "/products";
  const accountingInvoicesPage = pathname === "/accounting/invoices";
  const accountingClosePage = pathname === "/accounting/close";
  const purchasingPaymentRunsPage = pathname === "/purchasing/payment-runs";
  const purchasingAgingPage = pathname === "/purchasing/ap-aging";
  const purchasingReceiptsPage = pathname === "/purchasing/receipts";
  const accountingPage = pathname === "/accounting";
  const messagesPage = pathname === "/messages";
  const settingsPage = pathname === "/settings";
  const purchasingPage = pathname === "/purchasing";
  const purchasingReceivingPage = pathname === "/purchasing/receiving";
  const supportPage = pathname === "/support";
  const manufacturingPage = pathname === "/manufacturing";
  const marketingPage = pathname === "/marketing";
  const proposalsPage = pathname === "/proposals";
  // The editor is a dynamic segment, so it matches by prefix rather than equality.
  const documentsEditorPage = pathname.startsWith("/documents/editor/");
  const posPage = pathname === "/pos";
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [organizationRevision, setOrganizationRevision] = useState(0);
  const [activeOrganization, setActiveOrganization] = useState<{ userId: string; orgId: string | null } | null>(null);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const currentUserId = auth.status === "signed-in" ? auth.user.id : null;
  const activeOrgId = currentUserId && activeOrganization?.userId === currentUserId ? activeOrganization.orgId : null;
  const rememberActiveOrgId = useCallback((orgId: string | null) => {
    if (currentUserId) setActiveOrganization({ userId: currentUserId, orgId });
  }, [currentUserId]);

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
          <p className="rail-note">{pathname === "/" ? "Approvals, the event ledger, agent sessions, projects, analytics, team roles, marketplace, CRM, sales orders, products, accounting invoices and close readiness, purchasing payment runs, payables aging and receipts, POS shift summaries, and inventory stock levels are available in this Vite preview. Other pages still open in the current app." : "This Vite preview uses the existing workspace APIs. Other pages still open in the current app."}</p>
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
              onActiveOrgIdChange={rememberActiveOrgId}
              onChanged={() => setOrganizationRevision((revision) => revision + 1)}
              onCurrencyChanged={setBaseCurrency}
              onNoOrganizations={sendNewWorkspaceToSetup}
            />
          </div>
          <NotificationsBell align="right" />
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
                    ? <ProjectsPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                    : analyticsPage
                      ? <AnalyticsPage key={organizationRevision} />
                      : teamPage
                        ? <TeamPage key={organizationRevision} />
                      : marketplacePage
                          ? <MarketplacePage key={organizationRevision} />
                          : documentsPage
                            ? <DocumentsPage key={organizationRevision} />
                            : hrPage
                              ? <HrPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                              : crmPage
                            ? <CRMPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                            : salesPage
                              ? <SalesPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                              : posSummaryPage
                                ? <PosShiftSummaryPage key={organizationRevision} baseCurrency={baseCurrency} />
                                : inventoryPage
                                  ? <InventoryPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                  : accountingInvoicesPage
                                    ? <AccountingInvoicesPage key={organizationRevision} />
                                      : accountingClosePage
                                        ? <AccountingCloseReadinessPage key={organizationRevision} />
                                        : productsPage
                                          ? <ProductsPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                        : purchasingPaymentRunsPage
                                        ? <PurchasingPaymentRunsPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                        : purchasingAgingPage
                                          ? <PurchasingAgingPage key={organizationRevision} baseCurrency={baseCurrency} />
                                          : purchasingReceiptsPage
                                            ? <PurchasingReceiptsPage key={organizationRevision} />
                                            : purchasingPage
                                              ? <PurchasingPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                              : purchasingReceivingPage
                                                ? <PurchasingReceivingPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                                : accountingPage
                                                  ? <AccountingPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                  : messagesPage
                                                    ? <MessagesPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                    : settingsPage
                                                      ? <SettingsPage key={organizationRevision} />
                                                      : supportPage
                                                        ? <SupportPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                        : manufacturingPage
                                                          ? <ManufacturingPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                                          : marketingPage
                                                            ? <MarketingPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                                            : proposalsPage
                                                              ? <ProposalsPage key={organizationRevision} />
                                                              : documentsEditorPage
                                                                ? <DocumentsEditorPage key={organizationRevision} documentId={pathname.split("/").pop()} />
                                                                : posPage
                                                                ? activeOrgId
                                                                  ? <PosPage key={`${organizationRevision}:${auth.user.id}:${activeOrgId}`} baseCurrency={baseCurrency} actorId={auth.user.id} organizationId={activeOrgId} />
                                                                  : <main className="auth-wait" role="status">Checking the active organization before loading POS data…</main>
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
  if (pathname === "/reset-password") return <PasswordResetPage />;
  // Onboarding resolves the session itself: it redirects to /login when signed
  // out and to / when a workspace already exists, so it must render outside the
  // authenticated shell.
  if (pathname === "/onboarding") return <OnboardingPage />;
  if (/^\/portal\/[^/]+$/.test(pathname)) return <PortalInvoicePage pathname={pathname} />;
  if (/^\/widget\/[^/]+$/.test(pathname)) return <WidgetPage pathname={pathname} />;
  // The print sheet renders outside the shell: it is chrome-less on purpose so
  // the printed page carries only the invoice.
  if (/^\/print\/invoice\/[^/]+$/.test(pathname)) return <InvoicePrintPage pathname={pathname} />;
  if (!isViteAppPath(pathname)) return <LegacyRoute pathname={pathname} />;
  return <AuthenticatedApp pathname={pathname} />;
}
