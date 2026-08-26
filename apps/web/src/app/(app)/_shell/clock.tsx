"use client";

import { useEffect, useState } from "react";

/**
 * A quiet live clock for the workspace chrome. Tabular digits so the minute
 * tick never shifts layout; the date surfaces as the tooltip.
 */
export function DigitalClock({ className }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Rendered empty on the server and first client paint; the tick fills it in.
  // Avoids hydration mismatches across timezones.
  if (!now) return <span className={className} aria-hidden="true" />;

  const hhmm = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const ss = String(now.getSeconds()).padStart(2, "0");

  return (
    <time dateTime={now.toISOString()} title={now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })} className={className}>
      {hhmm}
      <span className="text-stone-400">:{ss}</span>
    </time>
  );
}
