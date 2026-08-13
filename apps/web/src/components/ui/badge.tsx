"use client";

import { type ReactNode, forwardRef, type HTMLAttributes } from "react";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "success" | "warning" | "danger" | "info" | "accent";
  size?: "sm" | "md";
  dot?: boolean;
}

const variants = {
  default: "bg-[var(--bg-subtle)] text-[var(--text-secondary)] border-[var(--border-default)]",
  success: "bg-[var(--success-soft)] text-[var(--success-primary)] border-[var(--success-muted)]",
  warning: "bg-[var(--warning-soft)] text-[var(--warning-primary)] border-[var(--warning-muted)]",
  danger: "bg-[var(--danger-soft)] text-[var(--danger-primary)] border-[var(--danger-muted)]",
  info: "bg-[var(--info-soft)] text-[var(--info-primary)] border-[var(--info-muted)]",
  accent: "bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] border-[var(--accent-primary-muted)]",
};

const sizes = {
  sm: "h-5 px-2 text-xs gap-1",
  md: "h-6 px-2.5 text-sm gap-1.5",
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  (
    {
      children,
      variant = "default",
      size = "md",
      dot = false,
      className = "",
      ...props
    },
    ref
  ) => {
    const baseStyles = "inline-flex items-center font-medium border rounded-full transition-colors duration-150";
    
    const classes = [
      baseStyles,
      variants[variant],
      sizes[size],
      className,
    ].filter(Boolean).join(" ");
    
    return (
      <span ref={ref} className={classes} {...props}>
        {dot && (
          <span 
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ 
              backgroundColor: variant === "success" ? "var(--success-primary)" 
                : variant === "warning" ? "var(--warning-primary)"
                : variant === "danger" ? "var(--danger-primary)"
                : variant === "info" ? "var(--info-primary)"
                : variant === "accent" ? "var(--accent-primary)"
                : "var(--text-tertiary)"
            }} 
          />
        )}
        {children}
      </span>
    );
  }
);

Badge.displayName = "Badge";
