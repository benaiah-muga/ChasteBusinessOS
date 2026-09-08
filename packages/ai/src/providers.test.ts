import { afterEach, describe, expect, it } from "vitest";
import { nimClient, resolveClient, stripProviderPrefix, zaiClient } from "./providers";

const ENV_KEYS = ["MODEL_PROVIDER", "ZAI_API_KEY", "ZAI_BASE_URL", "GROQ_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "NVIDIA_API_KEY", "NIM_BASE_URL"] as const;

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => {
  // nothing persistent; withEnv restores per call
});

describe("stripProviderPrefix", () => {
  it("strips every known provider prefix", () => {
    expect(stripProviderPrefix("openrouter/acme/x")).toBe("acme/x");
    expect(stripProviderPrefix("groq/llama-3")).toBe("llama-3");
    expect(stripProviderPrefix("mistral/large")).toBe("large");
    expect(stripProviderPrefix("zai/glm-4.7-flash")).toBe("glm-4.7-flash");
    expect(stripProviderPrefix("moonshotai/kimi-k2.6")).toBe("moonshotai/kimi-k2.6");
  });
});

describe("resolveClient", () => {
  it("routes MODEL_PROVIDER=zai through the Z.ai endpoint", () => {
    withEnv({ MODEL_PROVIDER: "zai", ZAI_API_KEY: "k" }, () => {
      expect(resolveClient().baseURL).toBe("https://api.z.ai/api/paas/v4");
    });
  });

  it("routes a zai/ model prefix regardless of MODEL_PROVIDER", () => {
    withEnv({ ZAI_API_KEY: "k", MODEL_PROVIDER: "groq", GROQ_API_KEY: "g" }, () => {
      expect(resolveClient("zai/glm-4.7-flash").baseURL).toContain("api.z.ai");
    });
  });

  it("honors a ZAI_BASE_URL override (bigmodel endpoint)", () => {
    withEnv({ MODEL_PROVIDER: "zai", ZAI_API_KEY: "k", ZAI_BASE_URL: "https://open.bigmodel.cn/api/paas/v4" }, () => {
      expect(resolveClient().baseURL).toBe("https://open.bigmodel.cn/api/paas/v4");
    });
  });

  it("routes groq and openrouter prefixes to their endpoints", () => {
    withEnv({ GROQ_API_KEY: "g" }, () => {
      expect(resolveClient("groq/x").baseURL).toBe("https://api.groq.com/openai/v1");
    });
    withEnv({ OPENROUTER_API_KEY: "o" }, () => {
      expect(resolveClient("openrouter/x").baseURL).toBe("https://openrouter.ai/api/v1");
    });
  });

  it("defaults to NIM and refuses without a key", () => {
    withEnv({ NVIDIA_API_KEY: "n" }, () => {
      expect(resolveClient().baseURL).toBe("https://integrate.api.nvidia.com/v1");
    });
    withEnv({}, () => {
      expect(() => nimClient()).toThrow(/NVIDIA_API_KEY/);
      expect(() => zaiClient()).toThrow(/ZAI_API_KEY/);
    });
  });
});
