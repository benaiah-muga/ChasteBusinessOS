import { redirect } from "next/navigation";

export default function MarketplaceRedirect() {
  redirect("/extensions?tab=marketplace");
}
