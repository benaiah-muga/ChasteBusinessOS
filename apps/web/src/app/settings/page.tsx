import { AppShell } from "@/components/AppShell";
import { AutonomySettings } from "@/components/AutonomySettings";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const api = getApiClient();
  let session: Awaited<ReturnType<typeof api.session>> | null = null;
  try {
    session = await api.session();
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Organization settings — AI autonomy, region, providers">
      <div className="grid">
        <section className="card stack">
          <h2>Session</h2>
          {session ? (
            <ul>
              <li>
                Org: <strong>{session.orgName}</strong>
              </li>
              <li>
                Region: <span className="mono">{session.region}</span>
              </li>
              <li>
                AI provider: <span className="mono">{session.aiProvider}</span>
              </li>
              <li>
                Autonomy: <strong>{session.autonomy}</strong>
              </li>
              <li>
                Full auto allowed:{" "}
                {session.allowFullAutonomous ? "yes (platform)" : "no (platform flag)"}
              </li>
            </ul>
          ) : (
            <p className="error">API offline</p>
          )}
        </section>
        <section className="card stack">
          <h2>AI autonomy</h2>
          {session ? (
            <AutonomySettings
              current={session.autonomy}
              allowFull={Boolean(session.allowFullAutonomous)}
              warning={session.fullAutonomousWarning ?? ""}
            />
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
