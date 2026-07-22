import { AppShell } from "@/components/AppShell";
import { AccountingWorkspace } from "@/components/accounting/AccountingWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function AccountingPage() {
  const api = getApiClient();
  let accounts: Awaited<ReturnType<typeof api.listAccounts>>["items"] = [];
  let invoices: Awaited<ReturnType<typeof api.listInvoices>>["items"] = [];
  try {
    const [a, i] = await Promise.all([api.listAccounts(), api.listInvoices()]);
    accounts = a.items;
    invoices = i.items;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Chart of accounts, invoices, and financial overview.">
      <AccountingWorkspace initialAccounts={accounts} initialInvoices={invoices} />
    </AppShell>
  );
}
