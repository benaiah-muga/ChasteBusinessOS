import Link from "next/link";

const links = [
  { href: "/", label: "Operations" },
  { href: "/crm", label: "CRM" },
  { href: "/accounting", label: "Accounting" },
  { href: "/inventory", label: "Inventory" },
  { href: "/purchasing", label: "Purchasing" },
  { href: "/hr", label: "HR" },
  { href: "/manufacturing", label: "Manufacturing" },
  { href: "/rbac", label: "RBAC" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({
  children,
  subtitle,
}: {
  children: React.ReactNode;
  subtitle?: string;
}) {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1 className="brand">ChasteBusinessOS</h1>
          <p className="tagline">
            {subtitle ??
              "AI-native business operations. Web is an HTTP API client — no kernel coupling."}
          </p>
        </div>
      </header>
      <nav className="nav">
        {links.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
      </nav>
      {children}
    </main>
  );
}
