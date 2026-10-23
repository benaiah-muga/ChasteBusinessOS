import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { z } from "zod";
import {
  ChevronRight,
  FileText,
  Keyboard,
  LogOut,
  Menu,
  PackagePlus,
  PackageSearch,
  Plus,
  ReceiptText,
  UserPlus,
  WalletCards,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings as SettingsIcon,
  UserRound,
  X,
} from "lucide-react";
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
import { ChatDock } from "./components/ChatDock";
import { resetChat } from "./chat-store";
import { DashboardPage } from "./components/DashboardPage";
import { ActiveOrganization } from "./components/ActiveOrganization";
import { LoginPage } from "./components/LoginPage";
import { PasswordResetPage } from "./components/PasswordResetPage";
import { PortalInvoicePage } from "./components/PortalInvoicePage";
import { WidgetPage } from "./components/WidgetPage";
import { InvoicePrintPage } from "./components/InvoicePrintPage";
import { InvitationPage } from "./components/InvitationPage";
import { authClient } from "./api/auth";
import { fetchApprovals } from "./api/approvals";
import { navigate } from "./navigation";
import { BrandLoader } from "./ui/brand-loader";
import { BrandMark } from "./ui/brand-mark";
import { CommandPalette } from "./ui/command-palette";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Kbd } from "./ui/page-header";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { useToast } from "./ui/toast";
import {
  NAV_GROUPS,
  PRIMARY_NAV,
  flattenNavLeaves,
  isNavItemActive,
  pageMeta,
} from "./shell/navigation";
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
const ChatPage = lazy(() => import("./components/ChatPage").then((module) => ({ default: module.ChatPage })));
const InboxPage = lazy(() => import("./components/InboxPage").then((module) => ({ default: module.InboxPage })));

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

const viteAppPaths = new Set(["/", "/login", "/approvals", ...flattenNavLeaves().map((item) => item.href), "/accounting", "/purchasing", "/inbox"]);

export function isViteAppPath(pathname: string): boolean {
  return viteAppPaths.has(pathname) || /^\/documents\/editor\/[^/]+$/.test(pathname) || /^\/invite\/[^/]+$/.test(pathname);
}

const QUICK_CREATES = [
  { id: "invoice", label: "Draft an invoice", detail: "Bill a customer and post the ledger entry", icon: FileText, prompt: "Draft an invoice. Ask me for the customer, line items, due date, and anything else you need." },
  { id: "bill", label: "Record a supplier bill", detail: "Capture a bill and schedule payment", icon: ReceiptText, prompt: "Record a supplier bill. Ask me for the supplier, amount, due date, and the expense or stock account it belongs to." },
  { id: "customer", label: "Add a customer", detail: "Open a new CRM record", icon: UserPlus, prompt: "Add a customer. Ask me for the name, email, phone, billing address, and preferred contact method." },
  { id: "product", label: "Add a product", detail: "Create a catalogue item", icon: PackagePlus, prompt: "Add a product to the catalogue. Ask me for the SKU, name, price, unit, and reorder point." },
  { id: "expense", label: "Log an expense", detail: "File a claim or record a cost", icon: WalletCards, prompt: "Help me log an expense. Ask for the amount, date, vendor, category, and receipt." },
  { id: "stock", label: "Reorder low stock", detail: "Prepare a replenishment plan", icon: PackageSearch, prompt: "Review stock at or below its reorder point and prepare a replenishment plan for my approval." },
] as const;

const RAIL_COLLAPSED_KEY = "chaste-rail-collapsed";

function initialCollapsedRail(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function useWaitingApprovals(organizationId: string | null, revision: number, enabled = true): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchApprovals(organizationId);
        if (!cancelled) setCount(result.approvals.length);
      } catch {
        if (!cancelled) setCount(0);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, organizationId, revision]);
  return count;
}

function RailItem({
  label,
  href,
  icon: Icon,
  description,
  badge,
  current,
  ariaLabel,
  onNavigate,
}: {
  label: string;
  href: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  description: string;
  badge?: number;
  current: boolean;
  ariaLabel?: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="rail-item">
      <a
        className={`rail-link${current ? " rail-link-current" : ""}`}
        href={href}
        title={description}
        aria-label={ariaLabel}
        aria-current={current ? "page" : undefined}
        onClick={onNavigate}
      >
        <Icon size={15} aria-hidden />
        <span className="rail-link-label">{label}</span>
        {badge !== undefined && badge > 0 && <span className="rail-badge" aria-hidden="true">{badge > 99 ? "99+" : badge}</span>}
      </a>
    </div>
  );
}

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const rows: { label: string; keys: string }[] = [
    { label: "Search, jump, or ask", keys: "⌘ K" },
    { label: "New conversation", keys: "N" },
    { label: "Go home", keys: "G then H" },
    { label: "Open inbox", keys: "G then I" },
    { label: "Open Workmate", keys: "G then W" },
    { label: "Open accounting", keys: "G then A" },
    { label: "Open settings", keys: "G then S" },
    { label: "Show this help", keys: "?" },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>Move through Chaste without leaving the keys.</DialogDescription>
        <div className="shortcut-list">
          {rows.map(({ label, keys }) => (
            <div key={label} className="shortcut-row">
              <span>{label}</span>
              <span className="shortcut-keys">
                {keys.split(" ").map((key, index) => key === "then" ? <span key={`${key}-${index}`} className="shortcut-then">then</span> : <Kbd key={`${key}-${index}`}>{key}</Kbd>)}
              </span>
            </div>
          ))}
        </div>
        <div className="shortcut-note">
          <Keyboard size={14} aria-hidden="true" />
          <span>Shortcuts pause while you are typing in a field.</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AuthenticatedApp({ pathname }: { pathname: string }) {
  const approvalsPage = pathname === "/approvals";
  const inboxPage = pathname === "/inbox";
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
  const chatPage = pathname === "/chat";
  const documentsEditorPage = pathname.startsWith("/documents/editor/");
  const posPage = pathname === "/pos";
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [organizationRevision, setOrganizationRevision] = useState(0);
  const [activeOrganization, setActiveOrganization] = useState<{ userId: string; orgId: string | null } | null>(null);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(initialCollapsedRail);
  const currentUserId = auth.status === "signed-in" ? auth.user.id : null;
  const activeOrgId = currentUserId && activeOrganization?.userId === currentUserId ? activeOrganization.orgId : null;
  const waitingApprovals = useWaitingApprovals(activeOrgId, organizationRevision, pathname !== "/approvals" && pathname !== "/inbox");
  const meta = useMemo(() => pageMeta(pathname), [pathname]);
  const { toast } = useToast();
  const gPrefixRef = useRef<string | null>(null);
  const gTimerRef = useRef<number | null>(null);
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
    navigate("/onboarding", true);
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (organizationRevision > 0) resetChat();
  }, [organizationRevision]);

  useEffect(() => {
    document.title = `${meta.label} · Chaste BusinessOS`;
  }, [meta.label]);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileNavOpen]);


  useEffect(() => {
    setMobileNavOpen(false);
    setCommandOpen(false);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
        return;
      }
      if (typing) return;
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key.toLowerCase() === "n" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (pathname !== "/chat") {
          event.preventDefault();
          navigate("/chat");
          setTimeout(() => window.dispatchEvent(new CustomEvent("chaste:new-conversation")), 250);
        }
        return;
      }
      if (event.key.toLowerCase() === "g") {
        gPrefixRef.current = "g";
        if (gTimerRef.current) window.clearTimeout(gTimerRef.current);
        gTimerRef.current = window.setTimeout(() => { gPrefixRef.current = null; }, 1200);
        return;
      }
      if (gPrefixRef.current === "g") {
        const routes: Record<string, string> = { h: "/", i: "/inbox", w: "/chat", a: "/accounting", s: "/settings", l: "/ledger", c: "/crm", p: "/purchasing" };
        const destination = routes[event.key.toLowerCase()];
        gPrefixRef.current = null;
        if (gTimerRef.current) window.clearTimeout(gTimerRef.current);
        if (destination) {
          event.preventDefault();
          navigate(destination);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pathname]);

  useEffect(() => {
    function onNewConversation() {
      resetChat();
    }
    window.addEventListener("chaste:new-conversation", onNewConversation);
    return () => window.removeEventListener("chaste:new-conversation", onNewConversation);
  }, []);

  function toggleRail() {
    setRailCollapsed((current) => {
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, current ? "0" : "1");
      } catch {
        // A blocked storage area only loses the preference for this session.
      }
      return !current;
    });
  }

  async function signOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? "Sign out failed");
      toast({ title: "Signed out", description: "Your workspace session has ended.", tone: "success" });
      navigate("/login", true);
    } catch {
      setSignOutError("Sign out failed. Check your connection and try again.");
    } finally {
      setSigningOut(false);
    }
  }

  if (auth.status === "loading") {
    return (
      <main className="auth-wait" aria-busy="true">
        <BrandLoader full label="Opening your workspace" detail="Checking your session and workspace access." />
      </main>
    );
  }

  if (auth.status === "failed") {
    return (
      <main className="auth-problem">
        <p className="shell-kicker">Workspace access</p>
        <h1>We could not check your session.</h1>
        <p>The existing sign-in service did not respond. Try again before opening business data.</p>
        <Button variant="primary" onClick={() => void refreshSession()}>Try again</Button>
        <a href="/login">Go to sign in</a>
      </main>
    );
  }

  const userInitial = (auth.user.name || auth.user.email).slice(0, 1).toUpperCase();
  const pageTitle = meta.label;

  return (
    <TooltipProvider>
      <a className="app-skip-link" href="#main-content">Skip to content</a>
      <div className="business-app" data-rail={railCollapsed ? "collapsed" : "expanded"} data-mobile-nav={mobileNavOpen ? "open" : "closed"}>
        <aside className="app-rail" aria-label="Main navigation">
          <div className="rail-brand-wrap">
            <a className="rail-brand" href="/" aria-label="Chaste BusinessOS home">
              <BrandMark variant="gold" size="sm" />
              <span className="rail-brand-copy">
                <span>Open source · built for everyone</span>
                <span>Chaste <strong>BusinessOS</strong></span>
              </span>
              <span className="rail-brand-badge">AI</span>
            </a>
            <button type="button" className="rail-mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <div className="rail-search">
            <button type="button" className="rail-search-button" onClick={() => setCommandOpen(true)} aria-label="Search and jump to">
              <Search size={14} aria-hidden="true" />
              <span>Search or jump to…</span>
              <Kbd>⌘K</Kbd>
            </button>
          </div>

          <nav className="rail-nav" aria-label="Workspace">
            {PRIMARY_NAV.map((item) => {
              const current = isNavItemActive(pathname, item);
              return (
                <RailItem
                  key={item.href}
                  label={item.label}
                  href={item.href}
                  icon={item.icon}
                  description={item.description}
                  badge={item.badge === "approvals" ? waitingApprovals : undefined}
                  current={current}
                  onNavigate={() => setMobileNavOpen(false)}
                />
              );
            })}
            {NAV_GROUPS.map((group) => (
              <section className="rail-group" key={group.id} aria-labelledby={`rail-group-${group.id}`}>
                <p className="rail-caption" id={`rail-group-${group.id}`}>{group.label}</p>
                {group.items.map((item) => {
                  const current = isNavItemActive(pathname, item);
                  return (
                    <RailItem
                      key={item.href}
                      label={item.label}
                      href={item.href}
                      icon={item.icon}
                      description={item.description}
                      current={current}
                      ariaLabel={item.ariaLabel}
                      onNavigate={() => setMobileNavOpen(false)}
                    />
                  );
                })}
              </section>
            ))}
          </nav>

          <div className="rail-footer">
            <div className="rail-account">
              <span className="account-initial" aria-hidden="true">{userInitial}</span>
              <div className="account-copy">
                <strong>{auth.user.name || "Your account"}</strong>
                <span>{auth.user.email}</span>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="rail-account-action" aria-label="Account menu">
                    <SettingsIcon size={14} aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end">
                  <DropdownMenuLabel>Signed in as {auth.user.email}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => navigate("/settings")}>
                    <SettingsIcon size={14} aria-hidden="true" /> Workspace settings
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => navigate("/team")}>
                    <UserRound size={14} aria-hidden="true" /> Team and access
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void signOut()} disabled={signingOut}>
                    <LogOut size={14} aria-hidden="true" /> {signingOut ? "Signing out…" : "Sign out"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <button type="button" className="rail-account-action" aria-label="Sign out" title="Sign out" onClick={() => void signOut()} disabled={signingOut}>
                <LogOut size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="rail-footer-row">
              <p className="rail-version">OPEN SOURCE · APACHE 2.0</p>
              <Tooltip label={railCollapsed ? "Expand navigation" : "Collapse navigation"} side="top">
                <button type="button" className="rail-collapse-button" onClick={toggleRail} aria-label={railCollapsed ? "Expand navigation" : "Collapse navigation"}>
                  {railCollapsed ? <PanelLeftOpen size={13} aria-hidden="true" /> : <PanelLeftClose size={13} aria-hidden="true" />}
                </button>
              </Tooltip>
            </div>
          </div>
        </aside>

        {mobileNavOpen && <button type="button" className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

        <div className="app-main">
          <header className="app-topbar">
            <div className="topbar-left">
              <Button
                variant="ghost"
                size="icon"
                className="topbar-menu"
                aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
                aria-expanded={mobileNavOpen}
                onClick={() => setMobileNavOpen((open) => !open)}
              >
                {mobileNavOpen ? <X size={17} /> : <Menu size={17} />}
              </Button>
              <a className="mobile-brand" href="/" aria-label="Chaste BusinessOS home">
                <BrandMark size="sm" />
                <span>Chaste <strong>BusinessOS</strong></span>
              </a>
              <nav className="topbar-breadcrumb" aria-label="Breadcrumb">
                <span>{meta.group}</span>
                <ChevronRight size={12} aria-hidden="true" />
                <strong>{pageTitle}</strong>
              </nav>
              <span className="topbar-live" title="Every action is governed, auditable, and reversible">Governed</span>
            </div>
            <div className="topbar-actions">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="primary" size="sm" className="topbar-create" aria-label="Create with the workmate">
                    <Plus size={14} aria-hidden="true" /> <span>Create</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="topbar-create-menu">
                  <DropdownMenuLabel>Start with the workmate</DropdownMenuLabel>
                  {QUICK_CREATES.map((action) => {
                    const Icon = action.icon;
                    return (
                      <DropdownMenuItem key={action.id} onSelect={() => navigate(`/chat?prompt=${encodeURIComponent(action.prompt)}`)}>
                        <Icon size={14} aria-hidden="true" />
                        <span className="topbar-create-copy"><strong>{action.label}</strong><small>{action.detail}</small></span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <button type="button" className="topbar-search" onClick={() => setCommandOpen(true)} aria-label="Search and jump to">
                <Search size={14} aria-hidden="true" />
                <span>Search</span>
                <Kbd>⌘K</Kbd>
              </button>
              <div className="topbar-org">
                <ActiveOrganization
                  key={organizationRevision}
                  onActiveOrgIdChange={rememberActiveOrgId}
                  onChanged={(orgId) => {
                    const previous = activeOrgId;
                    setOrganizationRevision((revision) => revision + 1);
                    if (previous !== orgId) {
                      toast({ title: "Workspace switched", description: "Pages and totals now reflect the selected workspace.", tone: "success" });
                    }
                  }}
                  onCurrencyChanged={setBaseCurrency}
                  onNoOrganizations={sendNewWorkspaceToSetup}
                />
              </div>
              <NotificationsBell align="right" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="topbar-avatar" aria-label="Account menu">{userInitial}</button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{auth.user.name || auth.user.email}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => navigate("/settings")}>
                    <SettingsIcon size={14} aria-hidden="true" /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
                    <Keyboard size={14} aria-hidden="true" /> Keyboard shortcuts
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void signOut()} disabled={signingOut}>
                    <LogOut size={14} aria-hidden="true" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          {signOutError && <p className="shell-error" role="alert">{signOutError}</p>}
          <PageErrorBoundary key={pathname}>
            <Suspense fallback={<BrandLoader full label={`Opening ${meta.label.toLowerCase()}`} detail="Loading the latest workspace data." />}>
              <div id="main-content" tabIndex={-1}>
                {inboxPage
                  ? <InboxPage key={organizationRevision} organizationId={activeOrgId} />
                  : approvalsPage
                    ? <ApprovalsPage key={organizationRevision} baseCurrency={baseCurrency} organizationId={activeOrgId} />
                    : ledgerPage
                      ? <LedgerPage key={organizationRevision} />
                      : sessionsPage
                        ? <SessionsPage key={organizationRevision} organizationId={activeOrgId} />
                        : projectsPage
                          ? <ProjectsPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                          : analyticsPage
                            ? <AnalyticsPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                            : teamPage
                              ? <TeamPage key={organizationRevision} />
                              : marketplacePage
                                ? <MarketplacePage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                : documentsPage
                                  ? <DocumentsPage key={organizationRevision} />
                                  : hrPage
                                    ? <HrPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                    : crmPage
                                      ? <CRMPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} baseCurrency={baseCurrency} />
                                      : salesPage
                                        ? <SalesPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                        : posSummaryPage
                                          ? <PosShiftSummaryPage key={organizationRevision} baseCurrency={baseCurrency} />
                                          : inventoryPage
                                            ? <InventoryPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                            : accountingInvoicesPage
                                              ? <AccountingInvoicesPage key={organizationRevision} organizationId={activeOrgId} />
                                              : accountingClosePage
                                                ? <AccountingCloseReadinessPage key={organizationRevision} />
                                                : productsPage
                                                  ? <ProductsPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                                  : purchasingPaymentRunsPage
                                                    ? <PurchasingPaymentRunsPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                    : purchasingAgingPage
                                                      ? <PurchasingAgingPage key={organizationRevision} baseCurrency={baseCurrency} organizationId={activeOrgId} />
                                                      : purchasingReceiptsPage
                                                        ? <PurchasingReceiptsPage key={organizationRevision} organizationId={activeOrgId} />
                                                        : purchasingPage
                                                          ? <PurchasingPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                                          : purchasingReceivingPage
                                                            ? <PurchasingReceivingPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                                            : accountingPage
                                                              ? <AccountingPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                              : messagesPage
                                                                ? <MessagesPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                                : settingsPage
                                                                  ? <SettingsPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                                  : supportPage
                                                                    ? <SupportPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                                    : manufacturingPage
                                                                      ? <ManufacturingPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                                                      : marketingPage
                                                                        ? <MarketingPage key={organizationRevision} baseCurrency={baseCurrency} actorId={currentUserId} organizationId={activeOrgId} />
                                                                        : proposalsPage
                                                                          ? <ProposalsPage key={organizationRevision} actorId={currentUserId} organizationId={activeOrgId} />
                                                                          : chatPage
                                                                            ? <ChatPage key={organizationRevision} organizationId={activeOrgId} actorId={auth.user.id} userName={auth.user.name || auth.user.email} />
                                                                            : documentsEditorPage
                                                                              ? <DocumentsEditorPage key={organizationRevision} documentId={pathname.split("/").pop()} actorId={currentUserId} organizationId={activeOrgId} />
                                                                              : posPage
                                                                                ? activeOrgId
                                                                                  ? <PosPage key={`${organizationRevision}:${auth.user.id}:${activeOrgId}`} baseCurrency={baseCurrency} actorId={auth.user.id} organizationId={activeOrgId} />
                                                                                  : <BrandLoader full label="Opening the register" detail="Checking the active organization before loading POS data." />
                                                                                : <DashboardPage key={organizationRevision} baseCurrency={baseCurrency} userName={auth.user.name || auth.user.email} />}
              </div>
            </Suspense>
          </PageErrorBoundary>
        </div>
        <ChatDock pathname={pathname} organizationId={activeOrgId} actorId={currentUserId} />
        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </TooltipProvider>
  );
}

function NotFoundRoute() {
  return (
    <main className="route-not-found">
      <p className="shell-kicker">Workspace</p>
      <h1>Page not found</h1>
      <p>This address does not match a page in this workspace.</p>
      <a className="shell-button" href="/">Return to home</a>
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
  if (/^\/invite\/[^/]+$/.test(pathname)) return <InvitationPage pathname={pathname} />;
  if (pathname === "/onboarding") return <OnboardingPage />;
  if (/^\/portal\/[^/]+$/.test(pathname)) return <PortalInvoicePage pathname={pathname} />;
  if (/^\/widget\/[^/]+$/.test(pathname)) return <WidgetPage pathname={pathname} />;
  if (/^\/print\/invoice\/[^/]+$/.test(pathname)) return <InvoicePrintPage pathname={pathname} />;
  if (!isViteAppPath(pathname)) return <NotFoundRoute />;
  return <AuthenticatedApp pathname={pathname} />;
}
