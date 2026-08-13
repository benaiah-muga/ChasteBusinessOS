"use client";

import { type ReactNode, forwardRef, type HTMLAttributes } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "elevated" | "interactive";
  padding?: "none" | "sm" | "md" | "lg";
  hoverable?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      children,
      variant = "default",
      padding = "md",
      hoverable = false,
      className = "",
      ...props
    },
    ref
  ) => {
    const baseStyles = "bg-[var(--surface)] border border-[var(--border-default)] rounded-xl transition-all duration-200";
    
    const variants = {
      default: "shadow-sm",
      elevated: "shadow-md bg-[var(--surface-elevated)]",
      interactive: "shadow-sm hover:shadow-lg hover:border-[var(--border-strong)] cursor-pointer",
    };
    
    const paddings = {
      none: "",
      sm: "p-4",
      md: "p-5",
      lg: "p-6",
    };
    
    const classes = [
      baseStyles,
      variants[variant],
      paddings[padding],
      hoverable ? "hover:-translate-y-0.5" : "",
      className,
    ].filter(Boolean).join(" ");
    
    return (
      <div ref={ref} className={classes} {...props}>
        {children}
      </div>
    );
  }
);

Card.displayName = "Card";

export function CardHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-start justify-between gap-4 mb-4 ${className}`}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div>
      <h3 className={`text-base font-semibold text-[var(--text-primary)] ${className}`}>{children}</h3>
    </div>
  );
}

export function CardDescription({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-sm text-[var(--text-secondary)] mt-1 ${className}`}>{children}</p>
  );
}

export function CardContent({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

export function CardFooter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-3 pt-4 mt-4 border-t border-[var(--border-subtle)] ${className}`}>
      {children}
    </div>
  );
}
