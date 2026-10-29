import { describe, expect, it } from "vitest";
import { actionTitle, humanizeFieldKey, previewFields, safePayload } from "./approval-payload";

describe("approval payload presentation", () => {
  it("hides credential-shaped fields from a preview", () => {
    const fields = previewFields({
      name: "Card Check Ltd",
      email: "card@check.test",
      apiKey: "should-not-render",
      encryptedApiKey: "should-not-render",
      sessionId: "internal",
      intentId: "internal",
    });
    expect(fields.map(([key]) => key)).toEqual(["name", "email"]);
  });

  it("hides credential-shaped fields from the technical payload", () => {
    const payload = safePayload({ name: "Card Check Ltd", credential: "secret", nested: { token: "secret", note: "kept" } }) as Record<string, unknown>;
    expect(payload.credential).toBe("[hidden]");
    expect(payload.name).toBe("Card Check Ltd");
    expect((payload.nested as Record<string, unknown>).token).toBe("[hidden]");
    expect((payload.nested as Record<string, unknown>).note).toBe("kept");
  });

  it("labels capability ids and payload keys in sentence case", () => {
    expect(actionTitle("crm.createCustomer")).toBe("Create Customer");
    expect(actionTitle("purchasing.createPurchaseOrder")).toBe("Create Purchase Order");
    expect(humanizeFieldKey("unitPriceMinor")).toBe("Unit price minor");
    expect(humanizeFieldKey("doNotContact")).toBe("Do not contact");
    expect(humanizeFieldKey("customerId")).toBe("Customer ID");
    expect(humanizeFieldKey("skus")).toBe("Skus");
  });

  it("treats non-object payloads as empty", () => {
    expect(previewFields(null)).toEqual([]);
    expect(previewFields([1, 2, 3])).toEqual([]);
  });
});
