"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, Lightbulb } from "lucide-react";
import { MarketplaceWorkspace, type MarketplaceItem } from "@/components/marketplace/MarketplaceWorkspace";
import { GapsPanel } from "@/components/extensions/GapsPanel";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";

const TABS = ["marketplace", "gaps"] as const;
type TabId = (typeof TABS)[number];

function readTab(params: URLSearchParams): TabId {
  const t = params.get("tab");
  return (TABS as readonly string[]).includes(t ?? "") ? (t as TabId) : "marketplace";
}

export function ExtensionsHub({
  items,
  platformRegions,
}: {
  items: MarketplaceItem[];
  platformRegions: string[];
}) {
  const params = useSearchParams();
  const router = useRouter();
  const tab = readTab(params);

  function onValueChange(v: string) {
    const sp = new URLSearchParams(params.toString());
    sp.set("tab", v);
    router.replace(`?${sp.toString()}`, { scroll: false });
  }

  return (
    <Tabs value={tab} onValueChange={onValueChange} defaultValue="marketplace">
      <Tab value="marketplace" label="Marketplace" icon={Boxes} />
      <Tab value="gaps" label="Capability gaps" icon={Lightbulb} />

      <TabPanel value="marketplace">
        <MarketplaceWorkspace initialItems={items} platformRegions={platformRegions} />
      </TabPanel>
      <TabPanel value="gaps">
        <GapsPanel />
      </TabPanel>
    </Tabs>
  );
}
