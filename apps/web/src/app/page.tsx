import { AppShell } from "@/components/AppShell";
import { CustomersPanel } from "@/components/CustomersPanel";
import { ChatWidget } from "@/components/ChatWidget";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const api = getApiClient();
  let sessionLabel = "API offline";
  let autonomy = "unknown";
  let modulesLabel = "—";
  let customers: Awaited<ReturnType<typeof api.listCustomers>>["items"] = [];
  let error: string | null = null;

  try {
    const [session, mods, cust] = await Promise.all([
      api.session(),
      api.listModules(),
      api.listCustomers(),
    ]);
    sessionLabel = `${session.displayName} · ${session.orgName ?? session.email}`;
    autonomy = session.autonomy;
    modulesLabel = mods.registered.map((m) => m.name).join(" · ");
    customers = cust.items;
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to reach API";
  }

  return (
    <AppShell>
      <div className="row" style={{ marginBottom: "1rem" }}>
        <span className="badge">{sessionLabel}</span>
        <span className="badge">Autonomy: {autonomy}</span>
        <span className="badge muted">Modules: {modulesLabel}</span>
      </div>

      {error ? (
        <div className="card error">
          Cannot reach API. Start with <span className="mono">pnpm --filter @chaste/api dev</span>.
          ({error})
        </div>
      ) : (
        <div className="grid">
          <CustomersPanel initialCustomers={customers} />
          <ChatWidget />
        </div>
      )}
    </AppShell>
  );
}
