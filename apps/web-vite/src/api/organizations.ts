import { z } from "zod";

const OrganizationResponseSchema = z.object({
  activeOrgId: z.string().uuid().nullable(),
  orgs: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    baseCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  })),
});

const SwitchResponseSchema = z.object({ ok: z.literal(true) });
const REQUEST_TIMEOUT_MS = 12_000;

export type Organization = z.infer<typeof OrganizationResponseSchema>["orgs"][number];
export type OrganizationList = z.infer<typeof OrganizationResponseSchema>;

export class OrganizationApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OrganizationApiError";
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new OrganizationApiError(response.status, "The organization service returned an invalid response.");
  }
}

function errorForStatus(status: number): OrganizationApiError {
  if (status === 401) return new OrganizationApiError(status, "Sign in to the existing application to view your organizations.");
  if (status === 403) return new OrganizationApiError(status, "Your account or organization access needs attention.");
  return new OrganizationApiError(status, "The organization service is unavailable. Try again.");
}

export async function fetchOrganizations(signal?: AbortSignal): Promise<OrganizationList> {
  const response = await fetch("/api/org", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: requestSignal(signal),
  });
  if (!response.ok) throw errorForStatus(response.status);

  const result = OrganizationResponseSchema.safeParse(await readJson(response));
  if (!result.success) throw new OrganizationApiError(response.status, "The organization service returned an invalid response.");
  return result.data;
}

export async function switchActiveOrganization(orgId: string): Promise<void> {
  const response = await fetch("/api/org", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ orgId }),
    signal: requestSignal(),
  });
  if (!response.ok) throw errorForStatus(response.status);

  const result = SwitchResponseSchema.safeParse(await readJson(response));
  if (!result.success) throw new OrganizationApiError(response.status, "The organization service returned an invalid response.");
}
