import { LogoMark } from "@/components/logo";
import { cn } from "@/lib/format";

/**
 * Route-loading state: the emblem spins like a struck coin while the next
 * page opens. `full` paints the whole canvas (top-level segments); the
 * compact form drops into the app shell so the rail and top bar stay put.
 */
export function BrandLoader({
  label = "Opening the books…",
  full = false,
  className,
}: {
  label?: string;
  full?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-4 bg-canvas",
        full ? "min-h-svh" : "min-h-[60vh]",
        className,
      )}
    >
      <LogoMark size={56} className="brand-loader__coin" />
      <p className="font-display text-sm text-ink-muted">{label}</p>
      <span className="sr-only">Loading</span>
    </div>
  );
}
