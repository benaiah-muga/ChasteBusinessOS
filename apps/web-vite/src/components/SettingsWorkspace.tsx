import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import "./SettingsWorkspace.css";

export type SettingsNavItem = {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  href?: string;
  external?: boolean;
  onSelect?: () => void;
};

export type SettingsNavGroup = {
  label: string;
  items: SettingsNavItem[];
};

/**
 * The shared settings anatomy: a quiet section index beside one focused
 * configuration column. Apps reuse it instead of inventing a second settings
 * chrome, and the shell keeps the active section and page header in one place.
 */
export function SettingsWorkspace({
  eyebrow,
  title,
  lede,
  status,
  statusInline = false,
  groups,
  activeId,
  note,
  embedded = false,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  status?: ReactNode;
  statusInline?: boolean;
  groups: SettingsNavGroup[];
  activeId: string;
  note?: ReactNode;
  embedded?: boolean;
  children: ReactNode;
}) {
  const entries = groups.flatMap((group, groupIndex) =>
    group.items.map((item) => ({ group: group.label, groupIndex, item })),
  );
  const active = entries.find((entry) => entry.item.id === activeId);
  const ActiveIcon = active?.item.icon;
  const activeAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const activeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const target = activeAnchorRef.current ?? activeButtonRef.current;
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [activeId]);

  return (
    <div
      className={`settings-workspace${embedded ? " is-embedded" : ""}`}
      role="region"
      aria-label={title}
    >
      <header className="settings-workspace-head">
        <p className="settings-workspace-eyebrow">{eyebrow}</p>
        <div className="settings-workspace-title-row">
          <h1 className="settings-workspace-title">{title}</h1>
          {status && statusInline && (
            <div className="settings-workspace-status is-inline">{status}</div>
          )}
        </div>
        {lede && <p className="settings-workspace-lede">{lede}</p>}
        {status && !statusInline && (
          <div className="settings-workspace-status">{status}</div>
        )}
      </header>

      <div className="settings-workspace-grid">
        <aside
          className="settings-workspace-nav"
          aria-label="Settings sections"
        >
          {groups.map((group, groupIndex) => (
            <div
              className="settings-nav-group"
              key={group.label}
              data-tone={groupIndex % 3}
            >
              <p className="settings-nav-group-label">{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const activeItem = item.id === activeId;
                const body = (
                  <>
                    <span className="settings-nav-icon" aria-hidden="true">
                      <Icon size={15} />
                    </span>
                    <span className="settings-nav-copy">
                      <strong>{item.label}</strong>
                      {item.description && <small>{item.description}</small>}
                    </span>
                  </>
                );
                if (item.href) {
                  return (
                    <a
                      key={item.id}
                      ref={activeItem ? activeAnchorRef : undefined}
                      href={item.href}
                      className="settings-nav-item"
                      aria-label={item.label}
                      aria-current={activeItem ? "page" : undefined}
                      title={item.description}
                      target={item.external ? "_blank" : undefined}
                      rel={item.external ? "noreferrer" : undefined}
                      onClick={(event) => {
                        if (item.external) return;
                        event.preventDefault();
                        item.onSelect?.();
                      }}
                    >
                      {body}
                    </a>
                  );
                }
                return (
                  <button
                    key={item.id}
                    ref={activeItem ? activeButtonRef : undefined}
                    type="button"
                    className="settings-nav-item"
                    aria-label={item.label}
                    aria-current={activeItem ? "page" : undefined}
                    title={item.description}
                    onClick={() => item.onSelect?.()}
                  >
                    {body}
                  </button>
                );
              })}
            </div>
          ))}
          {note && <div className="settings-nav-note">{note}</div>}
        </aside>

        <section
          className="settings-workspace-content"
          aria-labelledby="settings-section-title"
          data-tone={active ? active.groupIndex % 3 : 0}
        >
          {active && (
            <header className="settings-content-head">
              <div className="settings-content-heading">
                {ActiveIcon && (
                  <span className="settings-content-icon" aria-hidden="true">
                    <ActiveIcon size={17} />
                  </span>
                )}
                <div>
                  <p className="settings-content-eyebrow">{active.group}</p>
                  <h2 id="settings-section-title">{active.item.label}</h2>
                  {active.item.description && (
                    <p className="settings-content-description">
                      {active.item.description}
                    </p>
                  )}
                </div>
              </div>
            </header>
          )}
          {children}
        </section>
      </div>
    </div>
  );
}
