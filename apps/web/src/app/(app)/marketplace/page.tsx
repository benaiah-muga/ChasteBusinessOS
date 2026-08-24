"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  LoadingPage,
  type ActionNoticeState,
  PageHeader,
} from "@/components/ui";
import { IconCart } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

interface Listing {
  id: string;
  slug: string;
  name: string;
  version: string;
  summary: string;
  status: string;
  capabilityIds: string[];
  installedHere: boolean;
}

export default function MarketplacePage() {
  const __enabled = useModuleEnabled("creator");
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await callApi<{ listings?: Listing[] }>("/api/marketplace");
    setListings(res.data?.listings ?? []);
    if (res.error) setNotice({ tone: "error", error: res.error });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function install(id: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/marketplace", { action: "install", listingId: id });
      if (res.status === 202) setNotice({ tone: "pending", text: "Install requires approval." });
      else if (!res.ok) if (res.error) setNotice({ tone: "error", error: res.error });
      else {
        setNotice({ tone: "success", text: "Plugin installed after signature re-verification." });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  if (!listings) return <LoadingPage />;

  if (!__enabled) return <ModuleDisabled label="Marketplace" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketplace"
        description="Community capability packages, every listing is cryptographically signed by its publisher and re-verified before install"
      />
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {listings.length === 0 ? (
        <Card>
          <EmptyState icon={<IconCart />} title="No published packages yet" hint="Publish one from Creator Mode with creator.publishListing." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {listings.map((l) => (
            <Card key={l.id}>
              <CardTitle
                right={
                  <Badge tone={l.installedHere ? "green" : l.status === "verified" ? "blue" : "amber"}>
                    {l.installedHere ? "installed" : l.status}
                  </Badge>
                }
              >
                {l.name}
              </CardTitle>
              <p className="text-sm opacity-70">{l.summary}</p>
              <p className="mt-1 font-mono text-xs opacity-60">
                {l.slug} v{l.version}
              </p>
              <p className="mt-1 text-xs opacity-60">Capabilities: {l.capabilityIds.join(", ")}</p>
              <div className="mt-3">
                {l.installedHere ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      await postApi("/api/marketplace", { action: "uninstall", listingId: l.id });
                      await load();
                    }}
                  >
                    Uninstall
                  </Button>
                ) : (
                  <Button size="sm" loading={busy} onClick={() => install(l.id)}>
                    Install (signature-checked)
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
