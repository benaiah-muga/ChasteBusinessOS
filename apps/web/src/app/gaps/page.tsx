import { redirect } from "next/navigation";

export default function GapsRedirect() {
  redirect("/extensions?tab=gaps");
}
