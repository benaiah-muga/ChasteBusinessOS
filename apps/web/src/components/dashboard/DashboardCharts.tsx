"use client";

import { AreaSeries, BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";

type Props = {
  customersByMonth: { month: string; signups: number }[];
  modulesByState: { name: string; value: number }[];
  activityByDay: { day: string; events: number }[];
};

export function DashboardCharts({ customersByMonth, modulesByState, activityByDay }: Props) {
  return (
    <div className="stack">
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
        <ChartCard title="Customer growth" subtitle="New customers by month">
          <AreaSeries
            data={customersByMonth}
            xKey="month"
            keys={[{ key: "signups", label: "New customers" }]}
          />
        </ChartCard>
        <ChartCard title="Module status" subtitle="Installed workspace apps">
          <DonutChart data={modulesByState.length ? modulesByState : [{ name: "None", value: 1 }]} />
        </ChartCard>
      </div>
      <ChartCard title="Activity volume" subtitle="Audit events by day" height={240}>
        <BarSeries
          data={activityByDay.length ? activityByDay : [{ day: "Today", events: 0 }]}
          xKey="day"
          keys={[{ key: "events", label: "Events" }]}
        />
      </ChartCard>
    </div>
  );
}
