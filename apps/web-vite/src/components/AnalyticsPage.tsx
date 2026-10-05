import { useCallback, useEffect, useRef, useState } from "react";
import {
  AnalyticsApiError,
  analyticsReportFilename,
  fetchAnalyticsDatasets,
  fetchAnalyticsEnabled,
  fetchAnalyticsPreview,
  generateAnalyticsReport,
  type AnalyticsChartType,
  type AnalyticsDataset,
  type AnalyticsPreview,
  type AnalyticsReport,
} from "../api/analytics";
import "./AnalyticsPage.css";

interface SectionDraft {
  datasetId: string;
  label: string;
  chartType: "none" | AnalyticsChartType;
  x: string;
  y: string[];
}

type WorkspaceState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "disabled" }
  | { status: "ready"; datasets: AnalyticsDataset[] };

const NUMERIC_HINT = /minor|count|value/i;
const MAX_REPORT_SECTIONS = 8;

function errorMessage(error: unknown): string {
  if (error instanceof AnalyticsApiError) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "The analytics service took too long to respond. Try again.";
  return "Could not reach the analytics service. Check your connection and try again.";
}

export function AnalyticsPage() {
  const [workspace, setWorkspace] = useState<WorkspaceState>({ status: "loading" });
  const [sections, setSections] = useState<SectionDraft[]>([]);
  const [previews, setPreviews] = useState<Record<string, AnalyticsPreview>>({});
  const [previewLoading, setPreviewLoading] = useState<Set<string>>(() => new Set());
  const [title, setTitle] = useState("Business report");
  const [narrative, setNarrative] = useState("");
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [reportTitle, setReportTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const workspaceController = useRef<AbortController | null>(null);
  const previewControllers = useRef(new Map<string, AbortController>());
  const generationController = useRef<AbortController | null>(null);
  const generationInFlight = useRef(false);

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setWorkspace({ status: "loading" });
    try {
      const enabled = await fetchAnalyticsEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setWorkspace({ status: "disabled" });
        return;
      }
      const datasets = await fetchAnalyticsDatasets(signal);
      if (!signal?.aborted) setWorkspace({ status: "ready", datasets });
    } catch (error) {
      if (signal?.aborted) return;
      setWorkspace({ status: "failed", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    workspaceController.current = controller;
    void loadWorkspace(controller.signal);
    return () => {
      mounted.current = false;
      workspaceController.current?.abort();
      workspaceController.current = null;
      for (const pending of previewControllers.current.values()) pending.abort();
      previewControllers.current.clear();
      generationController.current?.abort();
      generationController.current = null;
    };
  }, [loadWorkspace]);

  async function addDataset(datasetId: string): Promise<void> {
    if (!datasetId || workspace.status !== "ready" || previews[datasetId] || previewControllers.current.has(datasetId)) return;
    if (sections.length + previewControllers.current.size >= MAX_REPORT_SECTIONS) {
      setNotice(`Reports can include up to ${MAX_REPORT_SECTIONS} sections.`);
      return;
    }
    const controller = new AbortController();
    previewControllers.current.set(datasetId, controller);
    setNotice(null);
    setPreviewLoading((current) => new Set(current).add(datasetId));
    try {
      const preview = await fetchAnalyticsPreview(datasetId, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setPreviews((current) => ({ ...current, [datasetId]: preview }));
      const info = workspace.datasets.find((dataset) => dataset.id === datasetId);
      const numeric = preview.columns.filter((column) => NUMERIC_HINT.test(column));
      const category = preview.columns.find((column) => !numeric.includes(column)) ?? preview.columns[0] ?? "";
      setSections((current) => [...current, {
        datasetId,
        label: info?.label ?? datasetId,
        chartType: numeric.length ? "bar" : "none",
        x: category,
        y: numeric.slice(0, 1),
      }]);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setNotice(errorMessage(error));
    } finally {
      if (previewControllers.current.get(datasetId) === controller) {
        previewControllers.current.delete(datasetId);
        if (mounted.current) {
          setPreviewLoading((current) => {
            const next = new Set(current);
            next.delete(datasetId);
            return next;
          });
        }
      }
    }
  }

  async function generate(): Promise<void> {
    if (generationInFlight.current || !title.trim() || sections.length === 0) return;
    generationInFlight.current = true;
    const controller = new AbortController();
    generationController.current = controller;
    setBusy(true);
    setNotice(null);
    try {
      const result = await generateAnalyticsReport({
        title: title.trim(),
        ...(narrative.trim() ? { narrative: narrative.trim() } : {}),
        sections: sections.map((section) => ({
          heading: section.label,
          datasetId: section.datasetId,
          params: {},
          ops: [],
          ...(section.chartType !== "none" && section.x && section.y.length
            ? { chart: { type: section.chartType, x: section.x, y: section.y } }
            : {}),
        })),
      }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setReport(result);
      setReportTitle(title.trim());
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setNotice(errorMessage(error));
    } finally {
      if (generationController.current === controller) {
        generationController.current = null;
        generationInFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  function download(): void {
    if (!report) return;
    const blob = new Blob([report.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = analyticsReportFilename(reportTitle ?? title);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function updateSection(index: number, patch: Partial<SectionDraft>): void {
    setSections((current) => current.map((section, sectionIndex) => sectionIndex === index
      ? { ...section, ...patch }
      : section));
  }

  if (workspace.status === "loading") {
    return <main className="analytics-page"><p className="analytics-loading" role="status">Checking analytics availability…</p></main>;
  }
  if (workspace.status === "failed") {
    return (
      <main className="analytics-page">
        <section className="analytics-error" role="alert" aria-labelledby="analytics-load-error-title">
          <div>
            <p className="analytics-eyebrow">Analytics unavailable</p>
            <h1 id="analytics-load-error-title">Could not load analytics</h1>
            <p>{workspace.message}</p>
          </div>
          <button
            className="analytics-secondary-button"
            type="button"
            onClick={() => {
              const controller = new AbortController();
              workspaceController.current?.abort();
              workspaceController.current = controller;
              void loadWorkspace(controller.signal);
            }}
          >
            Try again
          </button>
        </section>
      </main>
    );
  }
  if (workspace.status === "disabled") {
    return (
      <main className="analytics-page">
        <section className="analytics-disabled" aria-labelledby="analytics-disabled-title">
          <span aria-hidden="true">!</span>
          <h1 id="analytics-disabled-title">Analytics is disabled</h1>
          <p>This module is switched off for your organization. An org admin can re-enable it under Team &amp; roles → Modules.</p>
        </section>
      </main>
    );
  }

  const numericColumns = (datasetId: string) => (previews[datasetId]?.columns ?? []).filter((column) => NUMERIC_HINT.test(column));
  const allColumns = (datasetId: string) => previews[datasetId]?.columns ?? [];
  const reportSectionLimitReached = sections.length + previewLoading.size >= MAX_REPORT_SECTIONS;

  return (
    <main className="analytics-page">
      <header className="analytics-page-header">
        <div>
          <p className="analytics-eyebrow">Intelligence</p>
          <h1>Analytics</h1>
          <p>Compose governed datasets into a report with charts and exact numbers. Your workmate can build the same reports from chat.</p>
        </div>
      </header>

      {notice && (
        <div className="analytics-notice" role="alert">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss analytics error" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {workspace.datasets.length === 0 ? (
        <section className="analytics-empty" aria-labelledby="analytics-no-datasets-title">
          <span aria-hidden="true">≋</span>
          <h2 id="analytics-no-datasets-title">No datasets available</h2>
          <p>Your roles don’t include read access to any analytics source yet. Ask an admin for CRM or accounting read permissions.</p>
        </section>
      ) : (
        <>
          <section className="analytics-composer" aria-label="Report settings">
            <div className="analytics-controls">
              <label className="analytics-field analytics-title-field">
                <span>Report title</span>
                <input
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="Report title"
                />
              </label>
              <label className="analytics-field analytics-dataset-field">
                <span id="analytics-dataset-label">Add a dataset</span>
                <select
                  value=""
                  onChange={(event) => void addDataset(event.currentTarget.value)}
                  aria-labelledby="analytics-dataset-label"
                  aria-describedby="analytics-dataset-hint"
                  disabled={reportSectionLimitReached}
                >
                  <option value="">Choose a permission-filtered dataset…</option>
                  {workspace.datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id} disabled={previewLoading.has(dataset.id)}>
                      {previewLoading.has(dataset.id) ? `Loading ${dataset.label}…` : dataset.label}
                    </option>
                  ))}
                </select>
                <span id="analytics-dataset-hint" className="analytics-field-hint">
                  {reportSectionLimitReached
                    ? `Reports are limited to ${MAX_REPORT_SECTIONS} sections.`
                    : "Only datasets permitted for your role are listed."}
                </span>
              </label>
              {sections.length > 0 && (
                <button
                  className="analytics-primary-button"
                  type="button"
                  onClick={() => void generate()}
                  disabled={busy || !title.trim()}
                  aria-busy={busy}
                >
                  {busy ? "Generating report…" : "Generate report"}
                </button>
              )}
              {report && (
                <button className="analytics-secondary-button" type="button" onClick={download}>
                  Download HTML
                </button>
              )}
            </div>
            <p className="analytics-composer-note">Each preview and report section follows the same governed, permission-checked data path as the rest of the workspace.</p>
          </section>

          {sections.length > 0 && (
            <label className="analytics-field analytics-narrative-field">
              <span>Report narrative <small>Optional</small></span>
              <textarea
                value={narrative}
                maxLength={6000}
                onChange={(event) => setNarrative(event.currentTarget.value)}
                placeholder="Add context for the report header, or let your workmate draft it in chat."
                rows={3}
              />
            </label>
          )}

          {sections.length === 0 && (
            <section className="analytics-empty analytics-empty-builder" aria-labelledby="analytics-build-title">
              <span aria-hidden="true">▤</span>
              <h2 id="analytics-build-title">Build your report</h2>
              <p>Add one or more datasets, choose a chart for each section, then generate. Every value shown here respects your permissions.</p>
            </section>
          )}

          <div className="analytics-sections" aria-label="Report sections">
            {sections.map((section, index) => {
              const columns = allColumns(section.datasetId);
              const numeric = numericColumns(section.datasetId);
              const preview = previews[section.datasetId];
              return (
                <section className="analytics-section-card" key={`${section.datasetId}-${index}`} aria-labelledby={`analytics-section-${index}-title`}>
                  <div className="analytics-section-heading">
                    <div>
                      <p className="analytics-section-kicker">Report section {index + 1}</p>
                      <h2 id={`analytics-section-${index}-title`}>{section.label}</h2>
                    </div>
                    <button
                      className="analytics-remove-button"
                      type="button"
                      onClick={() => setSections((current) => current.filter((_, sectionIndex) => sectionIndex !== index))}
                      aria-label={`Remove ${section.label} section`}
                    >
                      Remove section
                    </button>
                  </div>
                  <div className="analytics-chart-controls">
                    <label className="analytics-field">
                      <span>Chart type</span>
                      <select
                        value={section.chartType}
                        onChange={(event) => updateSection(index, { chartType: event.currentTarget.value as SectionDraft["chartType"] })}
                      >
                        <option value="none">Table only</option>
                        <option value="bar">Bar</option>
                        <option value="line">Line</option>
                        <option value="area">Area</option>
                        <option value="pie">Pie</option>
                      </select>
                    </label>
                    {section.chartType !== "none" && columns.length > 0 && (
                      <>
                        <label className="analytics-field">
                          <span>Category column</span>
                          <select value={section.x} onChange={(event) => updateSection(index, { x: event.currentTarget.value })}>
                            {columns.map((column) => <option key={column} value={column}>{column}</option>)}
                          </select>
                        </label>
                        <label className="analytics-field">
                          <span>Value column</span>
                          <select
                            value={section.y[0] ?? ""}
                            onChange={(event) => updateSection(index, { y: event.currentTarget.value ? [event.currentTarget.value] : [] })}
                          >
                            <option value="">Choose a value…</option>
                            {(numeric.length ? numeric : columns).map((column) => <option key={column} value={column}>{column}</option>)}
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                  {preview && (
                    <p className="analytics-preview-meta" role="status">
                      Preview loaded: {preview.rows.length} row{preview.rows.length === 1 ? "" : "s"} · {columns.join(", ")}
                    </p>
                  )}
                </section>
              );
            })}
          </div>

          {report && (
            <section className="analytics-report" aria-labelledby="analytics-report-title">
              <header className="analytics-report-header">
                <div>
                  <p className="analytics-eyebrow">Generated report</p>
                  <h2 id="analytics-report-title">{reportTitle ?? title}</h2>
                </div>
                {report.region && <p className="analytics-region">Data region <strong>{report.region}</strong></p>}
              </header>
              {report.sections.map((section, index) => (
                <section className="analytics-result-section" key={`${section.heading}-${index}`} aria-labelledby={`analytics-result-${index}-title`}>
                  <h3 id={`analytics-result-${index}-title`}>{section.heading}</h3>
                  {section.svg && (
                    <div className="analytics-chart-output" dangerouslySetInnerHTML={{ __html: section.svg }} />
                  )}
                  <div className="analytics-table-wrap">
                    <table className="analytics-table">
                      <thead>
                        <tr>{section.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
                      </thead>
                      <tbody>
                        {section.rows.map((row, rowIndex) => (
                          <tr key={rowIndex}>
                            {section.columns.map((column) => <td key={column}>{String(row[column] ?? "")}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
              <p className="analytics-report-footer">Download the self-contained HTML file and print it to PDF from your browser.</p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
