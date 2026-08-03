/**
 * C6 — email adapter + versioned templates (spec: scheduling-and-comms §5).
 *
 * The adapter is a thin pluggable interface; alpha ships a console adapter so
 * delivery records and idempotency are real while providers are config'd later
 * (SMTP / SES / Resend). Secrets stay in env/config, never in modules.
 */
import { z } from "zod";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
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

/**
 * Config-driven adapter factory. Extend with SMTP/Resend branches; the worker
 * only ever talks to the adapter interface, so providers are swappable.
 */
export function createEmailAdapter(): EmailAdapter {
  if (process.env.CHASTE_SMTP_HOST) {
    // SMTP adapter lands here (nodemailer); see docs/specs/scheduling-and-comms.md §5.
    throw new Error("SMTP adapter not implemented yet — remove CHASTE_SMTP_HOST to use the console adapter");
  }
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
