import { describe, expect, it } from "vitest";
import { workmateLoginReturnHref } from "./workmate-return";

describe("workmate login return path", () => {
  it("returns the selected home prompt after authentication", () => {
    const prompt = "Draft an invoice for a customer. Ask me for the details you need.";
    expect(workmateLoginReturnHref(`?workmatePrompt=${encodeURIComponent(prompt)}`))
      .toBe(`/?workmatePrompt=${encodeURIComponent(prompt)}`);
  });

  it("keeps redirects on the home route and omits absent prompts", () => {
    expect(workmateLoginReturnHref("?workmatePrompt=https%3A%2F%2Fevil.example%2F"))
      .toBe("/?workmatePrompt=https%3A%2F%2Fevil.example%2F");
    expect(workmateLoginReturnHref("?next=https%3A%2F%2Fevil.example%2F")).toBe("/");
  });
});
