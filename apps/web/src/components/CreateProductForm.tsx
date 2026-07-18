"use client";

import { useState } from "react";
import { getApiBaseUrl } from "@/lib/api";

export function CreateProductForm() {
  const [sku, setSku] = useState(`SKU-${Date.now().toString().slice(-5)}`);
  const [name, setName] = useState("Widget");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`${getApiBaseUrl()}/api/v1/inventory/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku, name }),
    });
    window.location.reload();
  }

  return (
    <form className="row" onSubmit={submit}>
      <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" required />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required />
      <button className="btn" type="submit">
        Add product
      </button>
    </form>
  );
}
