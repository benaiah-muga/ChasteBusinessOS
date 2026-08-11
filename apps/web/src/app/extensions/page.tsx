import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { ExtensionsHub } from "@/components/extensions/ExtensionsHub";
import { type MarketplaceItem } from "@/components/marketplace/MarketplaceWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ExtensionsPage() {
  const api = getApiClient();
  let items: MarketplaceItem[] = [];
  let platformRegions: string[] = [];
  try {
    const data = (await api.getMarketplace()) as {
      items: MarketplaceItem[];
      platformRegions?: string[];
    };
    items = (data.items ?? []).filter((i) => !i.archived);
    platformRegions = data.platformRegions ?? [];
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Browse and install business modules, or file a gap the platform can close.">
      <Suspense fallback={<div className="card">Loading extensions…</div>}>
        <ExtensionsHub items={items} platformRegions={platformRegions} />
      </Suspense>
    </AppShell>
  );
}
