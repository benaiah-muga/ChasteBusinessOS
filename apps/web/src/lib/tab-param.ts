"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export function useTabParam<T extends string>(tabs: readonly T[], fallback: T) {
  const searchParams = useSearchParams();
  const requested = searchParams.get("tab");
  const resolved = requested && tabs.includes(requested as T) ? (requested as T) : fallback;
  const [tab, setTab] = useState<T>(resolved);

  useEffect(() => {
    setTab(resolved);
  }, [resolved]);

  return [tab, setTab] as const;
}
