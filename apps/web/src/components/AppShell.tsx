"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Bot,
  Boxes,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  Factory,
  GitBranch,
  HeartPulse,
  Home,
  Inbox,
  KeyRound,
  Lightbulb,
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
import { getApiClient } from "@/lib/api";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import { filterNavByInstalled, type ModuleNavItem } from "@/lib/module-registry";

type StoredTheme = "light" | "dark" | "system";
type AppliedTheme = "light" | "dark";
type Accent = "maroon" | "teal" | "blue" | "violet" | "rose" | "amber" | "forest" | "slate";

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
  "/notifications": Inbox,
  "/directory": Users,
  "/gaps": Lightbulb,
  "/branches": GitBranch,
  "/crm": Users,
  "/accounting": CircleDollarSign,
  "/inventory": Package,
  "/purchasing": ShoppingCart,
  "/hr": BriefcaseBusiness,
  "/manufacturing": Factory,
  "/rbac": KeyRound,
  "/marketplace": Boxes,
  "/audit": ClipboardList,
  "/settings": Settings,
};

const GROUP_LABELS: Record<ModuleNavItem["group"], string> = {
  workspace: "Workspace",
  business: "Business",
  system: "System",
};

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
  const [storedTheme, setStoredTheme] = useState<StoredTheme>("system");
  const [accent, setAccent] = useState<Accent>("maroon");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accentOpen, setAccentOpen] = useState(false);
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
        api.session().then(setSession).catch(() => null);
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
  }, []);

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

  const navGroups = useMemo(() => {
    const groups: { label: string; items: { href: string; label: string; icon: LucideIcon }[] }[] = [];
    for (const group of ["workspace", "business", "system"] as const) {
      const items = navItems
        .filter((n) => n.group === group)
        .map((n) => ({
          href: n.href,
          label: n.label,
          icon: NAV_ICONS[n.href] ?? Boxes,
        }));
      if (items.length) groups.push({ label: GROUP_LABELS[group], items });
    }
    return groups;
  }, [navItems]);

  const currentPage = useMemo(() => {
    for (const group of navGroups) {
      const found = group.items.find((item) => item.href === pathname);
      if (found) return found.label;
    }
    return "Dashboard";
  }, [pathname, navGroups]);

  const cycleTheme = useCallback(() => {
    setStoredTheme((cur) => (cur === "system" ? "light" : cur === "light" ? "dark" : "system"));
  }, []);

  const themeTitle =
    storedTheme === "system" ? "System theme" : storedTheme === "dark" ? "Dark theme" : "Light theme";
  const ThemeIcon = storedTheme === "system" ? SunMoon : storedTheme === "dark" ? Moon : Sun;

  function SidebarContent() {
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
          {navGroups.map((group) => (
            <section key={group.label} className="nav-section">
              <div className="nav-section-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    className={active ? "nav-link active" : "nav-link"}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </section>
          ))}
        </nav>
      </>
    );
  }

  const statusLabel =
    health === "online" ? "System online" : health === "offline" ? "Service offline" : "Connecting";
  const autonomyLabel = session?.autonomy
    ? (AUTONOMY_LABELS[session.autonomy] ?? session.autonomy)
    : "Standard";

  return (
    <>
      <div className="app-frame">
        <aside className="sidebar">
          <SidebarContent />
        </aside>
        <div className="mobile-drawer-shell" data-open={drawerOpen ? "true" : "false"}>
          <button className="drawer-scrim" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />
          <aside className="mobile-drawer">
            <button className="icon-btn drawer-close" type="button" onClick={() => setDrawerOpen(false)}>
              <X size={18} />
            </button>
            <SidebarContent />
          </aside>
        </div>
        <main className="workspace">
          <header className="topbar">
            <button className="icon-btn mobile-menu" type="button" onClick={() => setDrawerOpen(true)}>
              <Menu size={19} />
            </button>
            <div className="page-title-block">
              <div className="eyebrow">
                <HeartPulse size={14} />
                <span>{statusLabel}</span>
              </div>
              <h1 className="page-title">{currentPage}</h1>
              {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
            </div>
            <div className="topbar-actions">
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
