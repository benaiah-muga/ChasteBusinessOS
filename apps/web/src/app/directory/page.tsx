import { AppShell } from "@/components/AppShell";
import { DirectoryWorkspace } from "@/components/directory/DirectoryWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function DirectoryPage() {
  const api = getApiClient();
  let partners: Awaited<ReturnType<typeof api.listBusinessPartners>>["items"] = [];
  try {
    partners = (await api.listBusinessPartners()).items;
  } catch {
    /* empty */
  }
  return (
    <AppShell subtitle="Customers, vendors, employees & contacts — one shared identity per party.">
      <DirectoryWorkspace initialPartners={partners} />
    </AppShell>
  );
}
