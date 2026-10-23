import { BrandMark } from "./brand-mark";
import "./page-loading.css";

/** A content-shaped loading state for full workspaces, not a blank card. */
export function PageLoading({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <section className={`ui-page-loading${compact ? " ui-page-loading-compact" : ""}`} aria-busy="true">
      <div className="ui-page-loading-status" role="status">
        <BrandMark size="sm" />
        <span>{label}</span>
        <span className="ui-page-loading-dot" aria-hidden="true" />
      </div>
      <div className="ui-page-loading-skeleton" aria-hidden="true">
        <div className="ui-page-loading-title" />
        <div className="ui-page-loading-subtitle" />
        <div className="ui-page-loading-cards">
          <span /><span /><span />
        </div>
        <div className="ui-page-loading-table">
          <span /><span /><span /><span /><span />
        </div>
      </div>
    </section>
  );
}
