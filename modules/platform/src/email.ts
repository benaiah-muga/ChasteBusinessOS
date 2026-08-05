/**
 * C6 — email adapter + versioned templates (spec: scheduling-and-comms §5).
 *
 * The adapter is a thin pluggable interface; alpha ships a console adapter so
 * delivery records and idempotency are real while providers are config'd later
 * (SMTP / SES / Resend). Secrets stay in env/config, never in modules.
 */
import { z } from "zod";
import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  from?: string;
}

export interface EmailAdapter {
  readonly id: string;
  send(msg: EmailMessage): Promise<{ messageId: string }>;
}

/** Console adapter: records delivery and returns a synthesized provider id. */
export function createConsoleEmailAdapter(): EmailAdapter {
  return {
    id: "console",
    async send(msg) {
      console.log(
        JSON.stringify({
          service: "chaste-email",
          provider: "console",
          to: msg.to,
          subject: msg.subject,
        }),
      );
      return { messageId: `console:${crypto.randomUUID()}` };
    },
  };
}

export const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Resend adapter (REST API, no SDK). Uses the global `fetch`.
 * Config: `CHASTE_RESEND_API_KEY`, `CHASTE_RESEND_FROM`.
 */
export function createResendEmailAdapter(): EmailAdapter {
  const apiKey = process.env.CHASTE_RESEND_API_KEY;
  const from =
    process.env.CHASTE_RESEND_FROM ??
    process.env.CHASTE_EMAIL_FROM ??
    "Chaste BusinessOS <onboarding@resend.dev>";
  return {
    id: "resend",
    async send(msg) {
      if (!apiKey) throw new Error("CHASTE_RESEND_API_KEY is not set");
      const res = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: msg.from ?? from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.body,
        }),
      });
      if (!res.ok) {
        throw new Error(`Resend error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as { id: string };
      return { messageId: data.id };
    },
  };
}

/**
 * SMTP adapter via nodemailer.
 * Config: `CHASTE_SMTP_HOST`, `CHASTE_SMTP_PORT`, `CHASTE_SMTP_SECURE`,
 * `CHASTE_SMTP_USER`, `CHASTE_SMTP_PASS`, `CHASTE_SMTP_FROM`.
 */
export function createSmtpEmailAdapter(): EmailAdapter {
  const host = process.env.CHASTE_SMTP_HOST;
  const from =
    process.env.CHASTE_SMTP_FROM ??
    process.env.CHASTE_EMAIL_FROM ??
    "Chaste BusinessOS <no-reply@chaste.local>";
  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.CHASTE_SMTP_PORT ?? 587),
    secure: (process.env.CHASTE_SMTP_SECURE ?? "false") === "true",
    auth: process.env.CHASTE_SMTP_USER
      ? { user: process.env.CHASTE_SMTP_USER, pass: process.env.CHASTE_SMTP_PASS ?? "" }
      : undefined,
  });
  return {
    id: "smtp",
    async send(msg) {
      if (!host) throw new Error("CHASTE_SMTP_HOST is not set");
      const info = await transport.sendMail({
        from: msg.from ?? from,
        to: msg.to,
        subject: msg.subject,
        text: msg.body,
      });
      return { messageId: info.messageId ?? `smtp:${crypto.randomUUID()}` };
    },
  };
}

export type EmailProvider = "resend" | "smtp" | "console";

/** Report which provider is active and its configured from-address (no secrets). */
export function detectEmailProvider(): {
  provider: EmailProvider;
  from: string | null;
} {
  if (process.env.CHASTE_RESEND_API_KEY) {
    return {
      provider: "resend",
      from: process.env.CHASTE_RESEND_FROM ?? process.env.CHASTE_EMAIL_FROM ?? null,
    };
  }
  if (process.env.CHASTE_SMTP_HOST) {
    return {
      provider: "smtp",
      from: process.env.CHASTE_SMTP_FROM ?? process.env.CHASTE_EMAIL_FROM ?? null,
    };
  }
  return { provider: "console", from: null };
}

/**
 * Config-driven adapter factory. Precedence: Resend > SMTP > console.
 * The worker only ever talks to the adapter interface, so providers are swappable.
 */
export function createEmailAdapter(): EmailAdapter {
  if (process.env.CHASTE_RESEND_API_KEY) return createResendEmailAdapter();
  if (process.env.CHASTE_SMTP_HOST) return createSmtpEmailAdapter();
  return createConsoleEmailAdapter();
}

export const emailTemplateSchema = z.enum(["invite", "reminder", "digest", "gap_ticket"]);

type TemplateVars = Record<string, string | number | boolean>;

const TEMPLATES: Record<z.infer<typeof emailTemplateSchema>, { subject: string; body: string }> = {
  invite: {
    subject: "You're invited to {org} on Chaste BusinessOS",
    body:
      "Hello {name},\n\n{inviter} invited you to join {org} on Chaste BusinessOS.\n\n" +
      "Open this link to accept: {link}\n\n— Chaste BusinessOS",
  },
  reminder: {
    subject: "Reminder: {title}",
    body: "{body}\n\n— Chaste BusinessOS",
  },
  digest: {
    subject: "Daily digest for {org}",
    body: "Here is what needs attention today:\n\n{items}\n\n— Chaste BusinessOS",
  },
  gap_ticket: {
    subject: "Capability gap confirmed: {title}",
    body:
      "Your request \"{title}\" is confirmed and routed for placement review.\n\n" +
      "Recommended target: {deploymentTarget}\n\n— Chaste BusinessOS",
  },
};

/** Versioned template rendering. Unused variables stay as-is; missing vars throw. */
export function renderEmailTemplate(
  template: z.infer<typeof emailTemplateSchema>,
  vars: TemplateVars = {},
): { subject: string; body: string } {
  const tpl = TEMPLATES[template];
  const render = (s: string) =>
    s.replace(/\{(\w+)\}/g, (_match, key: string) => {
      if (!(key in vars)) {
        throw new Error(`Missing template variable: ${key}`);
      }
      return String(vars[key]);
    });
  return { subject: render(tpl.subject), body: render(tpl.body) };
}
