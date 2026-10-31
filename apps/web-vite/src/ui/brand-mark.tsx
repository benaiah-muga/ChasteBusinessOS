import { cn } from "./cn";

export function BrandMark({
  variant = "ink",
  size = "md",
  className,
  decorative = true,
}: {
  variant?: "ink" | "gold";
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
  decorative?: boolean;
}) {
  return (
    <span className={cn("ui-brand-mark", `ui-brand-mark-${size}`, `ui-brand-mark-${variant}`, className)}>
      <img
        src={variant === "gold" ? "/brand/chaste-mark-gold.png" : "/brand/chaste-mark.png"}
        alt={decorative ? "" : "Chaste BusinessOS"}
        draggable={false}
      />
    </span>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={cn("ui-wordmark", compact && "ui-wordmark-compact")}>
      <span className="ui-wordmark-chaste">Chaste</span>
      <span className="ui-wordmark-product">BusinessOS</span>
    </span>
  );
}
