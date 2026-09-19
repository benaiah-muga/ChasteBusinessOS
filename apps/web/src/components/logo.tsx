import Image from "next/image";
import { cn } from "@/lib/format";

/**
 * The Chaste emblem: the brand's knot-and-mark coin, cropped circular.
 * Reads as a stamped coin on the inked band and as a seal on paper surfaces.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/chaste-logo.jpg"
      alt=""
      width={size}
      height={size}
      priority={false}
      className={cn("shrink-0 rounded-full border border-stone-950/15 object-cover", className)}
      style={{ width: size, height: size }}
    />
  );
}
