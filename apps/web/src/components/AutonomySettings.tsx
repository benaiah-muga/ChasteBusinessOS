"use client";

import { useState } from "react";
import { getApiClient } from "@/lib/api";

const levels = ["recommend", "confirm", "guarded_auto", "full_autonomous"] as const;

export function AutonomySettings({
  current,
  allowFull,
  warning,
}: {
  current: string;
  allowFull: boolean;
  warning: string;
}) {
  const [autonomy, setAutonomy] = useState(current);
  const [ack, setAck] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const api = getApiClient();
      const res = (await api.setAutonomy({
        autonomy: autonomy as (typeof levels)[number],
        acknowledgeFullAutonomous: ack,
      })) as { autonomy?: string; warning?: string; message?: string };
      setMessage(
        res.warning
          ? `Saved: ${res.autonomy}. WARNING: ${res.warning}`
          : `Saved autonomy: ${res.autonomy ?? autonomy}`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <label>
        Level
        <select
          value={autonomy}
          onChange={(e) => setAutonomy(e.target.value)}
          style={{ padding: "0.5rem", borderRadius: 8 }}
        >
          {levels.map((l) => (
            <option key={l} value={l} disabled={l === "full_autonomous" && !allowFull}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {autonomy === "full_autonomous" ? (
        <>
          <p className="error" style={{ whiteSpace: "pre-wrap" }}>
            {warning}
          </p>
          <label style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
            acknowledge organizational responsibility for full autonomous mode
          </label>
        </>
      ) : null}
      <button className="btn" type="button" disabled={busy} onClick={save}>
        Save autonomy
      </button>
      {message ? <p className="muted">{message}</p> : null}
    </div>
  );
}
