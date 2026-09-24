"use client";

import { type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { IconBookOpen, IconBox, IconCalendar, IconFileText, IconListTree, IconTruck, IconUpload, IconUsers } from "@/components/icons";
import { useQuickCreate, type QuickCreateEntityId } from "@/app/(app)/quick-create";
import { cn } from "@/lib/format";

type ActionIcon = ComponentType<{ className?: string }>;
type Action =
  | { label: string; hint: string; icon: ActionIcon; href: string }
  | { label: string; hint: string; icon: ActionIcon; entity: QuickCreateEntityId };

const contextual: Record<string, Action[]> = {
  documents: [
    { label: "Browse templates", hint: "Start from a polished layout", icon: IconBookOpen, href: "/documents?tab=write" },
    { label: "Organize folders", hint: "Open the document library", icon: IconListTree, href: "/documents?tab=library" },
  ],
  accounting: [
    { label: "New journal entry", hint: "Open the journal", icon: IconFileText, href: "/accounting?tab=journal" },
    { label: "Review receivables", hint: "Open customer balances", icon: IconUsers, href: "/accounting?tab=receivables" },
    { label: "Review payables", hint: "Open vendor balances", icon: IconTruck, href: "/accounting?tab=payables" },
    { label: "Add supporting document", hint: "Upload to documents", icon: IconUpload, href: "/documents?tab=ingest" },
  ],
  sales: [
    { label: "New customer", hint: "Create inline", icon: IconUsers, entity: "customer" },
    { label: "New quotation", hint: "Open a new quote", icon: IconFileText, href: "/sales?tab=new" },
    { label: "New sales order", hint: "Open a new order", icon: IconTruck, href: "/sales?tab=new-order" },
    { label: "Invoice template", hint: "Open the document studio", icon: IconBookOpen, href: "/documents?tab=write" },
  ],
  purchasing: [
    { label: "New vendor", hint: "Create inline", icon: IconUsers, entity: "vendor" },
    { label: "New purchase order", hint: "Open procurement orders", icon: IconTruck, href: "/purchasing?tab=orders" },
    { label: "New request", hint: "Open requests and RFQs", icon: IconFileText, href: "/purchasing?tab=requests" },
    { label: "Upload supplier document", hint: "Add a bill or receipt", icon: IconUpload, href: "/documents?tab=ingest" },
  ],
  inventory: [
    { label: "New product", hint: "Create inline", icon: IconBox, entity: "product" },
    { label: "Stock levels", hint: "Review available stock", icon: IconListTree, href: "/inventory?tab=levels" },
    { label: "Reorder items", hint: "Review reorder alerts", icon: IconTruck, href: "/inventory?tab=reorder" },
    { label: "Upload stock document", hint: "Add supporting evidence", icon: IconUpload, href: "/documents?tab=ingest" },
  ],
  manufacturing: [
    { label: "New work order", hint: "Open work orders", icon: IconFileText, href: "/manufacturing?tab=orders" },
    { label: "Record production", hint: "Open production", icon: IconBox, href: "/manufacturing?tab=production" },
    { label: "Review stock", hint: "Open inventory", icon: IconListTree, href: "/inventory?tab=levels" },
    { label: "Add production document", hint: "Upload supporting evidence", icon: IconUpload, href: "/documents?tab=ingest" },
  ],
  hr: [
    { label: "New employment document", hint: "Open the document studio", icon: IconFileText, href: "/documents?tab=write" },
    { label: "People", hint: "Open the people register", icon: IconUsers, href: "/hr?tab=people" },
    { label: "Leave", hint: "Review leave requests", icon: IconCalendar, href: "/hr?tab=leave" },
    { label: "Expenses", hint: "Review team expenses", icon: IconBookOpen, href: "/hr?tab=expenses" },
  ],
  crm: [
    { label: "New customer", hint: "Create inline", icon: IconUsers, entity: "customer" },
    { label: "Pipeline", hint: "Review opportunities", icon: IconListTree, href: "/crm?tab=pipeline" },
    { label: "Tasks", hint: "Review follow-ups", icon: IconCalendar, href: "/crm?tab=tasks" },
    { label: "Create customer document", hint: "Open the document studio", icon: IconFileText, href: "/documents?tab=write" },
  ],
  projects: [
    { label: "New project task", hint: "Open project workspace", icon: IconListTree, href: "/projects" },
    { label: "Create project document", hint: "Open the document studio", icon: IconFileText, href: "/documents?tab=write" },
    { label: "Upload project file", hint: "Add supporting evidence", icon: IconUpload, href: "/documents?tab=ingest" },
  ],
  pos: [
    { label: "Open register", hint: "Start selling", icon: IconBox, href: "/pos?tab=sell" },
    { label: "Review sessions", hint: "Open register sessions", icon: IconCalendar, href: "/pos?tab=sessions" },
    { label: "Receipt templates", hint: "Open the document studio", icon: IconFileText, href: "/documents?tab=write" },
  ],
  support: [
    { label: "Open inbox", hint: "Review conversations", icon: IconUsers, href: "/support?tab=inbox" },
    { label: "Knowledge library", hint: "Open support content", icon: IconBookOpen, href: "/support?tab=library" },
    { label: "Create support document", hint: "Open the document studio", icon: IconFileText, href: "/documents?tab=write" },
    { label: "Upload support file", hint: "Add reference material", icon: IconUpload, href: "/documents?tab=ingest" },
  ],
};

export function QuickActionsMenu({ appId, compact = false }: { appId: string; compact?: boolean }) {
  const router = useRouter();
  const { open } = useQuickCreate();
  const actions = contextual[appId] ?? [
    { label: "Create document", hint: "Open the editor", icon: IconFileText, href: "/documents?tab=write" },
    { label: "Upload document", hint: "Add a file to the library", icon: IconUpload, href: "/documents?tab=ingest" },
  ];
  const visibleActions = compact ? actions.slice(0, 2) : actions;

  function run(action: Action) {
    if ("entity" in action) open(action.entity);
    else router.push(action.href);
  }

  return (
    <div
      role="group"
      aria-label="Quick actions"
      className={cn(
        "flex min-w-0 max-w-full flex-wrap items-center gap-1.5",
        compact ? "shrink-0" : "w-full sm:w-auto",
      )}
    >
      {!compact && <span className="sr-only">Quick actions</span>}
      {visibleActions.map((action) => {
        const ActionIcon = action.icon;
        return (
          <button
            key={action.label}
            type="button"
            aria-label={action.label}
            title={action.hint}
            onClick={() => run(action)}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-2.5 py-2 text-xs font-semibold whitespace-nowrap text-[#f7f1e8] transition-colors hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-[#e5c585]/70",
              compact && "size-9 justify-center px-0",
            )}
          >
            <ActionIcon className="size-3.5" />
            <span className={compact ? "sr-only" : undefined}>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}
