import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
  let data: {
    items: {
      moduleId: string;
      name: string;
      version: string;
      summary: string;
      category: string;
      publisher: string;
      regions: string[];
    }[];
    platformRegions: string[];
  } = { items: [], platformRegions: [] };
  try {
    data = await apiFetch("/api/v1/marketplace");
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Module marketplace — installable capabilities by region">
      <p className="muted">Platform regions: {data.platformRegions.join(", ") || "local"}</p>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        {data.items.map((item) => (
          <section key={item.moduleId} className="card stack">
            <h2>{item.name}</h2>
            <div className="mono muted">
              {item.moduleId}@{item.version}
            </div>
            <p>{item.summary}</p>
            <div className="badge">{item.category}</div>
            <div className="muted">Publisher: {item.publisher}</div>
            <div className="muted">Regions: {(item.regions ?? []).join(", ")}</div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
