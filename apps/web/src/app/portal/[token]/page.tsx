import { Suspense } from "react";
import { PortalInvoiceContent, PortalLoading } from "./portal-content";

/**
 * Public read-only invoice view. Reached only through a revocable share
 * link (192-bit token); the API behind it exposes nothing else about the
 * organization. No chrome, no navigation, no links out.
 *
 * The token is dynamic, so the params read sits inside Suspense: the shell
 * prerenders and the invoice content streams once the token is known.
 */
export default function PortalInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<PortalLoading />}>
      <PortalInvoiceContent params={params} />
    </Suspense>
  );
}
