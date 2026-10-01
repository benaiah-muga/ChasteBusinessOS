import { describe, expect, it } from "vitest";
import { documentContentHeaders } from "./[id]/content/route";

describe("document content response policy", () => {
  it("forces active and unknown formats to download as inert bytes", () => {
    for (const mimeType of ["text/html", "image/svg+xml", "application/pdf", "application/javascript", "text/html; charset=utf-8"]) {
      const headers = documentContentHeaders(mimeType, "Invoice <script>.html");
      expect(headers.get("content-type")).toBe("application/octet-stream");
      expect(headers.get("content-disposition")).toBe('attachment; filename="Invoice-script-.html"');
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("content-security-policy")).toContain("sandbox");
    }
  });

  it("keeps passive image and plain-text previews sandboxed", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain; charset=utf-8"]) {
      const headers = documentContentHeaders(mimeType, "Supplier file.pdf");
      expect(headers.get("content-type")).toBe(mimeType.split(";", 1)[0]);
      expect(headers.get("content-disposition")).toBe('inline; filename="Supplier-file.pdf"');
      expect(headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    }
  });
});
