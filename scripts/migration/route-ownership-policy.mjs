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
