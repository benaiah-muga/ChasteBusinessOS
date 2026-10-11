export function allowsPendingAuthOwner(kind, path, owner, parity) {
  return kind === "api"
    && path === "/api/auth/[...all]"
    && owner === "auth"
    && parity === "pending";
}
