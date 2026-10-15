import { z } from "zod";

const UserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

const SessionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

const SessionResponseSchema = z.object({ user: UserSchema, session: SessionSchema }).strict().nullable();
// Vite is a browser client. Go must set the HttpOnly session cookie and must
// never return a bearer token that application JavaScript could retain.
const SignInResponseSchema = z.object({
  redirect: z.boolean(),
  token: z.null(),
  url: z.string().nullable(),
  user: UserSchema,
}).strict();
const SignUpResponseSchema = z.object({ token: z.null(), user: UserSchema }).strict();
const StatusResponseSchema = z.object({ status: z.literal(true) }).strict();
const RecoveryRequestResponseSchema = z.object({ status: z.literal(true), message: z.string() }).strict();
const SignOutResponseSchema = z.object({ success: z.literal(true) }).strict();

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
    const error = z.object({ message: z.string().optional(), code: z.string().optional() }).strict().safeParse(payload);
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

// The browser talks to Go's auth endpoints directly with its same-origin,
// HttpOnly cookie session. No SDK or bearer token is exposed to application code.
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
  signOut(): Promise<AuthResult<z.infer<typeof SignOutResponseSchema>>> {
    return request("sign-out", SignOutResponseSchema, {});
  },
};
