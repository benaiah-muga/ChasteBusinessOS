"use client";

import { useState } from "react";
import { getApiBaseUrl } from "@/lib/api";

export function CreateVendorForm() {
  const [name, setName] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`${getApiBaseUrl()}/api/v1/purchasing/vendors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    window.location.reload();
  }

  return (
    <form className="row" onSubmit={submit}>
      <input
        style={{ flex: 1 }}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Vendor name"
        required
      />
      <button className="btn" type="submit">
        Add vendor
      </button>
    </form>
  );
}
