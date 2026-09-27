import { afterEach, describe, expect, it, vi } from "vitest";
import { setPrefs } from "./prefs";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("display currency bridge", () => {
  it("mirrors the device display currency into a same-host preference cookie", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const document = { cookie: "" };
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("document", document);

    setPrefs({ currency: "UGX" });

    expect(document.cookie).toBe("chaste_display_currency=UGX; Path=/; Max-Age=31536000; SameSite=Lax");
    expect(storage.setItem).toHaveBeenCalledWith(
      "chaste-prefs",
      JSON.stringify({
        currency: "UGX",
        units: "metric",
        dateFormat: "dmy",
        weekStart: "mon",
        writingAids: true,
      }),
    );
  });
});
