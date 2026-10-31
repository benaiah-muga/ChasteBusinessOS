import { z } from "zod";

const PreferencesSchema = z.object({
  kinds: z.array(z.string().min(1)),
  mutedKinds: z.array(z.string().min(1)),
});

export type NotificationPreferences = z.infer<typeof PreferencesSchema>;

export class NotificationPreferencesError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit): Promise<NotificationPreferences> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
    });
  } catch {
    throw new NotificationPreferencesError(0, "Could not reach notification preferences. Check your connection and try again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new NotificationPreferencesError(response.status, response.status === 401 ? "Your session has ended. Sign in again." : body?.error || "Notification preferences could not be saved.");
  }
  const parsed = PreferencesSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new NotificationPreferencesError(200, "Notification preferences returned an unexpected response.");
  return parsed.data;
}

export function fetchNotificationPreferences(signal?: AbortSignal): Promise<NotificationPreferences> {
  return request("/api/notification-preferences", { method: "GET", signal });
}

export function saveNotificationPreferences(mutedKinds: string[], signal?: AbortSignal): Promise<NotificationPreferences> {
  return request("/api/notification-preferences", {
    method: "PUT",
    body: JSON.stringify({ mutedKinds }),
    signal,
  });
}
