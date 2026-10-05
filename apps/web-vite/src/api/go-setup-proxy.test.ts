import { describe, expect, it } from "vitest";
import { isGoSetupRequest } from "./go-setup-proxy";

describe("Go setup proxy selection", () => {
  it.each([
    ["GET", "/api/setup"],
    ["GET", "/api/setup?source=dashboard"],
  ])("routes supported %s %s requests to Go", (method, url) => {
    expect(isGoSetupRequest(method, url)).toBe(true);
  });

  it.each([
    ["POST", "/api/setup"],
    ["GET", "/api/setup/extra"],
    ["GET", "/api/setup/"],
    ["GET", "/api/setupper"],
  ])("leaves unsupported %s %s requests with legacy", (method, url) => {
    expect(isGoSetupRequest(method, url)).toBe(false);
  });
});
