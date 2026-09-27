import { describe, expect, it } from "vitest";
import { authTrustedOrigins } from "./auth-origins";

describe("Better Auth trusted origins", () => {
  it("allows the legacy compatibility app only during development", () => {
    expect(authTrustedOrigins({ appUrl: "http://localhost:3000", isDevelopment: true })).toEqual([
      "http://localhost:3000",
      "http://localhost:3001",
    ]);
    expect(authTrustedOrigins({ appUrl: "https://business.example", isDevelopment: false })).toEqual([
      "https://business.example",
    ]);
  });

  it("does not duplicate the legacy compatibility origin", () => {
    expect(authTrustedOrigins({ appUrl: "http://localhost:3001", isDevelopment: true })).toEqual([
      "http://localhost:3001",
    ]);
  });
});
