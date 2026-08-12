"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@chaste/api-client";
import {
  Bell,
  Bot,
  Boxes,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Factory,
  Home,
  LogOut,
  Menu,
  MessageSquare,
  Mail,
  Moon,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sun,
  SunMoon,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { ChatWidget } from "@/components/ChatWidget";
import { getApiClient, setStoredAuthToken } from "@/lib/api";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import {
  filterNavByInstalled,
  NAV_SECTION_LABELS,
  type ModuleNavItem,
} from "@/lib/module-registry";

type StoredTheme = "light" | "dark" | "system";
type AppliedTheme = "light" | "dark";
type Accent = "maroon" | "teal" | "blue" | "violet" | "rose" | "amber" | "forest" | "slate";
type NavGroup = ModuleNavItem["group"];

const ACCENTS: { value: Accent; label: string; swatch: string }[] = [
  { value: "maroon", label: "Deep Maroon", swatch: "#7a1f2b" },
  { value: "teal", label: "Teal", swatch: "#0f8c86" },
  { value: "blue", label: "Blue", swatch: "#2563eb" },
  { value: "violet", label: "Violet", swatch: "#7c3aed" },
  { value: "rose", label: "Rose", swatch: "#e11d48" },
  { value: "amber", label: "Amber", swatch: "#c27803" },
  { value: "forest", label: "Forest", swatch: "#2f6b4a" },
  { value: "slate", label: "Slate", swatch: "#475569" },
];

const NAV_ICONS: Record<string, LucideIcon> = {
  "/": Home,
  "/workflows": Workflow,
  "/calendar": CalendarDays,
  "/reminders": Bell,
  "/messaging": MessageSquare,
  "/email": Mail,
  "/directory": Users,
  "/crm": Users,
  "/accounting": CircleDollarSign,
  "/inventory": Package,
  "/purchasing": ShoppingCart,
  "/hr": BriefcaseBusiness,
  "/manufacturing": Factory,
  "/extensions": Boxes,
  "/settings": Settings,
};

const SECTION_ORDER: NonNullable<ModuleNavItem["section"]>[] = [
  "communicate",
  "people",
  "platform",
];

const AUTONOMY_LABELS: Record<string, string> = {
  recommend: "Assist",
  confirm: "Confirm",
  guarded_auto: "Supervised",
  full_autonomous: "Full auto",
};

function appliedThemeFromStored(stored: StoredTheme | null): AppliedTheme {
  if (stored === "dark") return "dark";
  if (stored === "light") return "light";
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function AppShell({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [storedTheme, setStoredTheme] = useState<StoredTheme>("system");
  const [accent, setAccent] = useState<Accent>("maroon");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accentOpen, setAccentOpen] = useState(false);
  /** Icon-rail breakpoint: show every group so destinations stay reachable. */
  const [railNav, setRailNav] = useState(false);
  const [health, setHealth] = useState<"checking" | "online" | "offline">("checking");
  const [enabledModules, setEnabledModules] = useState<{ moduleId: string; enabled: boolean }[] | null>(
    null,
  );
  const [session, setSession] = useState<{
    displayName: string;
    orgName?: string;
    email: string;
    autonomy: string;
    region?: string;
    permissions?: string[];
  } | null>(null);

  const appliedTheme: AppliedTheme = appliedThemeFromStored(storedTheme);
  const accentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedTheme = localStorage.getItem("chaste-theme-saved") as StoredTheme | null;
    const savedAccent = localStorage.getItem("chaste-accent") as Accent | null;
    if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
      setStoredTheme(savedTheme);
    } else {
      setStoredTheme("system");
    }
    if (savedAccent && ACCENTS.some((a) => a.value === savedAccent)) {
      setAccent(savedAccent);
    } else {
      setAccent("maroon");
      localStorage.setItem("chaste-accent", "maroon");
    }
    getApiClient()
      .getPreferences()
      .then((prefs) => {
        const p = prefs as { preferences?: { theme?: string; accent?: string } };
        if (p?.preferences?.theme) {
          const t = p.preferences.theme as StoredTheme;
          if (t === "light" || t === "dark" || t === "system") setStoredTheme(t);
        }
        if (p?.preferences?.accent) {
          const a = p.preferences.accent as Accent;
          if (ACCENTS.some((x) => x.value === a)) setAccent(a);
        }
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (appliedTheme === "dark") {
      document.documentElement.dataset.theme = "dark";
    } else {
      document.documentElement.dataset.theme = "light";
    }
    document.documentElement.dataset.accent = accent;
    localStorage.setItem("chaste-theme-saved", storedTheme);
    localStorage.setItem("chaste-accent", accent);
    getApiClient()
      .updatePreferences({ theme: storedTheme, accent })
      .catch(() => null);
  }, [storedTheme, accent, appliedTheme]);

  useEffect(() => {
    if (storedTheme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [storedTheme]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const api = getApiClient();
      try {
        await api.health();
        if (cancelled) return;
        setHealth("online");
        api
          .session()
          .then((s) => {
            if (!cancelled) setSession(s);
          })
          .catch((e) => {
            if (cancelled) return;
            // Unauthenticated or expired token: send the operator to /login.
            if (e instanceof ApiError && e.status === 401) {
              router.replace("/login");
              return;
            }
            setSession(null);
          });
        api
          .listModules()
          .then((mods) => {
            if (!cancelled) setEnabledModules(mods.installed);
          })
          .catch(() => {
            if (!cancelled) setEnabledModules([]);
          });
      } catch {
        if (!cancelled) {
          setHealth("offline");
          setEnabledModules([]);
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!accentOpen) return;
    function onDoc(e: MouseEvent) {
      if (accentRef.current && !accentRef.current.contains(e.target as Node)) {
        setAccentOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [accentOpen]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1180px) and (min-width: 761px)");
    const sync = () => setRailNav(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const navItems = useMemo(() => {
    // Until modules load, show full business nav to avoid flicker; then filter
    if (enabledModules === null) {
      return filterNavByInstalled(
        ["crm", "accounting", "inventory", "purchasing", "hr", "manufacturing"].map((moduleId) => ({
          moduleId,
          enabled: true,
        })),
      );
    }
    return filterNavByInstalled(enabledModules);
  }, [enabledModules]);

  const currentPage = useMemo(() => {
    const found = navItems.find((item) => item.href === pathname);
    return found?.label ?? "Dashboard";
  }, [pathname, navItems]);

  const buildSections = useCallback(
    (group: NavGroup, showSectionLabels: boolean) => {
      const items = navItems.filter((n) => n.group === group && !n.pinned);
      const sections: {
        key: string;
        label: string | null;
        items: { href: string; label: string; icon: LucideIcon }[];
      }[] = [];

      const unsectioned = items.filter((n) => !n.section);
      if (unsectioned.length) {
        sections.push({
          key: `${group}-main`,
          label: null,
          items: unsectioned.map((n) => ({
            href: n.href,
            label: n.label,
            icon: NAV_ICONS[n.href] ?? Boxes,
          })),
        });
      }

      for (const section of SECTION_ORDER) {
        const sectionItems = items.filter((n) => n.section === section);
        if (!sectionItems.length) continue;
        sections.push({
          key: `${group}-${section}`,
          label: showSectionLabels ? NAV_SECTION_LABELS[section] : null,
          items: sectionItems.map((n) => ({
            href: n.href,
            label: n.label,
            icon: NAV_ICONS[n.href] ?? Boxes,
          })),
        });
      }

      return sections;
    },
    [navItems],
  );

  const fullNavSections = useMemo(() => {
    return (["workspace", "business", "system"] as const).flatMap((group) =>
      buildSections(group, true),
    );
  }, [buildSections]);

  const railNavSections = useMemo(() => {
    return (["workspace", "business", "system"] as const).flatMap((group) =>
      buildSections(group, false),
    );
  }, [buildSections]);

const cycleTheme = useCallback(() => {
    setStoredTheme((cur) => (cur === "system" ? "light" : cur === "dark" ? "light" : "system"));
  }, []);

  const signOut = useCallback(async () => {
    setStoredAuthToken(null);
    router.replace("/login");
  }, [router]);

  const themeTitle =
    storedTheme === "system" ? "System theme" : storedTheme === "dark" ? "Dark theme" : "Light theme";
  const ThemeIcon = storedTheme === "system" ? SunMoon : storedTheme === "dark" ? Moon : Sun;

  const statusLabel = health === "online" ? "Online" : health === "offline" ? "Offline" : "Connecting";
  const statusClass =
    health === "online" ? "online" : health === "offline" ? "offline" : "checking";

  function SidebarContent({ mode }: { mode: "full" | "rail" }) {
    const sections = mode === "rail" ? railNavSections : fullNavSections;
    return (
      <>
        <div className="side-brand">
          <div className="brand-mark">
            <ShieldCheck size={19} />
          </div>
          <div>
            <div className="brand-word">ChasteBusinessOS</div>
            <div className="brand-sub">Governed business operations</div>
          </div>
        </div>
        <nav className="side-nav" aria-label="Primary navigation">
          {sections.map((section) => (
            <section key={section.key} className="nav-section">
              {section.label ? <div className="nav-section-label">{section.label}</div> : null}
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    className={active ? "nav-link active" : "nav-link"}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    title={item.label}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </section>
          ))}
        </nav>
        {navItems.filter((n) => n.pinned).length > 0 ? (
          <div className="side-footer">
            {navItems
              .filter((n) => n.pinned)
              .map((item) => {
                const Icon = NAV_ICONS[item.href] ?? Settings;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    className={active ? "nav-link active" : "nav-link"}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    title={item.label}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
          </div>
        ) : null}
      </>
    );
  }

  const autonomyLabel = session?.autonomy
    ? (AUTONOMY_LABELS[session.autonomy] ?? session.autonomy)
    : "Standard";

  return (
    <>
      <div className="app-frame">
        <aside className="sidebar">
          <SidebarContent mode={railNav ? "rail" : "full"} />
        </aside>
        <div className="mobile-drawer-shell" data-open={drawerOpen ? "true" : "false"}>
          <button className="drawer-scrim" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />
          <aside className="mobile-drawer">
            <button className="icon-btn drawer-close" type="button" onClick={() => setDrawerOpen(false)}>
              <X size={18} />
            </button>
            <SidebarContent mode="full" />
          </aside>
        </div>
        <main className="workspace">
          <header className="topbar">
            <button className="icon-btn mobile-menu" type="button" onClick={() => setDrawerOpen(true)}>
              <Menu size={19} />
            </button>
            <div className="page-title-block">
              <span className={`online-status is-${statusClass}`} title={statusLabel}>
                {statusLabel}
              </span>
              <h1 className="page-title">{currentPage}</h1>
              {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
            </div>
            <div className="topbar-actions">
              <Link
                href="/notifications"
                className="icon-btn topbar-bell"
                aria-label="Notifications"
                title="Notifications"
              >
                <Bell size={15} />
              </Link>
              <BranchSwitcher
                canRead={session?.permissions?.includes("core.branch.read") ?? false}
                orgName={session?.orgName}
                autonomy={autonomyLabel}
              />
              <div className="status-pill autonomy">
                <Bot size={15} />
                <span>{autonomyLabel}</span>
              </div>
              <button
                className="icon-btn tip"
                type="button"
                data-tip={themeTitle}
                onClick={cycleTheme}
                aria-label="Cycle theme"
                title={themeTitle}
              >
                <ThemeIcon size={15} />
              </button>
              <button
                className="icon-btn tip"
                type="button"
                data-tip="Sign out"
                onClick={signOut}
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut size={15} />
              </button>
              <div className="accent-select-wrap" ref={accentRef}>
                <button
                  type="button"
                  className="accent-select"
                  data-open={accentOpen ? "true" : "false"}
                  onClick={() => setAccentOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={accentOpen}
                  title="Accent color"
                >
                  <span
                    className="swatch"
                    style={{ background: ACCENTS.find((a) => a.value === accent)?.swatch }}
                  />
                  <span className="label">{ACCENTS.find((a) => a.value === accent)?.label ?? "Accent"}</span>
                  <span className="chev">
                    <ChevronDown size={14} />
                  </span>
                </button>
                {accentOpen ? (
                  <div className="accent-menu" role="listbox">
                    {ACCENTS.map((a) => (
                      <button
                        key={a.value}
                        type="button"
                        className={`accent-menu-item${a.value === accent ? " selected" : ""}`}
                        onClick={() => {
                          setAccent(a.value);
                          setAccentOpen(false);
                        }}
                        role="option"
                        aria-selected={a.value === accent}
                      >
                        <span
                          className="accent-menu-swatch"
                          style={{ "--swatch-color": a.swatch } as React.CSSProperties}
                        />
                        <span>{a.label}</span>
                        <span className="check">
                          <Check size={14} />
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </header>
          <div className="content-plane">{children}</div>
        </main>
      </div>
      <nav className="bottom-tabs" aria-label="Mobile quick navigation">
        {[
          { href: "/", label: "Home", icon: Home },
          { href: "/crm", label: "CRM", icon: Users },
          { href: "/hr", label: "HR", icon: BriefcaseBusiness },
          { href: "/settings", label: "Settings", icon: Settings },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.href} className={pathname === item.href ? "active" : ""} href={item.href}>
              <Icon size={18} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <ChatWidget floating />
    </>
  );
}
