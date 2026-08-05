import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConsoleEmailAdapter,
  createResendEmailAdapter,
  createSmtpEmailAdapter,
  createEmailAdapter,
  detectEmailProvider,
  RESEND_API_URL,
  renderEmailTemplate,
  emailTemplateSchema,
} from "./email.js";

const originalEnv = { ...process.env };

function applyEnv(next: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CHASTE_")) delete process.env[key];
  }
  Object.assign(process.env, next);
}

beforeEach(() => {
  applyEnv({});
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("createEmailAdapter selection", () => {
  it("prefers Resend when CHASTE_RESEND_API_KEY is set", () => {
    applyEnv({ CHASTE_RESEND_API_KEY: "re_123" });
    expect(createEmailAdapter().id).toBe("resend");
  });

  it("uses SMTP when CHASTE_SMTP_HOST is set", () => {
    applyEnv({ CHASTE_SMTP_HOST: "smtp.example.com" });
    expect(createEmailAdapter().id).toBe("smtp");
  });

  it("falls back to console", () => {
    expect(createEmailAdapter().id).toBe("console");
  });
});

describe("detectEmailProvider", () => {
  it("reports resend with from-address", () => {
    applyEnv({
      CHASTE_RESEND_API_KEY: "re_123",
      CHASTE_RESEND_FROM: "ops@acme.com",
    });
    expect(detectEmailProvider()).toEqual({
      provider: "resend",
      from: "ops@acme.com",
    });
  });

  it("reports smtp from host", () => {
    applyEnv({ CHASTE_SMTP_HOST: "smtp.example.com" });
    expect(detectEmailProvider().provider).toBe("smtp");
  });

  it("reports console as default and never leaks secrets", () => {
    applyEnv({ CHASTE_RESEND_API_KEY: "re_secret" });
    const status = detectEmailProvider();
    expect(JSON.stringify(status)).not.toContain("re_secret");
  });
});

describe("createConsoleEmailAdapter", () => {
  it("sends and returns a synthesized id", async () => {
    const adapter = createConsoleEmailAdapter();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { messageId } = await adapter.send({
      to: "a@example.com",
      subject: "Hi",
      body: "Hello",
    });
    spy.mockRestore();
    expect(messageId).toMatch(/^console:/);
  });
});

describe("createResendEmailAdapter", () => {
  it("posts to the Resend API and returns the provider message id", async () => {
    applyEnv({ CHASTE_RESEND_API_KEY: "re_123" });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "res_abc" }),
      text: async () => "",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { messageId } = await createResendEmailAdapter().send({
      to: "a@example.com",
      subject: "Hi",
      body: "Hello",
    });
    vi.unstubAllGlobals();

    expect(messageId).toBe("res_abc");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_API_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_123");
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({ to: ["a@example.com"], subject: "Hi", text: "Hello" });
    expect(payload.from).toContain("@");
  });

  it("throws without an API key", async () => {
    const adapter = createResendEmailAdapter();
    await expect(
      adapter.send({ to: "a@example.com", subject: "Hi", body: "Hello" }),
    ).rejects.toThrow(/CHASTE_RESEND_API_KEY/);
  });

  it("throws on non-ok response", async () => {
    applyEnv({ CHASTE_RESEND_API_KEY: "re_123" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => "bad payload",
      })) as unknown as typeof fetch,
    );
    await expect(
      createResendEmailAdapter().send({ to: "x", subject: "y", body: "z" }),
    ).rejects.toThrow(/Resend error 422/);
    vi.unstubAllGlobals();
  });
});

describe("createSmtpEmailAdapter", () => {
  it("resolves to an smtp adapter and throws if host is unset", async () => {
    const adapter = createSmtpEmailAdapter();
    await expect(
      adapter.send({ to: "a@example.com", subject: "Hi", body: "Hello" }),
    ).rejects.toThrow(/CHASTE_SMTP_HOST/);
  });
});

describe("renderEmailTemplate", () => {
  it("renders a known template with provided vars", () => {
    const { subject, body } = renderEmailTemplate("invite", {
      org: "Acme",
      name: "Sam",
      inviter: "Boss",
      link: "https://x",
    });
    expect(subject).toContain("Acme");
    expect(body).toContain("Sam");
    expect(body).toContain("Boss");
    expect(body).toContain("https://x");
  });

  it("throws on missing variables", () => {
    expect(() =>
      renderEmailTemplate("invite", { org: "Acme", name: "Sam", inviter: "Boss" }),
    ).toThrow(/Missing template variable: link/);
  });

  it("required-vars schema rejects unknown templates", () => {
    const parse = emailTemplateSchema.safeParse("nope");
    expect(parse.success).toBe(false);
  });
});