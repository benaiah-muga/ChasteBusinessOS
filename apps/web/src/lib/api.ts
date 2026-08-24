/**
 * Single seam between the UI and the API. Every response becomes either data
 * or a structured AppError whose `title`/`hint` are safe, human copy, while
 * `detail` preserves the raw wire truth for power users to inspect and copy.
 */
export interface AppError {
  /** Short, calm headline, what happened, in product language. */
  title: string;
  /** What the user can do about it. */
  hint: string;
  /** Raw status, endpoint and payload, collapsed behind "Technical details". */
  detail?: string;
}

export interface ApiResult<T> {
  ok: boolean;
  /** 202 means the action is gated and waiting for human approval. */
  status: number;
  data: T | null;
  error?: AppError;
}

function detailFor(method: string, url: string, status: number, raw: unknown): string {
  const body = typeof raw === "string" ? raw : JSON.stringify(raw);
  return `${method} ${url} → ${status}\n${body}`;
}

/** Maps known domain/server phrases to copy a business user can act on. */
function friendlyFromMessage(msg: string): { title: string; hint: string } | null {
  const m = msg.toLowerCase();
  if (/period .* (is )?closed|sealed/.test(m))
    return { title: "That period is sealed", hint: "Closed months refuse new postings. Reopen the period first, reopening is a gated action." };
  if (/unbalanc/.test(m))
    return { title: "The books must stay balanced", hint: "This entry wouldn't net to zero. Check the amounts and try again." };
  if (/overpay/.test(m))
    return { title: "Payment exceeds the outstanding amount", hint: "Payments above the balance are blocked to protect your books." };
  if (/already (executed|approved|rejected|decided)/.test(m))
    return { title: "This was already handled", hint: "Someone decided this first. Refresh to see the latest state." };
  if (/lack(s)? (authority|permission)|not permitted|forbidden/.test(m))
    return { title: "You don't have permission for this", hint: "Ask someone with the right role to perform it, role changes go through Approvals." };
  if (/threshold|approval required|needs? (human )?approval/.test(m))
    return { title: "This needs human approval", hint: "It's larger than policy allows autonomously, find it in the Approvals inbox." };
  if (/insufficient|not enough/.test(m))
    return { title: "Not enough to complete this", hint: "Check the amounts and available balance." };
  if (/^invalid body$/.test(m))
    return { title: "Some details are missing or malformed", hint: "Double-check the form fields and try again." };
  if (/required|must be|invalid|expected/.test(m) && m.length < 140)
    return { title: "Check the details", hint: msg.charAt(0).toUpperCase() + msg.slice(1) };
  return null;
}

function mapError(method: string, url: string, status: number, raw: unknown): AppError {
  const serverMsg =
    typeof raw === "object" && raw !== null
      ? String((raw as Record<string, unknown>).error ?? (raw as Record<string, unknown>).message ?? "")
      : String(raw ?? "");
  const detail = detailFor(method, url, status, raw);

  const fromDomain = serverMsg ? friendlyFromMessage(serverMsg) : null;
  if (fromDomain) return { ...fromDomain, detail };

  switch (true) {
    case status === 401:
      return { title: "Your session ended", hint: "Sign in again to continue.", detail };
    case status === 403:
      return { title: "You don't have permission for this", hint: "Ask someone with the right role, role changes always require approval.", detail };
    case status === 404:
      return { title: "That record no longer exists", hint: "It may have been removed or belongs to a different workspace.", detail };
    case status === 409:
      return { title: "This was already handled", hint: "Refresh to see the latest state.", detail };
    case status === 429:
      return { title: "Too many requests", hint: "Wait a moment and try again.", detail };
    case status >= 500:
      return { title: "Something went wrong on our side", hint: "Nothing was changed. Try again in a moment, details below if it persists.", detail };
    default:
      if (serverMsg && serverMsg.length <= 140 && /[a-z]/i.test(serverMsg) && !/[{}<>]/.test(serverMsg)) {
        return { title: "That didn't work", hint: serverMsg.charAt(0).toUpperCase() + serverMsg.slice(1), detail };
      }
      return { title: "That didn't work", hint: "Try again, technical details are below if you need them.", detail };
  }
}

const NETWORK_ERROR: AppError = {
  title: "Can't reach the server",
  hint: "Check your connection and try again.",
};

/** Fetch wrapper: never throws, resolves data or a structured AppError. */
export async function callApi<T = unknown>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const method = init?.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: { ...NETWORK_ERROR, detail: `${method} ${url} → network\n${String(err)}` },
    };
  }

  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    raw = null;
  }

  // 202 = governed action parked for human approval, success-shaped for callers.
  if (res.ok || res.status === 202) {
    return { ok: true, status: res.status, data: raw as T };
  }
  return { ok: false, status: res.status, data: null, error: mapError(method, url, res.status, raw) };
}

export function postApi<T = unknown>(url: string, body: unknown): Promise<ApiResult<T>> {
  return callApi<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
