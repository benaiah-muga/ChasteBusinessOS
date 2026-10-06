import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./CRMPage.css";
import {
  type CrmCustomer,
  type CrmDeal,
  type CrmFollowUpDraft,
  type CrmTask,
  type CrmTimelineEntry,
  type CustomerFilter,
  type SavedCustomerView,
  fetchCrmCustomers,
  fetchCrmDeals,
  fetchCrmFollowUpDraft,
  fetchCrmTasks,
  fetchCrmTeamMembers,
  fetchCrmTimeline,
  fetchCrmViews,
  importCrmCustomers,
  readPendingCrmCustomerCreate,
  readPendingCrmTaskCreate,
  submitCrmAction,
  submitCrmDealStageMove,
  submitCrmCustomerCreate,
  submitCrmTaskMutation,
  undoCrmImport,
} from "../api/crm";
import { selectedCustomersCsv } from "./customer-export";

type Tab = "overview" | "pipeline" | "customers" | "tasks";
type ProfileTab = "overview" | "activity" | "invoices" | "documents";
type TaskFilter = "today" | "overdue" | "unassigned" | "all";
type Member = { userId: string; name: string | null; email: string };
type Notice = { tone: "success" | "error" | "pending"; text: string };
type ImportPreviewRow = { rowNumber: number; source: string[]; name: string; email: string; phone: string; allowDuplicate: boolean; include: boolean; includeExplicit?: boolean; error: string | null; duplicate: string | null };

const stages = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
const stageLabels: Record<(typeof stages)[number], string> = { lead: "Lead", qualified: "Qualified", proposal: "Proposal", negotiation: "Negotiation", won: "Won", lost: "Lost" };
const defaultFilter: CustomerFilter = { status: "active", owner: "all", staleOnly: false, duplicateOnly: false, tag: "" };

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "The CRM service is unavailable. Try again.";
}

function money(minor: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "UGX", maximumFractionDigits: 0 }).format(minor / 100);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

const customerSuffixes = ["llc", "ltd", "limited", "inc", "incorporated", "co", "corp", "corporation", "gmbh", "bv", "plc"];
function normalizeCustomerName(name: string): string {
  let key = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of customerSuffixes) {
      if (key === suffix) return "";
      if (key.endsWith(` ${suffix}`)) { key = key.slice(0, -(suffix.length + 1)).trim(); changed = true; }
    }
  }
  return key;
}
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length]!;
}
function likelyDuplicate(candidate: Pick<CrmCustomer, "name" | "email" | "phone">, other: Pick<CrmCustomer, "name" | "email" | "phone">): boolean {
  const email = candidate.email?.trim().toLowerCase();
  const otherEmail = other.email?.trim().toLowerCase();
  const phoneDigits = candidate.phone?.replace(/\D/g, "") ?? "";
  const otherPhoneDigits = other.phone?.replace(/\D/g, "") ?? "";
  const phone = phoneDigits.length < 7 ? "" : phoneDigits.length > 9 ? phoneDigits.slice(-9) : phoneDigits;
  const otherPhone = otherPhoneDigits.length < 7 ? "" : otherPhoneDigits.length > 9 ? otherPhoneDigits.slice(-9) : otherPhoneDigits;
  if (email && email === otherEmail || phone && phone === otherPhone) return true;
  const name = normalizeCustomerName(candidate.name);
  const otherName = normalizeCustomerName(other.name);
  if (!name) return false;
  if (name === otherName) return true;
  if (Math.min(name.length, otherName.length) < 8) return false;
  const longest = Math.max(name.length, otherName.length);
  return Math.abs(name.length - otherName.length) <= Math.floor(longest * .12) && 1 - editDistance(name, otherName) / longest >= .92;
}
function validateImportRows(rows: ImportPreviewRow[], customers: CrmCustomer[]): ImportPreviewRow[] {
  const known = customers.filter((customer) => !customer.deactivatedAt).map((customer) => ({ name: customer.name, email: customer.email ?? null, phone: customer.phone ?? null }));
  return rows.map((row) => {
    const error = !row.name ? "Customer name is required" : row.name.length > 120 ? "Customer name must be 120 characters or fewer" : row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) ? "Enter a valid email" : row.phone.length > 40 ? "Phone must be 40 characters or fewer" : null;
    const found = !error ? known.find((customer) => likelyDuplicate({ name: row.name, email: row.email || null, phone: row.phone || null }, customer)) : undefined;
    if (row.name) known.push({ name: row.name, email: row.email || null, phone: row.phone || null });
    const duplicate = found ? `Possible match: ${found.name}` : null;
    const include = row.includeExplicit ? row.include : !error && (!duplicate || row.allowDuplicate);
    return { ...row, error, duplicate, include: !error && (!duplicate || row.allowDuplicate) && include };
  });
}

function downloadCustomerTemplate() {
  const blob = new Blob(["name,email,phone\nAda Lovelace,ada@example.com,+256 700 000 000\n"], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = "customer-import-template.csv";
  anchor.click();
  URL.revokeObjectURL(href);
}

export function CRMPage({ actorId = null, organizationId = null }: { actorId?: string | null; organizationId?: string | null } = {}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [deals, setDeals] = useState<CrmDeal[]>([]);
  const [customers, setCustomers] = useState<CrmCustomer[]>([]);
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersRetry, setMembersRetry] = useState(0);
  const [views, setViews] = useState<SavedCustomerView[]>([]);
  const [selected, setSelected] = useState<CrmCustomer | null>(null);
  const [timeline, setTimeline] = useState<CrmTimelineEntry[]>([]);
  const [profileTab, setProfileTab] = useState<ProfileTab>("overview");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [customerCreateBusy, setCustomerCreateBusy] = useState(false);
  const [dealFilter, setDealFilter] = useState<"all" | "open" | "won" | "lost">("all");
  const [dealSearch, setDealSearch] = useState("");
  const [dealView, setDealView] = useState<"board" | "table">("board");
  const [draggingDealId, setDraggingDealId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<(typeof stages)[number] | null>(null);
  const [customerFilter, setCustomerFilter] = useState<CustomerFilter>(defaultFilter);
  const [search, setSearch] = useState("");
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const [bulkOwner, setBulkOwner] = useState("unchanged");
  const [bulkTag, setBulkTag] = useState("");
  const [createDeal, setCreateDeal] = useState({ title: "", value: "", customerId: "" });
  const [createCustomer, setCreateCustomer] = useState({ name: "", email: "", phone: "" });
  const [customerCreateResolvedScope, setCustomerCreateResolvedScope] = useState<string | null>(null);
  const [customerCreateLocked, setCustomerCreateLocked] = useState(false);
  const [newContactMethod, setNewContactMethod] = useState<"email" | "phone" | "whatsapp" | "other">("email");
  const [newDoNotContact, setNewDoNotContact] = useState(false);
  const [profileDraft, setProfileDraft] = useState({ name: "", phone: "", notes: "", tags: "", ownerUserId: "", doNotContact: false, preferredContactMethod: "email" as "email" | "phone" | "whatsapp" | "other" });
  const [taskDraft, setTaskDraft] = useState({ title: "", dueAt: "", note: "", customerId: "", assigneeUserId: "" });
  const [taskDraftResolvedScope, setTaskDraftResolvedScope] = useState<string | null>(null);
  const [taskDraftLocked, setTaskDraftLocked] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ deal: CrmDeal; stage: (typeof stages)[number] } | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [mergeTarget, setMergeTarget] = useState<CrmCustomer | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<CrmCustomer | null>(null);
  const [mergeSurvivorId, setMergeSurvivorId] = useState("");
  const [mergeUndo, setMergeUndo] = useState<Record<string, unknown> | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importSourceRows, setImportSourceRows] = useState<string[][]>([]);
  const [importMapping, setImportMapping] = useState({ name: -1, email: -1, phone: -1 });
  const [importPage, setImportPage] = useState(0);
  const [importRows, setImportRows] = useState<ImportPreviewRow[]>([]);
  const [importSummary, setImportSummary] = useState<{ imported: number; skipped: number; ids: string[]; undone: boolean } | null>(null);
  const [saveViewName, setSaveViewName] = useState("");
  const [convertTarget, setConvertTarget] = useState<CrmDeal | null>(null);
  const [convertMode, setConvertMode] = useState<"new" | "existing">("new");
  const [convertCustomerId, setConvertCustomerId] = useState("");
  const [convertCustomerName, setConvertCustomerName] = useState("");
  const [draftState, setDraftState] = useState<{ status: "idle" } | { status: "loading" } | { status: "ready"; draft: CrmFollowUpDraft; subject: string; body: string } | { status: "failed"; message: string }>({ status: "idle" });
  const [draftCopied, setDraftCopied] = useState(false);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const timelineRequest = useRef(0);
  const movingDealIds = useRef(new Set<string>());
  const customerCreateScopeRef = useRef<string | null>(null);
  const customerCreateScopeGeneration = useRef(0);
  const goCrmTaskWrites = typeof __GO_CRM_TASK_WRITES__ !== "undefined" && __GO_CRM_TASK_WRITES__;
  const goCrmCustomerCreate = typeof __GO_CRM_CUSTOMER_CREATE__ !== "undefined" && __GO_CRM_CUSTOMER_CREATE__;
  const customerCreateScopeIdentity = actorId?.trim() && organizationId?.trim() ? `${actorId.trim()}:${organizationId.trim()}` : null;
  if (customerCreateScopeRef.current !== customerCreateScopeIdentity) {
    customerCreateScopeRef.current = customerCreateScopeIdentity;
    customerCreateScopeGeneration.current += 1;
  }
  const busy = sharedBusy || customerCreateBusy;
  const customerCreateReady = !goCrmCustomerCreate || Boolean(customerCreateScopeIdentity && customerCreateResolvedScope === customerCreateScopeIdentity);
  const taskDraftScopeIdentity = actorId?.trim() && organizationId?.trim() ? `${actorId.trim()}:${organizationId.trim()}` : null;
  const taskDraftReady = !goCrmTaskWrites || Boolean(taskDraftScopeIdentity && taskDraftResolvedScope === taskDraftScopeIdentity);

  const load = useCallback(async (signal?: AbortSignal, isCurrent: () => boolean = () => true) => {
    if (!isCurrent()) return;
    setError(null);
    setLoading(true);
    const results = await Promise.allSettled([fetchCrmDeals(signal), fetchCrmCustomers(signal), fetchCrmTasks(signal)]);
    if (signal?.aborted || !isCurrent()) return;
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") setError(friendlyError(failed.reason));
    if (results[0]?.status === "fulfilled") setDeals(results[0].value);
    if (results[1]?.status === "fulfilled") setCustomers(results[1].value);
    if (results[2]?.status === "fulfilled") setTasks(results[2].value);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(window.location.search);
    const requested = query.get("dealFilter");
    if (requested === "all" || requested === "open" || requested === "won" || requested === "lost") setDealFilter(requested);
    void load(controller.signal);
    void fetchCrmViews(controller.signal).then(setViews).catch(() => undefined);
    return () => {
      timelineRequest.current += 1;
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!goCrmTaskWrites) {
      setTaskDraftResolvedScope(null);
      setTaskDraftLocked(false);
      return;
    }
    let active = true;
    setTaskDraftResolvedScope(null);
    setTaskDraftLocked(false);
    setTaskDraft({ title: "", dueAt: "", note: "", customerId: "", assigneeUserId: "" });
    if (!actorId?.trim() || !organizationId?.trim()) return () => { active = false; };
    void readPendingCrmTaskCreate({ actorId, organizationId }).then((pending) => {
      if (!active) return;
      if (pending) {
        setTaskDraft({
          title: pending.title,
          dueAt: pending.dueAt ? pending.dueAt.slice(0, 10) : "",
          note: pending.note ?? "",
          customerId: pending.refId ?? "",
          assigneeUserId: pending.assigneeUserId ?? "",
        });
        setTaskDraftLocked(true);
      }
      setTaskDraftResolvedScope(taskDraftScopeIdentity);
    }).catch((reason: unknown) => {
      if (!active) return;
      setNotice({ tone: "error", text: friendlyError(reason) });
    });
    return () => { active = false; };
  }, [actorId, goCrmTaskWrites, organizationId, taskDraftScopeIdentity]);

  useEffect(() => {
    if (!goCrmCustomerCreate) {
      setCustomerCreateResolvedScope(null);
      setCustomerCreateLocked(false);
      return;
    }
    let active = true;
    setCustomerCreateResolvedScope(null);
    setCustomerCreateLocked(false);
    setCustomerCreateBusy(false);
    setCreateCustomer({ name: "", email: "", phone: "" });
    setNewContactMethod("email");
    setNewDoNotContact(false);
    if (!actorId?.trim() || !organizationId?.trim()) return () => { active = false; };
    void readPendingCrmCustomerCreate({ actorId, organizationId }).then((pending) => {
      if (!active) return;
      if (pending) {
        setCreateCustomer({ name: pending.name, email: pending.email ?? "", phone: pending.phone ?? "" });
        setNewContactMethod(pending.preferredContactMethod);
        setNewDoNotContact(pending.doNotContact);
        setCustomerCreateLocked(true);
      }
      setCustomerCreateResolvedScope(customerCreateScopeIdentity);
    }).catch((reason: unknown) => {
      if (!active) return;
      setNotice({ tone: "error", text: friendlyError(reason) });
    });
    return () => { active = false; };
  }, [actorId, customerCreateScopeIdentity, goCrmCustomerCreate, organizationId]);

  useEffect(() => {
    if ((tab !== "customers" && tab !== "tasks") || membersLoaded) return;
    const controller = new AbortController();
    setMembersLoading(true);
    setMembersError(null);
    void fetchCrmTeamMembers(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setMembers(result);
          setMembersLoaded(true);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setMembersError(friendlyError(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setMembersLoading(false);
      });
    return () => controller.abort();
  }, [tab, membersLoaded, membersRetry]);

  useEffect(() => {
    if (tab !== "tasks" || !focusedTaskId) return;
    document.getElementById(`crm-task-${focusedTaskId}`)?.focus();
  }, [focusedTaskId, tab, tasks]);

  useEffect(() => {
    if (focusedTaskId) setTaskFilter("all");
  }, [focusedTaskId]);

  function closeProfile() {
    timelineRequest.current += 1;
    setSelected(null);
  }

  function navigateToTab(nextTab: Tab) {
    closeProfile();
    setTab(nextTab);
  }

  const openProfile = useCallback(async (customer: CrmCustomer, initial: ProfileTab = "overview") => {
    const requestId = ++timelineRequest.current;
    setSelected(customer);
    setProfileTab(initial);
    setProfileDraft({ name: customer.name, phone: customer.phone ?? "", notes: customer.notes ?? "", tags: (customer.tags ?? []).join(", "), ownerUserId: customer.ownerUserId ?? "", doNotContact: customer.doNotContact ?? false, preferredContactMethod: customer.preferredContactMethod ?? "email" });
    setTimeline([]);
    setDraftState({ status: "idle" }); setDraftCopied(false);
    try {
      const entries = await fetchCrmTimeline(customer.id);
      if (requestId === timelineRequest.current) setTimeline(entries);
    } catch (reason) {
      if (requestId === timelineRequest.current) setNotice({ tone: "error", text: friendlyError(reason) });
    }
  }, []);

  async function mutate(path: "/api/deals" | "/api/customers" | "/api/crm" | "/api/crm/views", action: Record<string, unknown>, onDone?: (data: Record<string, unknown>) => void, submitAction?: () => ReturnType<typeof submitCrmAction>, isCurrent: () => boolean = () => true, busyOwner: "shared" | "customer-create" = "shared"): Promise<boolean> {
    const setOperationBusy = busyOwner === "customer-create" ? setCustomerCreateBusy : setSharedBusy;
    setOperationBusy(true);
    try {
      const outcome = await (submitAction ? submitAction() : submitCrmAction(path, action));
      if (!isCurrent()) return false;
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", text: outcome.reason });
        return false;
      }
      onDone?.(outcome.data);
      setNotice({ tone: "success", text: "CRM changes saved." });
      await load(undefined, isCurrent);
      if (!isCurrent()) return false;
      if (selected) {
        const refreshed = (await fetchCrmCustomers()).find((customer) => customer.id === selected.id);
        if (!isCurrent()) return false;
        if (refreshed) await openProfile(refreshed, profileTab);
      }
      return true;
    } catch (reason) {
      if (!isCurrent()) return false;
      setNotice({ tone: "error", text: friendlyError(reason) });
      return false;
    } finally { if (isCurrent()) setOperationBusy(false); }
  }

  async function moveDeal(deal: CrmDeal, next: (typeof stages)[number], reason?: string) {
    const trimmedReason = reason?.trim();
    if (movingDealIds.current.has(deal.id) || (next === "lost" && (!trimmedReason || trimmedReason.length < 3 || trimmedReason.length > 500))) return;
    const beforeStage = deals.find((item) => item.id === deal.id)?.stage ?? deal.stage;
    setDeals((current) => current.map((item) => item.id === deal.id ? { ...item, stage: next } : item));
    movingDealIds.current.add(deal.id);
    try {
      const action = { dealId: deal.id, stage: next, ...(trimmedReason ? { lostReason: trimmedReason } : {}) };
      const accepted = await mutate("/api/deals", { action: "move", ...action }, undefined, () => submitCrmDealStageMove(action, undefined, undefined, { actorId, organizationId }));
      if (!accepted) {
        setDeals((current) => current.map((item) => item.id === deal.id ? { ...item, stage: beforeStage } : item));
        return;
      }
      setMoveTarget(null);
      setLostReason("");
    } finally {
      movingDealIds.current.delete(deal.id);
    }
  }

  function requestMove(deal: CrmDeal, next: (typeof stages)[number]) {
    if (deal.stage === next) return;
    const weightsByStage: Record<string, number> = { lead: .1, qualified: .3, proposal: .5, negotiation: .7, won: 1, lost: 0 };
    const forecastChange = Math.round(deal.valueMinor * (weightsByStage[next]! - weightsByStage[deal.stage]!));
    if (next === "lost" || forecastChange !== 0) {
      setLostReason(""); setMoveTarget({ deal, stage: next });
      return;
    }
    void moveDeal(deal, next);
  }

  async function createNewDeal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const valueMinor = Math.round(Number(createDeal.value || "0") * 100);
    if (!createDeal.title.trim() || !Number.isSafeInteger(valueMinor) || valueMinor < 0) return;
    const accepted = await mutate("/api/deals", { action: "create", title: createDeal.title.trim(), valueMinor, ...(createDeal.customerId ? { customerId: createDeal.customerId } : {}) });
    if (accepted) setCreateDeal({ title: "", value: "", customerId: "" });
  }

  async function createNewCustomer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createCustomer.name.trim() || !customerCreateReady || busy) return;
    const input = { name: createCustomer.name.trim(), ...(createCustomer.email.trim() ? { email: createCustomer.email.trim() } : {}), ...(createCustomer.phone.trim() ? { phone: createCustomer.phone.trim() } : {}), preferredContactMethod: newContactMethod, doNotContact: newDoNotContact };
    const operationScope = customerCreateScopeIdentity;
    const operationScopeGeneration = customerCreateScopeGeneration.current;
    const isCurrentScope = () => !goCrmCustomerCreate || Boolean(operationScope && customerCreateScopeRef.current === operationScope && customerCreateScopeGeneration.current === operationScopeGeneration);
    let duplicateWarning: string | null = null;
    const accepted = await mutate("/api/customers", { action: "create", ...input }, undefined, async () => {
      try {
        const outcome = await submitCrmCustomerCreate(input, undefined, goCrmCustomerCreate, { actorId, organizationId });
        if (!isCurrentScope()) return outcome;
        if (outcome.kind === "pending") {
          if (goCrmCustomerCreate) setCustomerCreateLocked(true);
        } else {
          setCustomerCreateLocked(false);
          duplicateWarning = outcome.data.duplicateWarning ?? null;
        }
        return outcome;
      } catch (reason) {
        if (!isCurrentScope()) throw reason;
        if (reason instanceof Error && "status" in reason) {
          const status = Number((reason as { status: unknown }).status);
          const mayHaveReached = Boolean((reason as { requestMayHaveReachedServer?: unknown }).requestMayHaveReachedServer);
          if (goCrmCustomerCreate && (mayHaveReached || status === 408 || status === 429 || status >= 500) && !(status >= 400 && status < 500 && status !== 408 && status !== 429)) setCustomerCreateLocked(true);
          if (goCrmCustomerCreate && status >= 400 && status < 500 && status !== 408 && status !== 429) setCustomerCreateLocked(false);
        }
        throw reason;
      }
    }, isCurrentScope, "customer-create");
    if (accepted && isCurrentScope()) {
      setCreateCustomer({ name: "", email: "", phone: "" });
      setNewContactMethod("email");
      setNewDoNotContact(false);
      setCustomerCreateLocked(false);
      setNotice({ tone: "success", text: duplicateWarning ? `Customer added. ${duplicateWarning}` : "Customer added." });
    }
  }

  const activeCustomers = customers.filter((customer) => !customer.deactivatedAt);
  const openTasks = tasks.filter((task) => !task.doneAt);
  const completedTasks = tasks.filter((task) => Boolean(task.doneAt));
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueTodayTasks = openTasks.filter((task) => task.dueAt && new Date(task.dueAt) >= todayStart && new Date(task.dueAt) < tomorrow);
  const overdueTasks = openTasks.filter((task) => task.dueAt && new Date(task.dueAt) < todayStart);
  const unassignedTasks = openTasks.filter((task) => !task.assigneeUserId);
  const visibleTasks = (showCompletedTasks ? tasks : openTasks).filter((task) => {
    if (taskFilter === "today") return Boolean(task.dueAt && new Date(task.dueAt) >= todayStart && new Date(task.dueAt) < tomorrow);
    if (taskFilter === "overdue") return Boolean(task.dueAt && new Date(task.dueAt) < todayStart);
    if (taskFilter === "unassigned") return !task.assigneeUserId;
    return true;
  });
  const duplicates = useMemo(() => {
    const ids = new Set<string>();
    for (let i = 0; i < activeCustomers.length; i += 1) {
      for (let j = i + 1; j < activeCustomers.length; j += 1) {
        if (likelyDuplicate(activeCustomers[i]!, activeCustomers[j]!)) { ids.add(activeCustomers[i]!.id); ids.add(activeCustomers[j]!.id); }
      }
    }
    return ids;
  }, [customers]);
  const visibleCustomers = customers.filter((customer) => {
    if (customerFilter.status === "active" && customer.deactivatedAt) return false;
    if (customerFilter.status === "inactive" && !customer.deactivatedAt) return false;
    if (customerFilter.owner === "unassigned" && customer.ownerUserId) return false;
    if (customerFilter.owner !== "all" && customerFilter.owner !== "unassigned" && customer.ownerUserId !== customerFilter.owner) return false;
    if (customerFilter.staleOnly && (!customer.lastActivityAt || Date.now() - Date.parse(customer.lastActivityAt) < 30 * 86400000)) return false;
    if (customerFilter.duplicateOnly && !duplicates.has(customer.id)) return false;
    if (customerFilter.tag && !(customer.tags ?? []).some((tag) => tag.toLowerCase() === customerFilter.tag.toLowerCase())) return false;
    const term = search.trim().toLowerCase();
    return !term || [customer.name, customer.email ?? "", customer.phone ?? "", ...(customer.tags ?? [])].some((value) => value.toLowerCase().includes(term));
  });
  const visibleDeals = deals.filter((deal) => {
    const matchesStage = dealFilter === "all" || (dealFilter === "open" && deal.stage !== "won" && deal.stage !== "lost") || deal.stage === dealFilter;
    const query = dealSearch.trim().toLowerCase();
    const matchesSearch = !query || `${deal.title} ${deal.customerName ?? ""} ${deal.note ?? ""}`.toLowerCase().includes(query);
    return matchesStage && matchesSearch;
  });
  const openDeals = deals.filter((deal) => deal.stage !== "won" && deal.stage !== "lost");
  const forecast = openDeals.reduce((sum, deal) => sum + Math.round(deal.valueMinor * (({ lead: .1, qualified: .3, proposal: .5, negotiation: .7 } as Record<string, number>)[deal.stage] ?? 0)), 0);

  async function saveCustomerProfile() {
    if (!selected) return;
    const oldTags = selected.tags ?? [];
    const nextTags = profileDraft.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    await mutate("/api/customers", {
      action: "updateProfile", customerIds: [selected.id], name: profileDraft.name.trim(), phone: profileDraft.phone.trim() || null,
      notes: profileDraft.notes.trim() || null, ownerUserId: profileDraft.ownerUserId || null,
      addTags: nextTags.filter((tag) => !oldTags.includes(tag)), removeTags: oldTags.filter((tag) => !nextTags.includes(tag)),
      doNotContact: profileDraft.doNotContact, preferredContactMethod: profileDraft.preferredContactMethod,
    });
  }

  async function applyBulkCustomerUpdate() {
    const tag = bulkTag.trim();
    if (!selectedCustomerIds.length || (bulkOwner === "unchanged" && !tag)) return;
    const accepted = await mutate("/api/customers", {
      action: "updateProfile",
      customerIds: selectedCustomerIds,
      ...(bulkOwner !== "unchanged" ? { ownerUserId: bulkOwner === "unassigned" ? null : bulkOwner } : {}),
      ...(tag ? { addTags: [tag] } : {}),
    });
    if (accepted) {
      setSelectedCustomerIds([]);
      setBulkOwner("unchanged");
      setBulkTag("");
    }
  }

  function exportSelectedCustomers() {
    const csv = selectedCustomersCsv(customers, selectedCustomerIds);
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "customers.csv";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!taskDraft.title.trim() || !taskDraftReady || busy) return;
    const action = { action: "createTask" as const, title: taskDraft.title.trim(), ...(taskDraft.dueAt ? { dueAt: new Date(`${taskDraft.dueAt}T12:00:00`).toISOString() } : {}), ...(taskDraft.assigneeUserId ? { assigneeUserId: taskDraft.assigneeUserId } : {}), ...(taskDraft.note.trim() ? { note: taskDraft.note.trim() } : {}), ...(taskDraft.customerId ? { refType: "customer", refId: taskDraft.customerId } : {}) };
    const accepted = await mutate("/api/crm", action, undefined, async () => {
      try {
        const outcome = await submitCrmTaskMutation(action, undefined, goCrmTaskWrites, { actorId, organizationId });
        if (outcome.kind === "pending") setTaskDraftLocked(true);
        else setTaskDraftLocked(false);
        return outcome;
      } catch (reason) {
        if (reason instanceof Error && "status" in reason) {
          const status = Number((reason as { status: unknown }).status);
          const mayHaveReached = Boolean((reason as { requestMayHaveReachedServer?: unknown }).requestMayHaveReachedServer);
          if ((mayHaveReached || status === 408 || status === 429 || status >= 500) && !(status >= 400 && status < 500 && status !== 408 && status !== 429)) setTaskDraftLocked(true);
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) setTaskDraftLocked(false);
        }
        throw reason;
      }
    });
    if (accepted) {
      setTaskDraft({ title: "", dueAt: "", note: "", customerId: "", assigneeUserId: "" });
      setTaskDraftLocked(false);
    }
  }

  async function refreshViews() {
    try { setViews(await fetchCrmViews()); } catch (reason) { setNotice({ tone: "error", text: friendlyError(reason) }); }
  }

  async function saveView(name = saveViewName, view?: SavedCustomerView) {
    if (!name.trim()) return;
    const result = await mutate("/api/crm/views", { ...(view ? { id: view.id } : {}), name: name.trim(), filters: view?.filters ?? customerFilter, isShared: view?.isShared ?? true, isPinned: view?.isPinned ?? false });
    if (result) { setSaveViewName(""); await refreshViews(); }
  }

  function previewMappedRows(sourceRows: string[][], mapping: { name: number; email: number; phone: number }): ImportPreviewRow[] {
    const rows = sourceRows.map((source, index) => ({
      rowNumber: index + 2,
      source,
      name: (mapping.name < 0 ? "" : source[mapping.name] ?? "").trim(),
      email: (mapping.email < 0 ? "" : source[mapping.email] ?? "").trim(),
      phone: (mapping.phone < 0 ? "" : source[mapping.phone] ?? "").trim(),
      allowDuplicate: false,
      include: false,
      error: null,
      duplicate: null,
    }));
    return validateImportRows(rows, customers).map((row) => ({ ...row, include: !row.error && (!row.duplicate || row.allowDuplicate) }));
  }

  async function readImport(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") { setNotice({ tone: "error", text: "Choose a CSV file to continue." }); return; }
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2 || parsed.length > 5001) { setNotice({ tone: "error", text: parsed.length < 2 ? "Add a header row and at least one customer row." : "This file has more than 5,000 rows. Split it into smaller imports." }); return; }
    const headers = parsed[0]!.map((value) => value.trim());
    const findHeader = (choices: string[]) => headers.findIndex((header) => choices.includes(header.trim().toLowerCase().replace(/[_-]+/g, " ")));
    const nameCol = findHeader(["name", "customer name", "full name", "company", "business name"]);
    const emailCol = findHeader(["email", "email address"]);
    const phoneCol = findHeader(["phone", "phone number", "mobile", "telephone"]);
    const mapping = { name: nameCol, email: emailCol, phone: phoneCol };
    setImportHeaders(headers);
    setImportSourceRows(parsed.slice(1));
    setImportMapping(mapping);
    setImportRows(previewMappedRows(parsed.slice(1), mapping));
    setImportPage(0);
    setImportSummary(null); setImportOpen(true);
  }

  function updateImportMapping(key: "name" | "email" | "phone", value: string) {
    const next = { ...importMapping, [key]: value === "" ? -1 : Number(value) };
    setImportMapping(next);
    setImportRows(previewMappedRows(importSourceRows, next));
    setImportPage(0);
  }

  function editImportRow(index: number, key: "name" | "email" | "phone", value: string) {
    setImportRows((current) => validateImportRows(current.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row), customers));
  }

  async function convertLead() {
    if (!convertTarget || (convertMode === "existing" && !convertCustomerId) || (convertMode === "new" && !convertCustomerName.trim())) return;
    const accepted = await mutate("/api/crm", { action: "convertLead", dealId: convertTarget.id, ...(convertMode === "existing" ? { customerId: convertCustomerId } : { createCustomer: true, customerName: convertCustomerName.trim() }) });
    if (accepted) { setConvertTarget(null); setConvertCustomerId(""); setConvertCustomerName(""); }
  }

  async function generateFollowUpDraft() {
    if (!selected || selected.doNotContact) return;
    setDraftState({ status: "loading" }); setDraftCopied(false);
    try {
      const draft = await fetchCrmFollowUpDraft(selected.id);
      setDraftState({ status: "ready", draft, subject: `Following up with ${selected.name}`, body: draft.draft });
    } catch (reason) { setDraftState({ status: "failed", message: friendlyError(reason) }); }
  }

  async function copyFollowUpDraft() {
    if (draftState.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(`Subject: ${draftState.subject}\n\n${draftState.body}`);
      setDraftCopied(true);
    } catch { setNotice({ tone: "error", text: "Could not copy the draft. Select and copy it manually." }); }
  }

  function openDraftSource(source: CrmTimelineEntry) {
    if (source.kind === "task") { setShowCompletedTasks(true); setFocusedTaskId(source.refId); navigateToTab("tasks"); return; }
    const path = source.kind === "invoice" ? `/accounting?recordPayment=${encodeURIComponent(source.refId)}#receivables` : `/sales?tab=quotes&focusQuote=${encodeURIComponent(source.refId)}`;
    closeProfile();
    window.location.assign(path);
  }

  async function submitImport() {
    const rows = importRows.filter((row) => row.include && !row.error).map(({ rowNumber, name, email, phone, allowDuplicate }) => ({ rowNumber, name, ...(email ? { email } : {}), ...(phone ? { phone } : {}), allowDuplicate }));
    if (!rows.length) return;
    setSharedBusy(true);
    try {
      const result = await importCrmCustomers(rows);
      if (result.kind === "pending") { setNotice({ tone: "pending", text: result.reason }); return; }
      setImportSummary({ imported: result.data.inserted, skipped: result.data.skippedDuplicates, ids: result.data.createdIds, undone: false });
      setNotice({ tone: "success", text: `Imported ${result.data.inserted} customers. ${result.data.skippedDuplicates} likely duplicates were skipped.` });
      await load();
    } catch (reason) { setNotice({ tone: "error", text: friendlyError(reason) }); }
    finally { setSharedBusy(false); }
  }

  async function undoImport() {
    if (!importSummary?.ids.length) return;
    setSharedBusy(true);
    try {
      const result = await undoCrmImport(importSummary.ids);
      if (result.kind === "pending") { setNotice({ tone: "pending", text: result.reason }); return; }
      setImportSummary({ ...importSummary, ids: [], undone: true });
      setNotice({ tone: "success", text: result.data.remaining ? `Deactivated ${result.data.undone} imported customers. ${result.data.remaining} had already changed.` : `Undid this import. ${result.data.undone} imported customers were deactivated.` });
      await load();
    } catch (reason) { setNotice({ tone: "error", text: friendlyError(reason) }); }
    finally { setSharedBusy(false); }
  }

  const tabButton = (id: Tab, label: string, count?: number) => <button type="button" className={`crm-tab${tab === id ? " is-active" : ""}`} aria-pressed={tab === id} onClick={() => navigateToTab(id)}>{label}{count !== undefined && <span>{count}</span>}</button>;
  const importPageSize = 40;
  const visibleImportRows = importRows.slice(importPage * importPageSize, (importPage + 1) * importPageSize);
  const selectedImportCount = importRows.filter((row) => row.include && !row.error).length;

  if (loading && !deals.length && !customers.length) return <main className="crm-page"><p role="status">Loading CRM…</p></main>;
  return <main className="crm-page">
    <header className="crm-header"><div><p className="crm-eyebrow">Customer relationships</p><h1>CRM</h1><p>Keep customer history, deal progress, and follow-up work together.</p></div><button type="button" onClick={() => void load()}>Refresh</button></header>
    {notice && <div className={`crm-notice crm-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}><span>{notice.text}</span><button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button></div>}
    {error && <div className="crm-error" role="alert">{error}<button type="button" onClick={() => void load()}>Retry</button></div>}
    {(tab === "customers" || tab === "tasks") && membersLoading && <p role="status">Loading team members…</p>}
    {(tab === "customers" || tab === "tasks") && membersError && <div className="crm-error" role="alert">{membersError}<button type="button" onClick={() => setMembersRetry((count) => count + 1)}>Retry team members</button></div>}
    <nav className="crm-tabs" aria-label="CRM sections">{tabButton("overview", "Overview")}{tabButton("pipeline", "Pipeline", deals.length)}{tabButton("customers", "Customers", activeCustomers.length)}{tabButton("tasks", "Tasks", tasks.filter((task) => !task.doneAt).length)}</nav>

    {tab === "overview" && <section className="crm-overview" aria-label="CRM overview">
      <div className="crm-kpis"><article><span>Open pipeline</span><strong>{openDeals.length}</strong></article><article><span>Weighted forecast</span><strong>{money(forecast)}</strong></article><article><span>Won</span><strong>{money(deals.filter((deal) => deal.stage === "won").reduce((sum, deal) => sum + deal.valueMinor, 0))}</strong></article><article><span>Active customers</span><strong>{activeCustomers.length}</strong></article></div>
      <div className="crm-overview-grid"><section className="crm-panel"><header><h2>Pipeline by stage</h2><button type="button" onClick={() => navigateToTab("pipeline")}>Open pipeline</button></header>{stages.map((stageName) => { const rows = deals.filter((deal) => deal.stage === stageName); return <button className="crm-stage-summary" type="button" key={stageName} onClick={() => { setDealFilter(stageName === "won" || stageName === "lost" ? stageName : "open"); navigateToTab("pipeline"); }}><span>{stageLabels[stageName]}</span><strong>{rows.length}</strong><span>{money(rows.reduce((sum, deal) => sum + deal.valueMinor, 0))}</span></button>; })}</section>
        <section className="crm-panel"><header><h2>Recent customers</h2><button type="button" onClick={() => navigateToTab("customers")}>Browse customers</button></header>{activeCustomers.slice(0, 6).map((customer) => <button className="crm-list-row" key={customer.id} type="button" onClick={() => void openProfile(customer)}><span><strong>{customer.name}</strong><small>{customer.email ?? customer.phone ?? "No contact details"}</small></span><span>{customer.nextStep?.summary ?? "View profile"}</span></button>)}</section></div>
    </section>}

    {tab === "pipeline" && <section className="crm-panel" aria-label="Deals pipeline"><header className="crm-panel-heading"><div><h2>Deals pipeline</h2><p>Move deals through six stages. Stage changes that affect the forecast require confirmation, and lost deals require a reason.</p></div><label>Show <select aria-label="Filter deals" value={dealFilter} onChange={(event) => setDealFilter(event.target.value as typeof dealFilter)}><option value="all">All deals</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select></label></header>
      <form className="crm-inline-form" onSubmit={(event) => void createNewDeal(event)}><label>Deal name<input required value={createDeal.title} onChange={(event) => setCreateDeal({ ...createDeal, title: event.target.value })} /></label><label>Value<input type="number" min="0" step="0.01" value={createDeal.value} onChange={(event) => setCreateDeal({ ...createDeal, value: event.target.value })} /></label><label>Customer<select value={createDeal.customerId} onChange={(event) => setCreateDeal({ ...createDeal, customerId: event.target.value })}><option value="">No linked customer</option>{activeCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label><button disabled={busy}>Add deal</button></form>
      <div className="crm-deal-controls"><label>Search deals<input type="search" value={dealSearch} onChange={(event) => setDealSearch(event.target.value)} placeholder="Deal, customer, or note" /></label><div role="group" aria-label="Deal layout"><button type="button" aria-pressed={dealView === "board"} onClick={() => setDealView("board")}>Board</button><button type="button" aria-pressed={dealView === "table"} onClick={() => setDealView("table")}>Table</button></div></div>
      {dealView === "board" ? <div className="crm-deal-board">{stages.filter((stageName) => dealFilter === "all" || (dealFilter === "open" ? stageName !== "won" && stageName !== "lost" : stageName === dealFilter)).map((stageName) => <section className={`crm-deal-column${overStage === stageName ? " crm-deal-column-over" : ""}`} key={stageName} aria-label={`${stageLabels[stageName]} deals`} onDragOver={(event) => { event.preventDefault(); setOverStage(stageName); }} onDragLeave={() => setOverStage((current) => current === stageName ? null : current)} onDrop={(event) => { event.preventDefault(); const deal = deals.find((entry) => entry.id === draggingDealId); if (deal) requestMove(deal, stageName); setDraggingDealId(null); setOverStage(null); }}><h3>{stageLabels[stageName]} <span>{visibleDeals.filter((deal) => deal.stage === stageName).length}</span></h3>{visibleDeals.filter((deal) => deal.stage === stageName).map((deal) => <article className={`crm-deal-card${draggingDealId === deal.id ? " crm-deal-card-dragging" : ""}`} key={deal.id} draggable onDragStart={(event) => { setDraggingDealId(deal.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", deal.id); }} onDragEnd={() => { setDraggingDealId(null); setOverStage(null); }}><strong>{deal.title}</strong><span>{money(deal.valueMinor)}</span>{deal.customerName && <small>{deal.customerName}</small>}{deal.note && <small>{deal.note}</small>}<label>Move to<select aria-label={`Move ${deal.title}`} value={deal.stage} disabled={busy} onChange={(event) => requestMove(deal, event.target.value as (typeof stages)[number])}><option value={deal.stage}>{stageLabels[deal.stage]}</option>{stages.filter((candidate) => candidate !== deal.stage).map((candidate) => <option key={candidate} value={candidate}>{stageLabels[candidate]}</option>)}</select></label>{deal.stage === "lead" && <button type="button" onClick={() => { setConvertTarget(deal); setConvertMode("new"); setConvertCustomerName(deal.customerName ?? ""); setConvertCustomerId(""); }}>Convert lead</button>}</article>)}</section>)}</div> : <div className="crm-table-wrap"><table className="crm-table crm-deal-table"><thead><tr><th>Deal</th><th>Customer</th><th>Stage</th><th>Value</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{visibleDeals.map((deal) => <tr key={deal.id}><td><strong>{deal.title}</strong>{deal.note && <small>{deal.note}</small>}</td><td>{deal.customerName ?? "Unlinked"}</td><td><select aria-label={`Move ${deal.title}`} value={deal.stage} disabled={busy} onChange={(event) => requestMove(deal, event.target.value as (typeof stages)[number])}>{stages.map((candidate) => <option key={candidate} value={candidate}>{stageLabels[candidate]}</option>)}</select></td><td>{money(deal.valueMinor)}</td><td>{new Date(deal.updatedAt).toLocaleDateString()}</td><td>{deal.stage === "lead" && <button type="button" onClick={() => { setConvertTarget(deal); setConvertMode("new"); setConvertCustomerName(deal.customerName ?? ""); setConvertCustomerId(""); }}>Convert lead</button>}</td></tr>)}</tbody></table>{visibleDeals.length === 0 && <p className="crm-empty">No deals match this filter.</p>}</div>}
    </section>}

    {tab === "customers" && <section className="crm-panel" aria-label="Customer directory"><header className="crm-panel-heading"><div><h2>Customers</h2><p>Profiles retain linked records when a customer is deactivated or merged.</p></div><button type="button" onClick={() => { setImportOpen(true); setImportSummary(null); }}>Import CSV</button></header>
      <form className="crm-inline-form" onSubmit={(event) => void createNewCustomer(event)}><label>Name<input required maxLength={120} disabled={busy || !customerCreateReady || customerCreateLocked} value={createCustomer.name} onChange={(event) => setCreateCustomer({ ...createCustomer, name: event.target.value })} /></label><label>Email<input type="email" disabled={busy || !customerCreateReady || customerCreateLocked} value={createCustomer.email} onChange={(event) => setCreateCustomer({ ...createCustomer, email: event.target.value })} /></label><label>Phone<input maxLength={40} disabled={busy || !customerCreateReady || customerCreateLocked} value={createCustomer.phone} onChange={(event) => setCreateCustomer({ ...createCustomer, phone: event.target.value })} /></label><label>Preferred contact<select disabled={busy || !customerCreateReady || customerCreateLocked} value={newContactMethod} onChange={(event) => setNewContactMethod(event.target.value as typeof newContactMethod)}><option value="email">Email</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option><option value="other">Other</option></select></label><label className="crm-check"><input type="checkbox" disabled={busy || !customerCreateReady || customerCreateLocked} checked={newDoNotContact} onChange={(event) => setNewDoNotContact(event.target.checked)} /> Do not contact</label><button disabled={busy || !customerCreateReady}>{customerCreateLocked ? "Retry customer" : "Add customer"}</button></form>
      {goCrmCustomerCreate && !customerCreateReady && <p role="status">CRM is waiting for account and organization details or restoring a saved customer draft.</p>}
      {goCrmCustomerCreate && customerCreateLocked && <p role="status">This customer creation is pending or uncertain. Retry the same details to resolve it.</p>}
      <div className="crm-filter-row"><label>Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, phone, or tag" /></label><label>Status<select value={customerFilter.status} onChange={(event) => setCustomerFilter({ ...customerFilter, status: event.target.value as CustomerFilter["status"] })}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></label><label>Owner<select value={customerFilter.owner} onChange={(event) => setCustomerFilter({ ...customerFilter, owner: event.target.value })}><option value="all">All owners</option><option value="unassigned">Unassigned</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.name ?? member.email}</option>)}</select></label><label>Tag<input value={customerFilter.tag} onChange={(event) => setCustomerFilter({ ...customerFilter, tag: event.target.value })} /></label><label className="crm-check"><input type="checkbox" checked={customerFilter.staleOnly} onChange={(event) => setCustomerFilter({ ...customerFilter, staleOnly: event.target.checked })} /> No activity in 30 days</label><label className="crm-check"><input type="checkbox" checked={customerFilter.duplicateOnly} onChange={(event) => setCustomerFilter({ ...customerFilter, duplicateOnly: event.target.checked })} /> Possible duplicates</label></div>
      <div className="crm-saved-views"><label>Saved views<select aria-label="Saved customer views" value="" onChange={(event) => { const view = views.find((entry) => entry.id === event.target.value); if (view) setCustomerFilter(view.filters); }}><option value="">Choose a view</option>{views.filter((view) => view.isPinned).map((view) => <option key={view.id} value={view.id}>★ {view.name}</option>)}{views.filter((view) => !view.isPinned).map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label><input aria-label="Saved view name" placeholder="Name this view" value={saveViewName} onChange={(event) => setSaveViewName(event.target.value)} /><button type="button" disabled={!saveViewName.trim() || busy} onClick={() => void saveView()}>Save current view</button>{views.map((view) => <span className="crm-view-chip" key={view.id}>{view.name}<button type="button" aria-label={`Pin ${view.name}`} onClick={() => void saveView(view.name, { ...view, isPinned: !view.isPinned })}>{view.isPinned ? "★" : "☆"}</button><button type="button" aria-label={`Share ${view.name}`} onClick={() => void saveView(view.name, { ...view, isShared: !view.isShared })}>{view.isShared ? "Shared" : "Private"}</button></span>)}</div>
      <form className="crm-bulk-customer-form" aria-label="Bulk customer updates" onSubmit={(event) => { event.preventDefault(); void applyBulkCustomerUpdate(); }}>
        <span>{selectedCustomerIds.length} selected</span>
        <label>Assign owner<select aria-label="Bulk owner" value={bulkOwner} onChange={(event) => setBulkOwner(event.target.value)}><option value="unchanged">Keep current owner</option><option value="unassigned">Unassigned</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.name ?? member.email}</option>)}</select></label>
        <label>Add tag<input aria-label="Bulk tag" value={bulkTag} onChange={(event) => setBulkTag(event.target.value)} maxLength={40} /></label>
        <button type="submit" disabled={busy || selectedCustomerIds.length === 0 || (bulkOwner === "unchanged" && !bulkTag.trim())}>Apply to selected</button><button type="button" disabled={selectedCustomerIds.length === 0} onClick={exportSelectedCustomers}>Export CSV</button>
      </form>
      <div className="crm-table-wrap"><table className="crm-table"><thead><tr><th><input type="checkbox" aria-label="Select all visible customers" checked={visibleCustomers.length > 0 && visibleCustomers.every((customer) => selectedCustomerIds.includes(customer.id))} onChange={(event) => setSelectedCustomerIds((current) => event.target.checked ? [...new Set([...current, ...visibleCustomers.map((customer) => customer.id)])] : current.filter((id) => !visibleCustomers.some((customer) => customer.id === id)))} /></th><th>Customer</th><th>Contact</th><th>Owner</th><th>Tags</th><th>Last activity</th><th>Next step</th><th>Actions</th></tr></thead><tbody>{visibleCustomers.map((customer) => <tr key={customer.id}><td><input type="checkbox" aria-label={`Select ${customer.name}`} checked={selectedCustomerIds.includes(customer.id)} onChange={(event) => setSelectedCustomerIds((current) => event.target.checked ? [...current, customer.id] : current.filter((id) => id !== customer.id))} /></td><td><button type="button" className="crm-link" onClick={() => void openProfile(customer)}>{customer.name}</button>{customer.deactivatedAt && <small>Inactive</small>}</td><td>{customer.email ?? ""}<small>{customer.phone ?? ""}</small></td><td>{customer.ownerName ?? "Unassigned"}</td><td>{(customer.tags ?? []).map((tag) => <span className="crm-tag" key={tag}>{tag}</span>)}</td><td>{customer.lastActivityAt ? new Date(customer.lastActivityAt).toLocaleDateString() : "No activity"}</td><td>{customer.nextStep?.summary ?? "-"}</td><td><button type="button" onClick={() => void openProfile(customer)}>Profile</button>{!customer.deactivatedAt && <button type="button" disabled={busy} onClick={() => setDeactivateTarget(customer)}>Deactivate</button>}<button type="button" onClick={() => { setMergeTarget(customer); setMergeSurvivorId(customer.id); }}>Merge</button></td></tr>)}</tbody></table>{visibleCustomers.length === 0 && <p className="crm-empty">No customers match these filters.</p>}</div>
    </section>}

    {tab === "tasks" && <section className="crm-panel" aria-label="Follow-up tasks">
      <header><h2>Follow-up tasks</h2><p>Open work stays attached to the customer record and timeline.</p></header>
      <form className="crm-inline-form" onSubmit={(event) => void createTask(event)}>
        <label>Task<input required maxLength={200} disabled={busy || !taskDraftReady || taskDraftLocked} value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} /></label>
        <label>Due<input type="date" disabled={busy || !taskDraftReady || taskDraftLocked} value={taskDraft.dueAt} onChange={(event) => setTaskDraft({ ...taskDraft, dueAt: event.target.value })} /></label>
        <label>Customer<select disabled={busy || !taskDraftReady || taskDraftLocked} value={taskDraft.customerId} onChange={(event) => setTaskDraft({ ...taskDraft, customerId: event.target.value })}><option value="">No customer</option>{activeCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
        <label>Assignee<select disabled={busy || !taskDraftReady || taskDraftLocked} value={taskDraft.assigneeUserId} onChange={(event) => setTaskDraft({ ...taskDraft, assigneeUserId: event.target.value })}><option value="">Unassigned</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.name ?? member.email}</option>)}</select></label>
        <label>Note<input maxLength={2000} disabled={busy || !taskDraftReady || taskDraftLocked} value={taskDraft.note} onChange={(event) => setTaskDraft({ ...taskDraft, note: event.target.value })} /></label>
        <button disabled={busy || !taskDraftReady}>{taskDraftLocked ? "Retry task" : "Add task"}</button>
      </form>
      {goCrmTaskWrites && !taskDraftReady && <p role="status">CRM is restoring the task draft for the active organization.</p>}
      {goCrmTaskWrites && taskDraftLocked && <p role="status">This task attempt is pending or uncertain. Retry the same task details to resolve it.</p>}
      <div className="crm-task-queue-controls">
        <div role="group" aria-label="Task view">
          <button type="button" aria-pressed={taskFilter === "today"} onClick={() => setTaskFilter("today")}>Today ({dueTodayTasks.length})</button>
          <button type="button" aria-pressed={taskFilter === "overdue"} onClick={() => setTaskFilter("overdue")}>Overdue ({overdueTasks.length})</button>
          <button type="button" aria-pressed={taskFilter === "unassigned"} onClick={() => setTaskFilter("unassigned")}>Unassigned ({unassignedTasks.length})</button>
          <button type="button" aria-pressed={taskFilter === "all"} onClick={() => setTaskFilter("all")}>All ({openTasks.length})</button>
        </div>
        <label className="crm-check"><input type="checkbox" checked={showCompletedTasks} onChange={(event) => setShowCompletedTasks(event.target.checked)} /> Show completed ({completedTasks.length})</label>
      </div>
      <ul className="crm-task-list">
        {visibleTasks.map((task) => <li id={`crm-task-${task.id}`} tabIndex={-1} className={focusedTaskId === task.id ? "crm-task-source-focused" : undefined} key={task.id}>
          {task.doneAt ? <strong>{task.title}</strong> : <label><input type="checkbox" checked={Boolean(task.doneAt)} disabled={busy} onChange={() => void mutate("/api/crm", { action: "completeTask", taskId: task.id }, undefined, () => submitCrmTaskMutation({ action: "completeTask", taskId: task.id }, undefined, goCrmTaskWrites, { actorId, organizationId }))} /> <strong>{task.title}</strong></label>}
          <span>{task.doneAt ? `Completed ${new Date(task.doneAt).toLocaleDateString()}` : task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "No due date"}</span>
          <span>{task.assigneeName ?? "Unassigned"}</span>
          {!task.doneAt && task.refId && <button type="button" onClick={() => { const customer = customers.find((entry) => entry.id === task.refId); if (customer) void openProfile(customer, "activity"); }}>Open customer</button>}
        </li>)}
      </ul>
      {visibleTasks.length === 0 && <p className="crm-empty">No tasks match this view.</p>}
    </section>}

    {selected && <div className="crm-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeProfile(); }}><section className="crm-modal" role="dialog" aria-modal="true" aria-labelledby="crm-profile-title"><header><div><p className="crm-eyebrow">Customer profile</p><h2 id="crm-profile-title">{selected.name}</h2></div><button type="button" aria-label="Close customer profile" onClick={closeProfile}>×</button></header><nav className="crm-profile-tabs" aria-label="Customer profile tabs">{(["overview", "activity", "invoices", "documents"] as const).map((value) => <button type="button" key={value} aria-pressed={profileTab === value} onClick={() => setProfileTab(value)}>{value[0]!.toUpperCase()}{value.slice(1)}</button>)}</nav>
      {profileTab === "overview" ? <><div className="crm-profile-fields"><label>Name<input value={profileDraft.name} onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })} /></label><label>Email<input value={selected.email ?? ""} readOnly /></label><label>Phone<input value={profileDraft.phone} onChange={(event) => setProfileDraft({ ...profileDraft, phone: event.target.value })} /></label><label>Owner<select value={profileDraft.ownerUserId} onChange={(event) => setProfileDraft({ ...profileDraft, ownerUserId: event.target.value })}><option value="">Unassigned</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.name ?? member.email}</option>)}</select></label><label>Preferred contact<select value={profileDraft.preferredContactMethod} onChange={(event) => setProfileDraft({ ...profileDraft, preferredContactMethod: event.target.value as typeof profileDraft.preferredContactMethod })}><option value="email">Email</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option><option value="other">Other</option></select></label><label>Tags, comma separated<input value={profileDraft.tags} onChange={(event) => setProfileDraft({ ...profileDraft, tags: event.target.value })} /></label><label className="crm-check"><input type="checkbox" checked={profileDraft.doNotContact} onChange={(event) => setProfileDraft({ ...profileDraft, doNotContact: event.target.checked })} /> Do not contact</label><label className="crm-span">Notes<textarea value={profileDraft.notes} onChange={(event) => setProfileDraft({ ...profileDraft, notes: event.target.value })} /></label></div><div className="crm-modal-actions"><button type="button" disabled={busy} onClick={() => void saveCustomerProfile()}>Save profile</button><button type="button" onClick={() => { setTaskDraft({ ...taskDraft, customerId: selected.id, title: `Follow up with ${selected.name}` }); navigateToTab("tasks"); }}>Create follow-up</button><button type="button" onClick={() => setProfileTab("activity")}>View history</button></div>{selected.nextStep && <p className="crm-next-step">Next step: {selected.nextStep.summary}</p>}<section className="crm-follow-up-draft" aria-label="AI follow-up draft"><header><div><h3>Follow-up draft</h3><p>Use recent CRM records as context, then review and edit before outreach.</p></div><button type="button" disabled={selected.doNotContact || draftState.status === "loading"} onClick={() => void generateFollowUpDraft()}>{draftState.status === "loading" ? "Drafting…" : draftState.status === "ready" ? "Regenerate draft" : "Draft with AI"}</button></header>{selected.doNotContact ? <p className="crm-draft-warning">This customer is marked do not contact. Drafting and outreach shortcuts are disabled.</p> : draftState.status === "loading" ? <p role="status">Reviewing recent invoices, quotes, and follow-ups…</p> : draftState.status === "failed" ? <p role="alert" className="crm-draft-warning">{draftState.message}</p> : draftState.status === "ready" ? <><label>Subject<input value={draftState.subject} maxLength={180} onChange={(event) => setDraftState({ ...draftState, subject: event.target.value })} /></label><label>Message<textarea value={draftState.body} maxLength={4000} onChange={(event) => setDraftState({ ...draftState, body: event.target.value })} /></label><p className="crm-source-heading">Records used</p><ul className="crm-draft-sources">{draftState.draft.sources.map((source) => <li key={`${source.kind}-${source.refId}`}><button type="button" onClick={() => openDraftSource(source)}><strong>{source.kind}</strong><span>{source.summary}</span><small>{new Date(source.date).toLocaleDateString()}, open related record</small></button></li>)}</ul><button type="button" onClick={() => void copyFollowUpDraft()}>{draftCopied ? "Copied" : "Copy draft"}</button></> : <p>Generate a draft from recent invoices, quotes, and follow-up tasks.</p>}</section></> : <div className="crm-timeline" aria-live="polite">{timeline.filter((entry) => profileTab === "activity" || (profileTab === "invoices" ? ["invoice", "payment", "quote"].includes(entry.kind) : entry.kind === "document")).map((entry) => <article key={`${entry.kind}-${entry.refId}`}><span>{new Date(entry.date).toLocaleString()}</span><strong>{entry.kind}</strong><p>{entry.summary}</p></article>)}{timeline.length === 0 && <p>No {profileTab === "invoices" ? "invoice or payment" : profileTab === "documents" ? "document" : "activity"} history is available.</p>}</div>}
    </section></div>}

    {moveTarget && <div className="crm-modal-backdrop"><section className="crm-modal crm-confirm" role="dialog" aria-modal="true" aria-labelledby="crm-lost-title"><h2 id="crm-lost-title">{moveTarget.stage === "lost" ? `Mark “${moveTarget.deal.title}” as lost?` : `Move “${moveTarget.deal.title}” to ${stageLabels[moveTarget.stage]}?`}</h2><p>{moveTarget.stage === "lost" ? "Record why the deal was lost. This will be included in its audit history." : "This stage change updates the weighted pipeline forecast."}</p>{moveTarget.stage === "lost" && <label>Lost reason<textarea required maxLength={500} autoFocus value={lostReason} onChange={(event) => setLostReason(event.target.value)} /></label>}<footer><button type="button" disabled={busy} onClick={() => { setMoveTarget(null); setLostReason(""); }}>Cancel</button><button type="button" disabled={busy || (moveTarget.stage === "lost" && (lostReason.trim().length < 3 || lostReason.trim().length > 500))} onClick={() => void moveDeal(moveTarget.deal, moveTarget.stage, lostReason)}>{moveTarget.stage === "lost" ? "Confirm lost" : `Move to ${stageLabels[moveTarget.stage]}`}</button></footer></section></div>}

    {convertTarget && <div className="crm-modal-backdrop"><section className="crm-modal crm-confirm" role="dialog" aria-modal="true" aria-labelledby="crm-convert-title"><h2 id="crm-convert-title">Convert lead</h2><p>Qualify “{convertTarget.title}” and link it to a new or existing customer.</p><div className="crm-convert-modes"><button type="button" aria-pressed={convertMode === "new"} onClick={() => setConvertMode("new")}>Create customer</button><button type="button" aria-pressed={convertMode === "existing"} onClick={() => setConvertMode("existing")}>Use existing customer</button></div>{convertMode === "new" ? <label>Customer name<input autoFocus required value={convertCustomerName} onChange={(event) => setConvertCustomerName(event.target.value)} /></label> : <label>Customer<select value={convertCustomerId} onChange={(event) => setConvertCustomerId(event.target.value)}><option value="">Choose a customer</option>{activeCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>}<footer><button type="button" onClick={() => setConvertTarget(null)}>Cancel</button><button type="button" disabled={busy || (convertMode === "new" ? !convertCustomerName.trim() : !convertCustomerId)} onClick={() => void convertLead()}>Convert lead</button></footer></section></div>}

    {mergeTarget && <div className="crm-modal-backdrop"><section className="crm-modal crm-confirm" role="dialog" aria-modal="true" aria-labelledby="crm-merge-title"><h2 id="crm-merge-title">Merge customer records</h2><p>Linked history is retained on the surviving customer. The merge can be undone from its confirmation.</p><label>Duplicate record<select value={mergeTarget.id} onChange={(event) => { const found = customers.find((customer) => customer.id === event.target.value); if (found) setMergeTarget(found); }}><option value={mergeTarget.id}>{mergeTarget.name}</option>{customers.filter((customer) => customer.id !== mergeTarget.id && !customer.deactivatedAt).map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label><label>Keep this customer<select value={mergeSurvivorId} onChange={(event) => setMergeSurvivorId(event.target.value)}>{customers.filter((customer) => customer.id !== mergeTarget.id && !customer.deactivatedAt).map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label><footer><button type="button" onClick={() => setMergeTarget(null)}>Cancel</button><button type="button" disabled={busy || !mergeSurvivorId || mergeSurvivorId === mergeTarget.id} onClick={() => void mutate("/api/customers", { action: "merge", survivorCustomerId: mergeSurvivorId, duplicateCustomerId: mergeTarget.id }, (data) => { setMergeUndo(data); setMergeTarget(null); })}>Merge records</button></footer></section></div>}
    {mergeUndo && <div className="crm-notice crm-notice-success" role="status">Customer records merged. <button type="button" onClick={() => void mutate("/api/customers", { action: "undoMerge", ...mergeUndo }, () => setMergeUndo(null))}>Undo merge</button></div>}
    {deactivateTarget && <div className="crm-modal-backdrop"><section className="crm-modal crm-confirm" role="dialog" aria-modal="true" aria-labelledby="crm-deactivate-title"><h2 id="crm-deactivate-title">Deactivate {deactivateTarget.name}?</h2><p>This removes the customer from active pickers and agent lookups. Existing invoices and history stay available.</p><footer><button type="button" onClick={() => setDeactivateTarget(null)}>Cancel</button><button type="button" disabled={busy} onClick={() => void mutate("/api/customers", { action: "deactivate", customerId: deactivateTarget.id }, () => setDeactivateTarget(null))}>Deactivate customer</button></footer></section></div>}

    {importOpen && <div className="crm-modal-backdrop"><section className="crm-modal crm-import-modal" role="dialog" aria-modal="true" aria-labelledby="crm-import-title"><header><div><p className="crm-eyebrow">Customer data</p><h2 id="crm-import-title">Import customers</h2></div><button type="button" onClick={() => setImportOpen(false)} aria-label="Close import">×</button></header>{importSummary ? <div><p role="status">{importSummary.undone ? "Import undone." : `${importSummary.imported} customers imported, ${importSummary.skipped} duplicates skipped.`}</p>{!importSummary.undone && importSummary.ids.length > 0 && <button type="button" disabled={busy} onClick={() => void undoImport()}>Undo this import</button>}<button type="button" onClick={() => setImportOpen(false)}>Done</button></div> : <><div className="crm-import-start"><p>Map your columns, review likely matches, then fix invalid rows before adding customers.</p><button type="button" onClick={downloadCustomerTemplate}>Download template</button><label className="crm-file">{importRows.length ? "Choose another CSV" : "Choose CSV"}<input type="file" accept=".csv,text/csv" onChange={(event) => void readImport(event.target.files?.[0])} /></label></div>{importHeaders.length > 0 && <><div className="crm-import-mapping" aria-label="Column mapping">{(["name", "email", "phone"] as const).map((field) => <label key={field}>Map {field}<select aria-label={`Map ${field}`} value={importMapping[field]} onChange={(event) => updateImportMapping(field, event.target.value)}><option value={-1}>Do not import</option>{importHeaders.map((header, index) => <option key={`${field}-${index}`} value={index}>{header || "Unnamed column"}</option>)}</select></label>)}</div><div className="crm-import-summary"><span>{importRows.length} rows, {importRows.filter((row) => !row.error).length} valid, {importRows.filter((row) => row.duplicate).length} possible duplicates.</span><span>{selectedImportCount} selected to import</span><span>Rows {importPage * importPageSize + 1}-{Math.min((importPage + 1) * importPageSize, importRows.length)} of {importRows.length}</span></div><div className="crm-import-pagination"><button type="button" disabled={importPage === 0} onClick={() => setImportPage((page) => Math.max(0, page - 1))}>Previous</button><button type="button" disabled={(importPage + 1) * importPageSize >= importRows.length} onClick={() => setImportPage((page) => page + 1)}>Next</button></div><div className="crm-import-rows">{visibleImportRows.map((row, localIndex) => { const index = importPage * importPageSize + localIndex; return <article key={row.rowNumber}><label><input type="checkbox" disabled={Boolean(row.error)} checked={row.include} onChange={(event) => setImportRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, include: event.target.checked, includeExplicit: true } : item))} /> Row {row.rowNumber}</label><input aria-label={`Row ${row.rowNumber} name`} value={row.name} onChange={(event) => editImportRow(index, "name", event.target.value)} /><input aria-label={`Row ${row.rowNumber} email`} value={row.email} onChange={(event) => editImportRow(index, "email", event.target.value)} /><input aria-label={`Row ${row.rowNumber} phone`} value={row.phone} onChange={(event) => editImportRow(index, "phone", event.target.value)} />{row.error && <span role="alert">{row.error}</span>}{row.duplicate && <label><input type="checkbox" checked={row.allowDuplicate} onChange={(event) => setImportRows((current) => validateImportRows(current.map((item, rowIndex) => rowIndex === index ? { ...item, allowDuplicate: event.target.checked, include: event.target.checked, includeExplicit: true } : item), customers))} />{row.duplicate}, import anyway</label>}</article>; })}</div><button type="button" disabled={busy || selectedImportCount === 0} onClick={() => void submitImport()}>Import {selectedImportCount} customers</button></>}</>}</section></div>}
  </main>;
}

export default CRMPage;
