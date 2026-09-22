"use client";

import { useEffect } from "react";

/** Opens the print dialog once the branded layout has painted. */
export function AutoPrint() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, []);
  return null;
}
