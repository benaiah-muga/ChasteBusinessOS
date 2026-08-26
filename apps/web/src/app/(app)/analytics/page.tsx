"use client";

import { useCallback, useEffect, useState } from "react";
import { ActionNotice, type ActionNoticeState, Button, EmptyState, LoadingPage } from "@/components/ui";
import { IconListTree } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

interface DatasetInfo {
  id: string;
  label: string;
  description: string;
}

interface Preview {
  columns: string[];
  rows: Record<string, unknown>[];
}

interface SectionDraft {
  datasetId: string;
  label: string;
  chartType: "none" | "bar" | "line" | "area" | "pie";
  x: string;
  y: string[];
}

interface ReportResult {
  region: string | null;
  html: string;
  sections: { heading: string; svg: string | null; columns: string[]; rows: Record<string, unknown>[] }[];
}

const NUMERIC_HINT = /minor|count|value/i;

export default function AnalyticsPage() {
  const __enabled = useModuleEnabled("analytics");
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [sections, setSections] = useState<SectionDraft[]>([]);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [title, setTitle] = useState("Business report");
  const [narrative, setNarrative] = useState("");
  const [report, setReport] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);

  const load = useCallback(async () => {
    const res = await callApi<{ datasets?: DatasetInfo[] }>("/api/analytics");
    if (res.ok) setDatasets(res.data?.datasets ?? []);
    else setDatasets([]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function preview(datasetId: string) {
    if (previews[datasetId]) return;
    const res = await callApi<Preview>(`/api/analytics?dataset=${encodeURIComponent(datasetId)}`);
    if (res.ok && res.data) {
      setPreviews((prev) => ({ ...prev, [datasetId]: res.data as Preview }));
      const info = datasets?.find((d) => d.id === datasetId);
      const cols = (res.data as Preview).columns;
      const numeric = cols.filter((c) => NUMERIC_HINT.test(c));
      const categoryCol = cols.find((c) => !numeric.includes(c)) ?? cols[0] ?? "";
      setSections((prev) => [
        ...prev,
        {
          datasetId,
          label: info?.label ?? datasetId,
          chartType: numeric.length ? "bar" : "none",
          x: categoryCol,
          y: numeric.slice(0, 1),
        },
      ]);
    } else if (res.error) {
      setNotice({ tone: "error", error: res.error });
    }
  }

  function updateSection(index: number, patch: Partial<SectionDraft>) {
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function generate() {
    if (!title.trim() || sections.length === 0) return;
    setBusy(true);
    try {
      const res = await postApi<ReportResult>("/api/analytics/report", {
        title: title.trim(),
        ...(narrative.trim() ? { narrative: narrative.trim() } : {}),
        sections: sections.map((s) => ({
          heading: s.label,
          datasetId: s.datasetId,
          params: {},
          ops: [],
          ...(s.chartType !== "none" && s.x && s.y.length
            ? { chart: { type: s.chartType, x: s.x, y: s.y } }
            : {}),
        })),
      });
      if (res.ok && res.data) setReport(res.data);
      else if (res.error) setNotice({ tone: "error", error: res.error });
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!report) return;
    const blob = new Blob([report.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.trim().replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "report"}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (datasets === null) return <LoadingPage />;
  if (!__enabled) return <ModuleDisabled label="Analytics" />;

  const numericColsOf = (datasetId: string) =>
    (previews[datasetId]?.columns ?? []).filter((c) => NUMERIC_HINT.test(c));
  const allColsOf = (datasetId: string) => previews[datasetId]?.columns ?? [];

  return (
    <AppFrame
      appId="analytics"
      description="Compose governed datasets into a report with charts and exact numbers. Your workmate can build the same reports from chat."
    >

      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {datasets.length === 0 ? (
        <EmptyState
          icon={<IconListTree />}
          title="No datasets available"
          hint="Your roles don't include read access to any analytics source yet. Ask an admin for CRM or accounting read permissions."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Report title"
              aria-label="Report title"
              className="input h-9 w-48"
            />
            <select
              aria-label="Add a dataset"
              className="input h-9 w-56"
              value=""
              onChange={(e) => e.target.value && void preview(e.target.value)}
            >
              <option value="">Add a dataset…</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            {sections.length > 0 && (
              <Button onClick={() => void generate()} loading={busy} disabled={!title.trim()}>
                Generate report
              </Button>
            )}
            {report && (
              <Button tone="secondary" onClick={download}>
                Download HTML
              </Button>
            )}
          </div>

          {sections.length > 0 && (
            <textarea
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="Optional narrative for the report header (or let your workmate draft it in chat)…"
              aria-label="Report narrative"
              rows={2}
              className="input mb-4 w-full max-w-xl resize-y"
            />
          )}

          {sections.length === 0 && (
            <EmptyState
              icon={<IconListTree />}
              title="Build your report"
              hint="Add one or more datasets above, pick a chart per section, then generate. Everything shown here respects your permissions."
            />
          )}

          {sections.map((s, i) => {
            const cols = allColsOf(s.datasetId);
            const nums = numericColsOf(s.datasetId);
            return (
              <div key={`${s.datasetId}-${i}`} className="mb-4 rounded-xl border border-stone-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-stone-800">{s.label}</span>
                  <select
                    aria-label={`Chart type for ${s.label}`}
                    className="input h-8 w-32 text-xs"
                    value={s.chartType}
                    onChange={(e) => updateSection(i, { chartType: e.target.value as SectionDraft["chartType"] })}
                  >
                    <option value="none">Table only</option>
                    <option value="bar">Bar</option>
                    <option value="line">Line</option>
                    <option value="area">Area</option>
                    <option value="pie">Pie</option>
                  </select>
                  {s.chartType !== "none" && cols.length > 0 && (
                    <>
                      <select
                        aria-label={`Category column for ${s.label}`}
                        className="input h-8 w-40 text-xs"
                        value={s.x}
                        onChange={(e) => updateSection(i, { x: e.target.value })}
                      >
                        {cols.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Value column for ${s.label}`}
                        className="input h-8 w-40 text-xs"
                        value={s.y[0] ?? ""}
                        onChange={(e) => updateSection(i, { y: e.target.value ? [e.target.value] : [] })}
                      >
                        <option value="">value…</option>
                        {(nums.length ? nums : cols).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setSections((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-auto cursor-pointer text-xs font-medium text-stone-400 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
                {previews[s.datasetId] && (
                  <p className="mt-2 text-xs text-stone-400">
                    {previews[s.datasetId]!.rows.length} row(s) · columns: {cols.join(", ")}
                  </p>
                )}
              </div>
            );
          })}

          {report && (
            <div className="mt-6 border-t border-stone-200 pt-6">
              <h2 className="mb-1 text-lg font-semibold text-stone-800">{title}</h2>
              {report.region && <p className="mb-4 text-xs text-stone-400">Data region: {report.region}</p>}
              {report.sections.map((sec) => (
                <section key={sec.heading} className="mb-8">
                  <h3 className="mb-2 text-sm font-semibold text-stone-700">{sec.heading}</h3>
                  {sec.svg && (
                    <div className="mb-3 [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: sec.svg }} />
                  )}
                  <div className="overflow-hidden rounded-lg border border-stone-200">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-stone-50/80 text-left text-stone-500">
                          {sec.columns.map((c) => (
                            <th key={c} className="px-3 py-2 font-medium">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sec.rows.map((r, ri) => (
                          <tr key={ri} className="border-t border-stone-100">
                            {sec.columns.map((c) => (
                              <td key={c} className="tnum px-3 py-1.5 text-stone-700">
                                {String(r[c] ?? "")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
              <p className="text-xs text-stone-400">
                Download the self-contained HTML file and print it to PDF from your browser.
              </p>
            </div>
          )}
        </>
      )}
    </AppFrame>
  );
}
