import { z } from "zod";

const InvitationPreviewSchema = z.object({
  email: z.string().email(),
  orgName: z.string().min(1),
  roleName: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

const AcceptInvitationSchema = z.object({ ok: z.literal(true) });

export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;

export class InvitationApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InvitationApiError";
  }
}

async function request<T>(token: string, method: "GET" | "POST", schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/auth/invitations/${encodeURIComponent(token)}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
  } catch {
    throw new InvitationApiError(0, "Could not reach the authentication service. Check your connection and try again.");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.string().optional(), message: z.string().optional() }).safeParse(payload);
    const message = error.success ? (error.data.error ?? error.data.message) : undefined;
    throw new InvitationApiError(response.status, message ?? "The invitation request could not be completed.");
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new InvitationApiError(response.status, "The authentication service returned an unexpected response.");
  }
  return parsed.data;
}

export const invitationsApi = {
  preview(token: string): Promise<InvitationPreview> {
    return request(token, "GET", InvitationPreviewSchema);
  },
  accept(token: string): Promise<{ ok: true }> {
    return request(token, "POST", AcceptInvitationSchema);
  },
};
