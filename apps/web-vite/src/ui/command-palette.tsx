import { Command } from "cmdk";
import { ArrowUpRight, CornerDownLeft, Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { searchRecords, type RecordSearchGroup } from "../api/search";
import { navigate } from "../navigation";
import { NAV_GROUPS, PRIMARY_NAV, type NavLeaf } from "../shell/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Kbd } from "./page-header";

const RECENT_KEY = "chaste-command-recent";

const QUICK_ASKS = [
  { label: "Draft an invoice", prompt: "Draft an invoice. Ask me for the customer, the line items, and the due date you need." },
  { label: "Record a supplier bill", prompt: "Help me record a supplier bill we received. Ask for the supplier, amount, and due date." },
  { label: "Catch me up", prompt: "Give me a short brief of what needs my attention today, what changed since yesterday, and what you recommend I do first." },
  { label: "Add a customer", prompt: "Add a customer. Ask me for the name, email, phone, and billing address you need." },
  { label: "Check cash and runway", prompt: "Give me the cash position, the 13-week forecast, and the three largest risks to runway." },
  { label: "Reorder low stock", prompt: "Review stock at or below its reorder point and prepare a replenishment plan for my approval." },
];

function readRecent(): NavLeaf[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is NavLeaf => Boolean(entry) && typeof entry === "object" && "label" in entry && "href" in entry).slice(0, 4);
  } catch {
    return [];
  }
}

function remember(leaf: NavLeaf) {
  try {
    const current = readRecent().filter((entry) => entry.href !== leaf.href);
    localStorage.setItem(RECENT_KEY, JSON.stringify([leaf, ...current].slice(0, 4)));
  } catch {
    // Recent destinations are a convenience; storage can be unavailable.
  }
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate?: (href: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<NavLeaf[]>([]);
  const [records, setRecords] = useState<RecordSearchGroup[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setRecent(readRecent());
      setQuery("");
      setRecords([]);
    }
  }, [open]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!open || trimmed.length < 2) {
      setRecords([]);
      setRecordsLoading(false);
      return;
    }
    const controller = new AbortController();
    setRecordsLoading(true);
    const timer = window.setTimeout(() => {
      void searchRecords(trimmed, controller.signal)
        .then((groups) => {
          if (!controller.signal.aborted) setRecords(groups);
        })
        .catch(() => {
          if (!controller.signal.aborted) setRecords([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setRecordsLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  function go(href: string, leaf?: NavLeaf) {
    if (leaf) remember(leaf);
    onOpenChange(false);
    if (onNavigate) onNavigate(href);
    else navigate(href);
  }

  const askHref = `/chat?prompt=${encodeURIComponent(query.trim())}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ui-command-dialog" showClose={false} aria-describedby={undefined}>
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <DialogDescription className="sr-only">Search pages, jump to a workspace, or ask your workmate to do something.</DialogDescription>
        <Command shouldFilter className="ui-command" loop>
          <div className="ui-command-input-wrap">
            <Search size={17} aria-hidden="true" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search pages, records, or ask anything…"
              aria-label="Search pages and commands"
            />
            <Kbd>Esc</Kbd>
          </div>
          <Command.List className="ui-command-list">
            <Command.Empty className="ui-command-empty">
              <span className="ui-command-empty-icon" aria-hidden="true">⌕</span>
              <strong>No page matches “{query}”</strong>
              <span>Ask your workmate instead. It can find the record or take the action.</span>
              {query.trim() && (
                <button type="button" className="ui-button ui-button-primary ui-button-sm" onClick={() => go(askHref)}>
                  <Sparkles size={14} aria-hidden="true" /> Ask Workmate
                </button>
              )}
            </Command.Empty>

            {records.length > 0 && (
              <Command.Group heading="Records" className="ui-command-group">
                {records.flatMap((group) => group.items.map((item) => (
                  <Command.Item
                    key={`${group.type}-${item.id}`}
                    value={`${item.title} ${item.subtitle ?? ""} ${group.label}`}
                    onSelect={() => go(item.href)}
                    className="ui-command-item"
                  >
                    <span className="ui-command-icon"><ArrowUpRight size={15} aria-hidden="true" /></span>
                    <span className="ui-command-copy">
                      <span className="ui-command-label">{item.title}</span>
                      <span className="ui-command-hint">{group.label}{item.subtitle ? ` · ${item.subtitle}` : ""}</span>
                    </span>
                  </Command.Item>
                )))}
              </Command.Group>
            )}
            {recordsLoading && query.trim().length >= 2 && (
              <Command.Group heading="Records" className="ui-command-group">
                <div className="ui-command-hint" role="status">Searching records…</div>
              </Command.Group>
            )}

            {query.trim() && (
              <Command.Group heading="Ask your workmate" className="ui-command-group">
                <Command.Item value={`ask workmate ${query}`} onSelect={() => go(askHref)} className="ui-command-item ui-command-item-ask">
                  <span className="ui-command-icon"><Sparkles size={16} aria-hidden="true" /></span>
                  <span className="ui-command-copy">
                    <span className="ui-command-label">Ask about “{query}”</span>
                    <span className="ui-command-hint">Send this to your workmate with full workspace context</span>
                  </span>
                  <CornerDownLeft size={14} className="ui-command-enter" aria-hidden="true" />
                </Command.Item>
              </Command.Group>
            )}

            {recent.length > 0 && !query && (
              <Command.Group heading="Recent" className="ui-command-group">
                {recent.map((leaf) => (
                  <Command.Item key={`recent-${leaf.href}`} value={`recent ${leaf.label}`} onSelect={() => go(leaf.href, leaf)} className="ui-command-item">
                    <span className="ui-command-icon"><ArrowUpRight size={15} aria-hidden="true" /></span>
                    <span className="ui-command-copy"><span className="ui-command-label">{leaf.label}</span></span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="Jump to" className="ui-command-group">
              {PRIMARY_NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <Command.Item
                    key={item.href}
                    value={`${item.label} ${item.description} ${(item.keywords ?? []).join(" ")}`}
                    onSelect={() => go(item.href, { label: item.label, href: item.href, description: item.description, icon: item.icon })}
                    className="ui-command-item"
                  >
                    <span className="ui-command-icon"><Icon size={16} aria-hidden="true" /></span>
                    <span className="ui-command-copy">
                      <span className="ui-command-label">{item.label}</span>
                      <span className="ui-command-hint">{item.description}</span>
                    </span>
                  </Command.Item>
                );
              })}
            </Command.Group>
            {NAV_GROUPS.map((group) => (
              <Command.Group key={group.id} heading={group.label} className="ui-command-group">
                {group.items.flatMap((item) => {
                  const Icon = item.icon;
                  const parent = (
                    <Command.Item
                      key={item.href}
                      value={`${item.label} ${item.description} ${(item.keywords ?? []).join(" ")}`}
                      onSelect={() => go(item.href, { label: item.label, href: item.href, description: item.description, icon: item.icon })}
                      className="ui-command-item"
                    >
                      <span className="ui-command-icon"><Icon size={16} aria-hidden="true" /></span>
                      <span className="ui-command-copy">
                        <span className="ui-command-label">{item.label}</span>
                        <span className="ui-command-hint">{item.description}</span>
                      </span>
                    </Command.Item>
                  );
                  const children = item.children?.filter((child) => child.href !== item.href).map((child) => {
                    const ChildIcon = child.icon;
                    return (
                      <Command.Item
                        key={child.href}
                        value={`${item.label} ${child.label} ${child.description ?? ""}`}
                        onSelect={() => go(child.href, child)}
                        className="ui-command-item ui-command-item-child"
                      >
                        <span className="ui-command-icon">{ChildIcon ? <ChildIcon size={15} aria-hidden="true" /> : <ArrowUpRight size={15} aria-hidden="true" />}</span>
                        <span className="ui-command-copy">
                          <span className="ui-command-label">{item.label} · {child.label}</span>
                          {child.description && <span className="ui-command-hint">{child.description}</span>}
                        </span>
                      </Command.Item>
                    );
                  }) ?? [];
                  return [parent, ...children];
                })}
              </Command.Group>
            ))}

            <Command.Group heading="Start with Workmate" className="ui-command-group">
              {QUICK_ASKS.map((ask) => (
                <Command.Item
                  key={ask.label}
                  value={`${ask.label} ${ask.prompt}`}
                  onSelect={() => go(`/chat?prompt=${encodeURIComponent(ask.prompt)}`)}
                  className="ui-command-item"
                >
                  <span className="ui-command-icon"><Sparkles size={15} aria-hidden="true" /></span>
                  <span className="ui-command-copy">
                    <span className="ui-command-label">{ask.label}</span>
                    <span className="ui-command-hint">{ask.prompt}</span>
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
          <div className="ui-command-footer">
            <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
            <span><Kbd>↵</Kbd> open</span>
            <span><Kbd>Esc</Kbd> close</span>
            <span className="ui-command-footer-brand">Chaste <strong>BusinessOS</strong></span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
