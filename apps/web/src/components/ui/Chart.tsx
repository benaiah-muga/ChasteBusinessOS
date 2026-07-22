"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useId } from "react";

type Series = { name: string; data: Record<string, number | string> }[] | Record<string, number | string>[];

export function ChartCard({
  title,
  subtitle,
  height = 260,
  children,
}: {
  title: string;
  subtitle?: string;
  height?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="card stack">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>
      </div>
      <div className="chart-wrap" style={{ height }}>
        {children}
      </div>
    </section>
  );
}

function useAccent(): string {
  const id = useId();
  if (typeof document !== "undefined") {
    const c = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    if (c) return c;
  }
  return "#7a1f2b";
}

const PALETTE = ["#7a1f2b", "#0f8c86", "#2563eb", "#7c3aed", "#e11d48", "#c27803", "#2f6b4a", "#475569"];

export function BarSeries({
  data,
  keys,
  xKey,
  stacked = false,
}: {
  data: Record<string, unknown>[];
  keys: { key: string; label?: string; color?: string }[];
  xKey: string;
  stacked?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis dataKey={xKey} stroke="var(--muted)" fontSize={12} tickLine={false} axisLine={false} />
        <YAxis stroke="var(--muted)" fontSize={12} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "8px",
            fontSize: "0.84rem",
            boxShadow: "var(--shadow-pop)",
          }}
          labelStyle={{ color: "var(--ink)", fontWeight: 600 }}
        />
        <Legend wrapperStyle={{ fontSize: "0.8rem" }} />
        {keys.map((k, i) => (
          <Bar
            key={k.key}
            dataKey={k.key}
            name={k.label ?? k.key}
            stackId={stacked ? "a" : undefined}
            fill={k.color ?? PALETTE[i % PALETTE.length]}
            radius={stacked ? 0 : 4}
            maxBarSize={48}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function LineSeries({
  data,
  keys,
  xKey,
}: {
  data: Record<string, unknown>[];
  keys: { key: string; label?: string; color?: string }[];
  xKey: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis dataKey={xKey} stroke="var(--muted)" fontSize={12} tickLine={false} axisLine={false} />
        <YAxis stroke="var(--muted)" fontSize={12} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "8px",
            fontSize: "0.84rem",
            boxShadow: "var(--shadow-pop)",
          }}
          labelStyle={{ color: "var(--ink)", fontWeight: 600 }}
        />
        <Legend wrapperStyle={{ fontSize: "0.8rem" }} />
        {keys.map((k, i) => (
          <Line
            key={k.key}
            type="monotone"
            dataKey={k.key}
            name={k.label ?? k.key}
            stroke={k.color ?? PALETTE[i % PALETTE.length]}
            strokeWidth={2.5}
            dot={{ r: 3, fill: k.color ?? PALETTE[i % PALETTE.length] }}
            activeDot={{ r: 5 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function AreaSeries({
  data,
  keys,
  xKey,
}: {
  data: Record<string, unknown>[];
  keys: { key: string; label?: string; color?: string }[];
  xKey: string;
}) {
  const accent = useAccent();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <defs>
          {keys.map((k, i) => {
            const c = k.color ?? (i === 0 ? accent : PALETTE[i % PALETTE.length]);
            return (
              <linearGradient key={k.key} id={`grad-${k.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c} stopOpacity={0.35} />
                <stop offset="100%" stopColor={c} stopOpacity={0.02} />
              </linearGradient>
            );
          })}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis dataKey={xKey} stroke="var(--muted)" fontSize={12} tickLine={false} axisLine={false} />
        <YAxis stroke="var(--muted)" fontSize={12} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "8px",
            fontSize: "0.84rem",
            boxShadow: "var(--shadow-pop)",
          }}
          labelStyle={{ color: "var(--ink)", fontWeight: 600 }}
        />
        <Legend wrapperStyle={{ fontSize: "0.8rem" }} />
        {keys.map((k, i) => (
          <Area
            key={k.key}
            type="monotone"
            dataKey={k.key}
            name={k.label ?? k.key}
            stroke={k.color ?? (i === 0 ? accent : PALETTE[i % PALETTE.length])}
            strokeWidth={2.5}
            fill={`url(#grad-${k.key})`}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({
  data,
  nameKey = "name",
  valueKey = "value",
}: {
  data: Record<string, unknown>[];
  nameKey?: string;
  valueKey?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "8px",
            fontSize: "0.84rem",
            boxShadow: "var(--shadow-pop)",
          }}
          labelStyle={{ color: "var(--ink)", fontWeight: 600 }}
        />
        <Legend wrapperStyle={{ fontSize: "0.8rem" }} />
        <Pie
          data={data}
          dataKey={valueKey}
          nameKey={nameKey}
          innerRadius="55%"
          outerRadius="85%"
          paddingAngle={2}
          stroke="var(--surface)"
          strokeWidth={2}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

export { PALETTE };
