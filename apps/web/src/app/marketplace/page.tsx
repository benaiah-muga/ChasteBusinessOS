import { AppShell } from "@/components/AppShell";
import {
  MarketplaceWorkspace,
  type MarketplaceItem,
} from "@/components/marketplace/MarketplaceWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
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
    <AppShell subtitle="Browse, install, and manage business modules for this workspace.">
      <MarketplaceWorkspace initialItems={items} platformRegions={platformRegions} />
    </AppShell>
  );
}
