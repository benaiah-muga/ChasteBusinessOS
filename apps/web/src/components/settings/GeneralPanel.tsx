"use client";

import { AutonomySettings } from "@/components/AutonomySettings";

export type SessionInfo = {
  orgName?: string;
  region?: string;
  aiProvider?: string;
  autonomy: string;
  allowFullAutonomous?: boolean;
  fullAutonomousWarning?: string;
};

export function GeneralPanel({ session }: { session: SessionInfo | null }) {
  return (
    <div className="grid">
      <section className="card stack">
        <h2>Workspace</h2>
        {session ? (
          <ul>
            <li>
              Name: <strong>{session.orgName}</strong>
            </li>
            <li>
              Region: <strong>{session.region ?? "local"}</strong>
            </li>
            <li>
              AI provider: <strong>{session.aiProvider ?? "not configured"}</strong>
            </li>
            <li>
              Autonomy: <strong>{session.autonomy}</strong>
            </li>
            <li>
              Full auto allowed: {session.allowFullAutonomous ? "yes" : "no"}
            </li>
          </ul>
        ) : (
          <p className="error">Service offline</p>
        )}
        <p className="muted">
          Theme and accent are controlled from the top bar and follow you across every page. Defaults are
          system theme and deep maroon.
        </p>
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
  );
}
