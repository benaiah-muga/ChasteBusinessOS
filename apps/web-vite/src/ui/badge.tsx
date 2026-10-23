import type { HTMLAttributes } from "react";
import { cn } from "./cn";

type Tone = "neutral" | "gold" | "success" | "danger" | "warning" | "info" | "ink";

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn("ui-badge", `ui-badge-${tone}`, className)} {...props} />;
}

export function Dot({ tone = "neutral", className }: { tone?: Tone; className?: string }) {
  return <span aria-hidden="true" className={cn("ui-dot", `ui-dot-${tone}`, className)} />;
}
