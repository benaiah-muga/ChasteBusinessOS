import type { ReactNode } from "react";
import { cn } from "./cn";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("ui-page-header", className)}>
      <div className="ui-page-header-copy">
        {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="ui-page-description">{description}</p>}
        {meta && <div className="ui-page-meta">{meta}</div>}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </header>
  );
}

export function SectionHeading({
  title,
  detail,
  action,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ui-section-heading", className)}>
      <div>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {action}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
