import { getApiClient } from "@/lib/api";
import { CustomersPanel } from "@/components/CustomersPanel";
import { ChatWidget } from "@/components/ChatWidget";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const api = getApiClient();
  let sessionLabel = "API offline";
  let autonomy = "unknown";
  let modules: { id: string; name: string; specialist?: { displayName: string } }[] = [];
  let customers: Awaited<ReturnType<typeof api.listCustomers>>["items"] = [];
  let error: string | null = null;

  try {
    const [session, mods, cust] = await Promise.all([
      api.session(),
      api.listModules(),
      api.listCustomers(),
    ]);
    sessionLabel = `${session.displayName} · ${session.email}`;
    autonomy = session.autonomy;
    modules = mods.items;
    customers = cust.items;
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to reach API";
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1 className="brand">ChasteBusinessOS</h1>
          <p className="tagline">
            AI-native business operations with the same command bus for humans and AI. This web app
            talks to the API over HTTP only — no kernel coupling.
          </p>
        </div>
        <div className="badge" title="Session from GET /api/v1/session">
          {sessionLabel}
        </div>
      </header>

      <nav className="nav">
        <span className="muted">Autonomy: <strong>{autonomy}</strong></span>
        <span className="muted">
          Modules:{" "}
          {modules.length
            ? modules.map((m) => m.specialist?.displayName ?? m.name).join(" · ")
            : "—"}
        </span>
      </nav>

      {error ? (
        <div className="card error">
          Cannot reach API at <span className="mono">{process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}</span>
          . Start with <span className="mono">pnpm --filter @chaste/api dev</span>. ({error})
        </div>
      ) : (
        <div className="grid">
          <CustomersPanel initialCustomers={customers} />
          <ChatWidget />
        </div>
      )}
    </main>
  );
}
