import { z } from "zod";

const NotificationSchema = z.object({
  id: z.string().min(1),
  kind: z.string(),
  title: z.string(),
  href: z.string().nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const NotificationsResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  unreadCount: z.number().int().nonnegative(),
});

export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationsResponse = z.infer<typeof NotificationsResponseSchema>;

export class NotificationsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "NotificationsApiError";
  }
}

async function errorMessage(response: Response): Promise<string> {
  if (response.status === 401) return "Your session has ended. Sign in again to continue.";
  if (response.status === 403) return "You do not have permission to view notifications.";
  if (response.status >= 500) return "The notifications service is unavailable. Try again.";
  return "The notifications request could not be completed. Try again.";
}

export async function fetchNotifications(signal?: AbortSignal): Promise<NotificationsResponse> {
  let response: Response;
  try {
    response = await fetch("/api/notifications?limit=20", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new NotificationsApiError(0, "Could not reach notifications. Check your connection and try again.");
  }

  if (!response.ok) throw new NotificationsApiError(response.status, await errorMessage(response));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new NotificationsApiError(response.status, "The notifications service returned an unreadable response.");
  }
  const parsed = NotificationsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new NotificationsApiError(response.status, "The notifications service returned data in an unexpected format.");
  }
  return parsed.data;
}

export async function markNotificationRead(id: string, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/notifications", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ id }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new NotificationsApiError(0, "Could not update this notification. Check your connection and try again.");
  }
  if (!response.ok) throw new NotificationsApiError(response.status, await errorMessage(response));
}

export function safeNotificationHref(href: string | null): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//") || href.startsWith("/\\")) return null;
  try {
    const parsed = new URL(href, window.location.origin);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null;
  } catch {
    return null;
  }
}
