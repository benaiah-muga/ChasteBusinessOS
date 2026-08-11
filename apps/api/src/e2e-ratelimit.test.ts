import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";

/**
 * F6 — HTTP-level rate limiting. Uses its own buildServer instance so the
 * default limits (login: 10 / 15s per IP) are fresh and deterministic.
 */
describe("F6 rate limiting at the HTTP edge", () => {
  it("throttles repeated /auth/login attempts from one IP with 429", async () => {
    const { server } = await buildServer();
    try {
      await server.listen({ port: 0, host: "127.0.0.1" });
      const addr = server.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;

      const attempt = () =>
        fetch(`${base}/api/v1/auth/login`, {
          method: "POST",
          headers: { authorization: "Bearer invalid-token", "content-type": "application/json" },
          body: "{}",
        });

      let saw401 = 0;
      let saw429 = 0;
      for (let i = 0; i < 12; i += 1) {
        const res = await attempt();
        if (res.status === 401) saw401 += 1;
        if (res.status === 429) {
          saw429 += 1;
          expect(res.headers.get("retry-after")).toBeTruthy();
          const body = (await res.json()) as { code?: string };
          expect(body.code).toBe("RATE_LIMITED");
        }
      }
      // 10 within budget → 401 invalid-credential; the 11th and 12th → 429.
      expect(saw401).toBe(10);
      expect(saw429).toBe(2);
    } finally {
      await server.close();
    }
  });
});
