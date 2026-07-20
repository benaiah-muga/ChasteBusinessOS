"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  Factory,
  HeartPulse,
  Home,
  KeyRound,
  Menu,
  Moon,
  Package,
  Palette,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Sun,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { ChatWidget } from "@/components/ChatWidget";
import { getApiClient } from "@/lib/api";

type Theme = "light" | "dark";
type Accent = "teal" | "blue" | "violet" | "rose" | "amber";

const navGroups = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Dashboard", icon: Home },
      { href: "/workflows", label: "Workflows", icon: Workflow },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/crm", label: "CRM", icon: Users },
      { href: "/accounting", label: "Accounting", icon: CircleDollarSign },
      { href: "/inventory", label: "Inventory", icon: Package },
      { href: "/purchasing", label: "Purchasing", icon: ShoppingCart },
      { href: "/hr", label: "HR", icon: BriefcaseBusiness },
      { href: "/manufacturing", label: "Manufacturing", icon: Factory },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/rbac", label: "RBAC", icon: KeyRound },
      { href: "/marketplace", label: "Marketplace", icon: Boxes },
      { href: "/audit", label: "Audit log", icon: ClipboardList },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const accents: { value: Accent; label: string }[] = [
  { value: "teal", label: "Teal" },
  { value: "blue", label: "Blue" },
  { value: "violet", label: "Violet" },
  { value: "rose", label: "Rose" },
  { value: "amber", label: "Amber" },
];

export function AppShell({
  children,
  subtitle,
}: {
  children: React.ReactNode;
  subtitle?: string;
}) {
  const pathname = usePathname();
  const [theme, setTheme] = useState<Theme>("light");
  const [accent, setAccent] = useState<Accent>("teal");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [booting, setBooting] = useState(true);
  const [health, setHealth] = useState<"checking" | "online" | "offline">("checking");
  const [session, setSession] = useState<{
    displayName: string;
    orgName?: string;
    email: string;
    autonomy: string;
  } | null>(null);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("chaste-theme") as Theme | null;
    const savedAccent = window.localStorage.getItem("chaste-accent") as Accent | null;
    if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
    if (savedAccent && accents.some((item) => item.value === savedAccent)) setAccent(savedAccent);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    window.localStorage.setItem("chaste-theme", theme);
    window.localStorage.setItem("chaste-accent", accent);
  }, [theme, accent]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const api = getApiClient();
      try {
        await api.health();
        if (cancelled) return;
        setHealth("online");
        api.session().then(setSession).catch(() => null);
      } catch {
        if (!cancelled) setHealth("offline");
      } finally {
        window.setTimeout(() => {
          if (!cancelled) setBooting(false);
        }, 650);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentPage = useMemo(() => {
    for (const group of navGroups) {
      const found = group.items.find((item) => item.href === pathname);
      if (found) return found.label;
    }
    return "Dashboard";
  }, [pathname]);

  function SidebarContent() {
    return (
      <>
        <div className="side-brand">
          <div className="brand-mark">
            <ShieldCheck size={19} />
          </div>
          <div>
            <div className="brand-word">ChasteBusinessOS</div>
            <div className="brand-sub">Command-governed operations</div>
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

  return (
    <>
      {booting ? <BootScreen health={health} /> : null}
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
                <span>{health === "online" ? "System online" : health === "offline" ? "API offline" : "Checking API"}</span>
              </div>
              <h1 className="page-title">{currentPage}</h1>
              {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
            </div>
            <div className="topbar-actions">
              <div className="status-pill">
                <Building2 size={15} />
                <span>{session?.orgName ?? session?.email ?? "Local org"}</span>
              </div>
              <div className="status-pill autonomy">
                <Bot size={15} />
                <span>{session?.autonomy ?? "unknown"}</span>
              </div>
              <div className="segmented" aria-label="Theme">
                <button
                  className={theme === "light" ? "selected" : ""}
                  type="button"
                  onClick={() => setTheme("light")}
                  title="Light theme"
                >
                  <Sun size={15} />
                </button>
                <button
                  className={theme === "dark" ? "selected" : ""}
                  type="button"
                  onClick={() => setTheme("dark")}
                  title="Dark theme"
                >
                  <Moon size={15} />
                </button>
              </div>
              <label className="accent-select" title="Accent color">
                <Palette size={15} />
                <select value={accent} onChange={(event) => setAccent(event.target.value as Accent)}>
                  {accents.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </label>
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

function BootScreen({ health }: { health: "checking" | "online" | "offline" }) {
  return (
    <div className="boot-screen">
      <div className="boot-core">
        <div className="boot-glyph">
          <Sparkles size={31} />
        </div>
        <div>
          <h2>ChasteBusinessOS</h2>
          <p>
            {health === "offline"
              ? "API is not responding"
              : health === "online"
                ? "System ready"
                : "Initializing system"}
          </p>
        </div>
        <div className="boot-rail">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}
