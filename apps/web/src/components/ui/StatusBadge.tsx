"use client";

const STAGE_COLORS: Record<string, string> = {
  lead: "#475569",
  prospect: "#2563eb",
  qualified: "#0f8c86",
  negotiable: "#c27803",
  won: "#15803d",
  active: "#15803d",
  churned: "#be123c",
  lost: "#be123c",
  deleted: "#64748b",
};

const HUMAN: Record<string, string> = {
  lead: "Lead",
  prospect: "Prospect",
  qualified: "Qualified",
  negotiable: "In negotiation",
  won: "Won",
  active: "Active",
  churned: "Churned",
  lost: "Lost",
  deleted: "Deleted",
};

export function StatusBadge({ status }: { status: string }) {
  const color = STAGE_COLORS[status] ?? "#475569";
  return (
    <span
      className="badge"
      style={{
        background: `${color}1f`,
        color,
        borderColor: `${color}55`,
      }}
    >
      {HUMAN[status] ?? status}
    </span>
  );
}
