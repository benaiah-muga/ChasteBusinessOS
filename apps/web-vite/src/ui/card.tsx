import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-card-header", className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-card-body", className)} {...props} />;
}

export function EmptyState({
  icon,
  title,
  detail,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ui-empty", className)}>
      {icon && <span className="ui-empty-icon" aria-hidden="true">{icon}</span>}
      <p className="ui-empty-title">{title}</p>
      {detail && <p className="ui-empty-detail">{detail}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
