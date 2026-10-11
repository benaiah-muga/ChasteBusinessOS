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
