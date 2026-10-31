import { BrandMark } from "./brand-mark";
import { cn } from "./cn";

export function BrandLoader({
  label = "Opening your workspace",
  detail,
  size = "md",
  full = false,
}: {
  label?: string;
  detail?: string;
  size?: "sm" | "md" | "lg";
  full?: boolean;
}) {
  return (
    <div className={cn("ui-loader", `ui-loader-${size}`, full && "ui-loader-full")} role="status" aria-live="polite">
      <span className="ui-loader-orbit" aria-hidden="true">
        <span className="ui-loader-ring" />
        <span className="ui-loader-ring ui-loader-ring-inner" />
        <BrandMark variant="gold" size={size === "lg" ? "lg" : size === "sm" ? "xs" : "sm"} />
        <span className="ui-loader-spark" />
      </span>
      <span className="ui-loader-copy">
        <span className="ui-loader-label">{label}</span>
        {detail && <span className="ui-loader-detail">{detail}</span>}
      </span>
    </div>
  );
}

export function InlineLoader({ label = "Working" }: { label?: string }) {
  return (
    <span className="ui-inline-loader" role="status">
      <span className="ui-inline-loader-ring" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
