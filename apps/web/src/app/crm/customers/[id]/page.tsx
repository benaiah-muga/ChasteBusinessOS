import { AppShell } from "@/components/AppShell";
import { CustomerDetail } from "@/components/crm/CustomerDetail";
import { getApiClient } from "@/lib/api";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const api = getApiClient();

  let customer;
  try {
    customer = await api.getCustomer(id);
  } catch {
    notFound();
  }

  const [contacts, interactions] = await Promise.all([
    api.listContacts(id).catch(() => ({ items: [] })),
    api.listInteractions(id).catch(() => ({ items: [] })),
  ]);

  return (
    <AppShell subtitle={`Customer · ${customer.name}`}>
      <CustomerDetail
        initialCustomer={customer}
        initialContacts={contacts.items}
        initialInteractions={interactions.items}
      />
    </AppShell>
  );
}
