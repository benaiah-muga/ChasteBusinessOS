"use client";

import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";

type KpiProps = {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: number;
  trendSuffix?: string;
  hint?: string;
};

export function Kpi({ label, value, icon: Icon, trend, trendSuffix = "%", hint }: KpiProps) {
  const trendUp = typeof trend === "number" && trend >= 0;
  return (
    <div className="kpi">
      <div className="kpi-label">
        {Icon ? (
          <span className="kpi-icon">
            <Icon size={16} />
          </span>
        ) : null}
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      {typeof trend === "number" ? (
        <div className={`kpi-trend ${trendUp ? "up" : "down"}`}>
          {trendUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
          {Math.abs(trend)}
          {trendSuffix}
        </div>
      ) : hint ? (
        <div className="kpi-trend">{hint}</div>
      ) : null}
    </div>
  );
}
