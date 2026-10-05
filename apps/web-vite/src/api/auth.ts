import { z } from "zod";

const UserSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  email: z.string().email(),
});

const SessionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

const SessionResponseSchema = z.object({ user: UserSchema, session: SessionSchema }).nullable();
const SignInResponseSchema = z.object({ token: z.string().nullable(), user: UserSchema });
const SignUpResponseSchema = z.object({ token: z.string().nullable(), user: UserSchema });
const StatusResponseSchema = z.object({ status: z.boolean() });
const RecoveryRequestResponseSchema = z.object({ status: z.boolean(), message: z.string() });

type AuthResult<T> = { data: T | null; error: { message: string } | null };
type Credentials = { email: string; password: string };

async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<AuthResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/auth/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? { accept: "application/json" } : {
        accept: "application/json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("Could not reach the Go authentication service");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ message: z.string().optional(), code: z.string().optional() }).safeParse(payload);
    const code = error.success ? error.data.code : undefined;
    const message = code === "EMAIL_NOT_VERIFIED"
      ? "Email not verified"
      : code === "INVALID_TOKEN"
        ? "Invalid or expired token"
        : error.success && error.data.message
          ? error.data.message
          : "Authentication request failed";
    return { data: null, error: { message } };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { data: null, error: { message: "The Go authentication service returned an unexpected response" } };
  }
  return { data: parsed.data, error: null };
}

// The browser talks to Go's documented auth endpoints directly. Keeping this
// small client local avoids coupling the Vite app to Better Auth's JS client.
export const authClient = {
  getSession(): Promise<AuthResult<z.infer<typeof SessionResponseSchema>>> {
    return request("get-session", SessionResponseSchema);
  },
  signIn: {
    email(credentials: Credentials): Promise<AuthResult<z.infer<typeof SignInResponseSchema>>> {
      return request("sign-in/email", SignInResponseSchema, credentials);
    },
  },
  signUp: {
    email(input: Credentials & { name: string; callbackURL?: string }): Promise<AuthResult<z.infer<typeof SignUpResponseSchema>>> {
      return request("sign-up/email", SignUpResponseSchema, input);
    },
  },
  sendVerificationEmail(email: string, callbackURL = "/login?verified=1"): Promise<AuthResult<z.infer<typeof StatusResponseSchema>>> {
    return request("send-verification-email", StatusResponseSchema, { email, callbackURL });
  },
  requestPasswordReset(email: string, redirectTo = "/reset-password"): Promise<AuthResult<z.infer<typeof RecoveryRequestResponseSchema>>> {
    return request("request-password-reset", RecoveryRequestResponseSchema, { email, redirectTo });
  },
  resetPassword(token: string, newPassword: string): Promise<AuthResult<z.infer<typeof StatusResponseSchema>>> {
    return request("reset-password", StatusResponseSchema, { token, newPassword });
  },
  async signOut(): Promise<AuthResult<{ success: boolean }>> {
    return request("sign-out", z.object({ success: z.boolean() }), {});
  },
};
