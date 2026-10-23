import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  BookOpenCheck,
  Boxes,
  Building2,
  ChartNoAxesCombined,
  CircleHelp,
  ClipboardList,
  ContactRound,
  Factory,
  FileSignature,
  FileText,
  FolderKanban,
  HandCoins,
  Home,
  Inbox,
  Landmark,
  Layers3,
  LifeBuoy,
  ListTree,
  Megaphone,
  MessagesSquare,
  Package,
  Receipt,
  ReceiptText,
  ScanLine,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Store,
  Truck,
  Users,
  WalletCards,
} from "lucide-react";

export type NavLeaf = {
  label: string;
  href: string;
  icon?: LucideIcon;
  description?: string;
  keywords?: string[];
  ariaLabel?: string;
};

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
  keywords?: string[];
  badge?: "approvals";
  ariaLabel?: string;
  children?: NavLeaf[];
};

export type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

export const PRIMARY_NAV: NavItem[] = [
  { label: "Home", href: "/", icon: Home, description: "Your business at a glance", keywords: ["dashboard", "overview"] },
  { label: "Inbox", href: "/inbox", icon: Inbox, description: "Everything waiting on you", badge: "approvals", keywords: ["signals", "alerts", "attention"] },
  { label: "Approvals", href: "/approvals", icon: ShieldCheck, description: "Actions waiting on your authority", keywords: ["authority", "review"] },
  { label: "Workmate", href: "/chat", icon: Sparkles, description: "Ask, plan, and act with your AI workmate", keywords: ["agent", "assistant", "chat"] },
];

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "money",
    label: "Money",
    items: [
      {
        label: "Accounting",
        href: "/accounting",
        icon: Landmark,
        description: "Books, invoices, bills, banking, tax, budgets",
        keywords: ["gl", "journal", "ledger", "reports", "receivables", "payables"],
        children: [
          { label: "Overview", href: "/accounting", icon: ChartNoAxesCombined, description: "Books, reports, and close" },
          { label: "Invoices", href: "/accounting/invoices", icon: ReceiptText, description: "Issued invoices and balances" },
          { label: "Close readiness", href: "/accounting/close", icon: ShieldCheck, description: "Period close checks" },
        ],
      },
      {
        label: "Sales",
        href: "/sales",
        icon: ShoppingCart,
        description: "Orders, quotes, register, shift summary",
        keywords: ["orders", "quotes", "pos", "checkout"],
        children: [
          { label: "Sales orders", href: "/sales", icon: ClipboardList, description: "Orders, quotes, and customers" },
          { label: "Register", href: "/pos", icon: ScanLine, description: "Take a payment at the counter" },
          { label: "Shift summary", href: "/pos/shift-summary", icon: HandCoins, description: "Tills, takings, and variance", ariaLabel: "POS summary" },
        ],
      },
      {
        label: "Purchasing",
        href: "/purchasing",
        icon: Truck,
        description: "Suppliers, purchase orders, bills, payments",
        keywords: ["vendors", "suppliers", "procurement", "payables"],
        children: [
          { label: "Workspace", href: "/purchasing", icon: Layers3, description: "Requests, orders, bills, suppliers" },
          { label: "Payment runs", href: "/purchasing/payment-runs", icon: WalletCards, description: "Pay open bills in one run" },
          { label: "Payables aging", href: "/purchasing/ap-aging", icon: Receipt, description: "What is due, and when" },
          { label: "Receipts", href: "/purchasing/receipts", icon: ListTree, description: "Goods received against orders" },
          { label: "Receiving", href: "/purchasing/receiving", icon: Package, description: "Receive and match deliveries" },
        ],
      },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      {
        label: "Inventory",
        href: "/inventory",
        icon: Boxes,
        description: "Stock, products, transfers, counts, valuation",
        keywords: ["stock", "items", "warehouse", "reorder"],
        children: [
          { label: "Stock", href: "/inventory", icon: Boxes, description: "Levels, movements, and counts" },
          { label: "Products", href: "/products", icon: Package, description: "Catalogue, pricing, and barcodes" },
        ],
      },
      { label: "Manufacturing", href: "/manufacturing", icon: Factory, description: "BOMs, work orders, production runs", keywords: ["bom", "production"] },
      { label: "Projects", href: "/projects", icon: FolderKanban, description: "Boards, tasks, owners, and deadlines", keywords: ["tasks", "kanban"] },
    ],
  },
  {
    id: "relationships",
    label: "Relationships",
    items: [
      { label: "CRM", href: "/crm", icon: ContactRound, description: "Customers, deals, pipeline, tasks", keywords: ["customers", "pipeline", "leads"] },
      { label: "Marketing", href: "/marketing", icon: Megaphone, description: "Segments, campaigns, send log", keywords: ["campaigns", "email"] },
      { label: "Support", href: "/support", icon: LifeBuoy, description: "Tickets, SLA, knowledge base", keywords: ["helpdesk", "tickets"] },
      { label: "Proposals", href: "/proposals", icon: FileSignature, description: "Agent proposals and Creator mode", keywords: ["creator", "marketplace"] },
    ],
  },
  {
    id: "people",
    label: "People",
    items: [
      { label: "People", href: "/hr", icon: Users, description: "Employees, leave, time, payroll, expenses", keywords: ["hr", "payroll"] },
      { label: "Team", href: "/team", icon: ShieldCheck, description: "Members, roles, SSO, and access", keywords: ["permissions", "roles"] },
    ],
  },
  {
    id: "company",
    label: "Company",
    items: [
      { label: "Documents", href: "/documents", icon: FileText, description: "Files, folders, versions, record links", keywords: ["files", "library"] },
      { label: "Messages", href: "/messages", icon: MessagesSquare, description: "Channels and direct messages", keywords: ["chat", "team"] },
      { label: "Analytics", href: "/analytics", icon: BarChart3, description: "Governed reports and explain-change", keywords: ["reports", "insight"] },
      { label: "Ledger", href: "/ledger", icon: ScrollText, description: "Hash-chained audit of every action", keywords: ["audit", "events"] },
      { label: "Agent runs", href: "/sessions", icon: BookOpenCheck, description: "Session history and replay", keywords: ["sessions", "replay", "workmate"], ariaLabel: "Sessions" },
      { label: "Marketplace", href: "/marketplace", icon: Store, description: "Install capabilities and plugins", keywords: ["extensions", "plugins"] },
      { label: "Settings", href: "/settings", icon: Settings, description: "Workspace, modules, governance, quality", keywords: ["configuration", "preferences"] },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = [
  ...PRIMARY_NAV,
  ...NAV_GROUPS.flatMap((group) => group.items),
];

export function flattenNavLeaves(): NavLeaf[] {
  const leaves: NavLeaf[] = [];
  for (const item of ALL_NAV_ITEMS) {
    if (item.children) {
      for (const child of item.children) leaves.push({ ...child, keywords: [...(item.keywords ?? []), ...(child.keywords ?? [])] });
    } else {
      leaves.push({ label: item.label, href: item.href, icon: item.icon, description: item.description, keywords: item.keywords });
    }
  }
  return leaves;
}

export function isNavItemActive(pathname: string, item: NavItem): boolean {
  if (item.href === "/") return pathname === "/";
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return item.children?.some((child) => pathname === child.href || pathname.startsWith(`${child.href}/`)) ?? false;
}

export function isLeafActive(pathname: string, leaf: NavLeaf): boolean {
  return leaf.href === "/" ? pathname === "/" : pathname === leaf.href || pathname.startsWith(`${leaf.href}/`);
}

export function pageMeta(pathname: string): { label: string; group: string; description: string } {
  const exactItem = ALL_NAV_ITEMS.find((item) => item.href === pathname);
  const primaryItem = PRIMARY_NAV.find((item) => item.href === pathname);
  if (exactItem || primaryItem) {
    const item = exactItem ?? primaryItem!;
    const group = PRIMARY_NAV.some((entry) => entry.href === pathname)
      ? "Overview"
      : NAV_GROUPS.find((entry) => entry.items.some((candidate) => candidate.href === item.href))?.label ?? "Workspace";
    return { label: item.label, group, description: item.description };
  }
  const leaves = flattenNavLeaves();
  const exact = leaves
    .filter((leaf) => isLeafActive(pathname, leaf))
    .sort((left, right) => right.href.length - left.href.length)[0];
  if (exact) {
    const group = NAV_GROUPS.find((entry) => entry.items.some((item) => isNavItemActive(pathname, item)))?.label ?? "Workspace";
    return { label: exact.label, group, description: exact.description ?? "" };
  }
  return { label: "Chaste BusinessOS", group: "Workspace", description: "The AI-native business operating system" };
}

export const NAV_ICONS = {
  home: Home,
  inbox: Inbox,
  workmate: Sparkles,
  accounting: Landmark,
  sales: ShoppingCart,
  purchasing: Truck,
  inventory: Boxes,
  manufacturing: Factory,
  projects: FolderKanban,
  crm: ContactRound,
  marketing: Megaphone,
  support: LifeBuoy,
  proposals: FileSignature,
  people: Users,
  team: ShieldCheck,
  documents: FileText,
  messages: MessagesSquare,
  analytics: BarChart3,
  ledger: ScrollText,
  sessions: BookOpenCheck,
  marketplace: Store,
  settings: Settings,
  notifications: Bell,
  building: Building2,
  help: CircleHelp,
} as const satisfies Record<string, LucideIcon>;
