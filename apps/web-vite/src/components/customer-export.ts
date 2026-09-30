export type CustomerExportRow = {
  id: string;
  name: string;
  email?: string | null;
  ownerName?: string | null;
  tags?: string[] | null;
  deactivatedAt?: string | null;
};

function csvCell(raw: string): string {
  const safeValue = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

export function selectedCustomersCsv(customers: CustomerExportRow[], selectedIds: string[]): string {
  const selected = new Set(selectedIds);
  const rows = customers.filter((customer) => selected.has(customer.id));
  return [
    "Name,Email,Owner,Tags,Status",
    ...rows.map((customer) => [
      customer.name,
      customer.email ?? "",
      customer.ownerName ?? "",
      (customer.tags ?? []).join("; "),
      customer.deactivatedAt ? "Inactive" : "Active",
    ].map(csvCell).join(",")),
  ].join("\n");
}
