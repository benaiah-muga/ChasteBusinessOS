import { useCallback, useEffect, useState } from "react";
import {
  fetchOrganizations,
  OrganizationApiError,
  switchActiveOrganization,
  type OrganizationList,
} from "../api/organizations";

type ViewState =
  | { status: "loading" }
  | { status: "unauthenticated"; message: string }
  | { status: "empty" }
  | { status: "ready"; data: OrganizationList }
  | { status: "failed"; message: string };

type ActiveOrganizationProps = {
  onChanged?: (orgId: string) => void;
  onActiveOrgIdChange?: (orgId: string | null) => void;
  onCurrencyChanged?: (currencyCode: string | null) => void;
  onNoOrganizations?: () => void;
};

function messageFor(error: unknown): string {
  if (error instanceof OrganizationApiError) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "The organization service took too long. Try again.";
  }
  return "Could not reach the organization service. Try again.";
}

export function ActiveOrganization({ onChanged, onActiveOrgIdChange, onCurrencyChanged, onNoOrganizations }: ActiveOrganizationProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const data = await fetchOrganizations(signal);
      if (signal?.aborted) return;
      if (data.orgs.length === 0) onNoOrganizations?.();
      onActiveOrgIdChange?.(data.activeOrgId);
      onCurrencyChanged?.(data.orgs.find((org) => org.id === data.activeOrgId)?.baseCurrency ?? null);
      setState(data.orgs.length === 0 ? { status: "empty" } : { status: "ready", data });
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof OrganizationApiError && error.status === 401) {
        setState({ status: "unauthenticated", message: error.message });
        return;
      }
      setState({ status: "failed", message: messageFor(error) });
    }
  }, [onActiveOrgIdChange, onCurrencyChanged, onNoOrganizations]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleChange = async (orgId: string) => {
    setPending(true);
    setSwitchError(null);
    try {
      await switchActiveOrganization(orgId);
      const selectedOrg = state.status === "ready" ? state.data.orgs.find((org) => org.id === orgId) : undefined;
      if (state.status === "ready") {
        setState({ status: "ready", data: { ...state.data, activeOrgId: orgId } });
      }
      onCurrencyChanged?.(selectedOrg?.baseCurrency ?? null);
      onActiveOrgIdChange?.(orgId);
      if (onChanged) onChanged(orgId);
      else window.location.assign("/");
    } catch (error) {
      setSwitchError(messageFor(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="organization-card" aria-labelledby="organization-title">
      <div className="organization-heading">
        <div>
          <span className="eyebrow">Workspace context</span>
          <h2 id="organization-title">Active organization</h2>
        </div>
        {pending && <span className="organization-pending" role="status">Saving</span>}
      </div>

      {state.status === "loading" && <p role="status">Loading organizations…</p>}
      {state.status === "unauthenticated" && <p>{state.message}</p>}
      {state.status === "empty" && <p>No organization access is available for this account.</p>}
      {state.status === "failed" && (
        <div className="organization-error-state">
          <p role="alert">{state.message}</p>
          <button className="refresh-button" type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {state.status === "ready" && (
        <label className="organization-select-label" htmlFor="active-organization">
          <span className="sr-only">Active organization</span>
          <select
            id="active-organization"
            aria-label="Active organization"
            value={state.data.activeOrgId ?? ""}
            disabled={pending}
            onChange={(event) => void handleChange(event.currentTarget.value)}
          >
            {state.data.activeOrgId === null && <option value="">Choose an organization</option>}
            {state.data.orgs.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
          </select>
          <span className="organization-chevron" aria-hidden="true">⌄</span>
        </label>
      )}
      {switchError && <p className="organization-error" role="alert">{switchError}</p>}
      <p className="organization-footnote">Your membership is checked again when you switch.</p>
    </section>
  );
}
