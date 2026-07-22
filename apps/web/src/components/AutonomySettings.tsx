"use client";

import { useState } from "react";
import { getApiClient } from "@/lib/api";

const levels = ["recommend", "confirm", "guarded_auto", "full_autonomous"] as const;
const levelLabel: Record<(typeof levels)[number], string> = {
  recommend: "Assist (recommend only)",
  confirm: "Confirm each action",
  guarded_auto: "Supervised auto",
  full_autonomous: "Full auto",
};
const levelDescription: Record<(typeof levels)[number], string> = {
  recommend: "The assistant suggests actions. You perform every step manually.",
  confirm: "The assistant performs actions only after you approve each one.",
  guarded_auto: "The assistant performs routine actions automatically and asks before risky ones.",
  full_autonomous: "The assistant runs autonomously. Use with caution.",
};

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
      const label = levelLabel[autonomy as (typeof levels)[number]] ?? autonomy;
      setMessage(res.warning ? `Saved: ${label}. Note: ${res.warning}` : `Saved: ${label}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 8 }}>
        {levels.map((l) => {
          const disabled = l === "full_autonomous" && !allowFull;
          const selected = autonomy === l;
          return (
            <button
              key={l}
              type="button"
              className={`accent-menu-item${selected ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => setAutonomy(l)}
              style={{ gridTemplateColumns: "22px 1fr", textAlign: "left", cursor: disabled ? "not-allowed" : "pointer" }}
              title={disabled ? "Full auto is not enabled for this workspace" : undefined}
            >
              <span className="accent-menu-swatch" style={{ "--swatch-color": "var(--accent)" } as React.CSSProperties} />
              <span>
                <div style={{ fontWeight: 700, color: "var(--ink)" }}>{levelLabel[l]}</div>
                <div className="muted" style={{ fontSize: "0.8rem" }}>{levelDescription[l]}</div>
              </span>
            </button>
          );
        })}
      </div>
      {autonomy === "full_autonomous" ? (
        <>
          <p className="error" style={{ whiteSpace: "pre-wrap" }}>
            {warning}
          </p>
          <label style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
            acknowledge responsibility for running in full auto mode
          </label>
        </>
      ) : null}
      <button className="btn" type="button" disabled={busy} onClick={save}>
        Save preference
      </button>
      {message ? <p className="muted">{message}</p> : null}
    </div>
  );
}
