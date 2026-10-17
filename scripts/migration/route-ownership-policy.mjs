export function allowsPendingAuthOwner(kind, path, owner, parity) {
  return kind === "api"
    && path === "/api/auth/[...all]"
    && owner === "auth"
    && parity === "pending";
}

export function allowsPendingGoOrgPersonaOwner(kind, path, method, owner, parity) {
  return kind === "api"
    && path === "/api/org"
    && ["PUT", "PATCH"].includes(method)
    && owner === "go"
    && parity === "pending";
}

export function allowsPendingGoRoutineCollectionOwner(kind, path, method, owner, parity) {
  return kind === "api"
    && path === "/api/routines"
    && ["GET", "POST"].includes(method)
    && owner === "go"
    && parity === "pending";
}

export function allowsPendingGoMemoryCollectionOwner(kind, path, method, owner, parity) {
  return kind === "api"
    && path === "/api/memory"
    && ["GET", "POST"].includes(method)
    && owner === "go"
    && parity === "pending";
}

export function allowsPendingGoModuleSettingsOwner(kind, path, method, owner, parity) {
  return kind === "api"
    && path === "/api/module-settings"
    && ["GET", "POST"].includes(method)
    && owner === "go"
    && parity === "pending";
}

export function allowsPendingGoPolicyOwner(kind, path, method, owner, parity) {
  return kind === "api"
    && path === "/api/policy"
    && ["GET", "POST"].includes(method)
    && owner === "go"
    && parity === "pending";
}

export function allowsPendingGoAttachmentDownloadOwner(kind, path, method, owner, parity) {
  return kind === "api"
    && path === "/api/message-attachments/[id]"
    && method === "GET"
    && owner === "go"
    && parity === "pending";
}

export function allowsPendingGoMessagingAgentOwner(kind, path, method, owner, parity) {
  return kind === "api"
    && path === "/api/conversations/[id]/agent-reply"
    && method === "POST"
    && owner === "go"
    && parity === "pending";
}

// Wave 3 ports legacy collection routes to Go handlers that are mounted by
// default but not yet parity-verified against the legacy runtime.
const pendingGoWave3Routes = new Set([
  "GET /api/conversations",
  "POST /api/conversations",
  "PATCH /api/conversations/[id]",
  "GET /api/conversations/[id]/messages",
  "POST /api/conversations/[id]/messages",
  "POST /api/conversations/[id]/read",
  "GET /api/conversations/people",
  "POST /api/conversations/[id]/attachments",
  "DELETE /api/conversations/[id]/attachments",
  "PATCH /api/messages/[id]",
  "DELETE /api/messages/[id]",
  "PATCH /api/messages/[id]/pin",
  "POST /api/messages/[id]/reactions",
  "GET /api/messages/search",
  "GET /api/docs",
  "POST /api/docs",
  "GET /api/docs/[id]",
  "POST /api/docs/[id]",
  "GET /api/docs/folders",
  "POST /api/docs/folders",
  "GET /api/docs/next-number",
  "GET /api/docs/records",
  "GET /api/documents",
  "POST /api/documents",
  "GET /api/documents/[id]/content",
  "POST /api/crm",
  "GET /api/crm/views",
  "POST /api/crm/views",
  "POST /api/customers",
  "GET /api/deals",
  "POST /api/deals",
  "POST /api/import",
  "GET /api/purchasing",
  "POST /api/purchasing",
  "GET /api/purchasing/payment-runs",
  "POST /api/purchasing/payment-runs",
]);

export function allowsPendingGoWave3Owner(kind, path, method, owner, parity) {
  return kind === "api"
    && owner === "go"
    && parity === "pending"
    && pendingGoWave3Routes.has(`${method} ${path}`);
}
