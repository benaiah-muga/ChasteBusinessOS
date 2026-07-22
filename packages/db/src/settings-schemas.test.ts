import { describe, expect, it } from "vitest";
import {
  orgSettingsSchema,
  userPreferencesSchema,
  orgSettingsUpdateSchema,
  userPreferencesUpdateSchema,
  type OrgSettings,
  type UserPreferences,
} from "./settings-schemas.js";

describe("orgSettingsSchema", () => {
  it("applies defaults for empty object", () => {
    const result = orgSettingsSchema.parse({});
    expect(result.timezone).toBe("UTC");
    expect(result.locale).toBe("en");
    expect(result.currency).toBe("USD");
    expect(result.emailNotifications).toBe(true);
    expect(result.notificationDigest).toBe("daily");
    expect(result.auditRetentionDays).toBe(365);
    expect(result.chatHistoryRetentionDays).toBe(90);
    expect(result.modules).toEqual({});
  });

  it("accepts valid full settings", () => {
    const settings: OrgSettings = {
      timezone: "America/New_York",
      locale: "fr",
      currency: "EUR",
      aiModel: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      aiTemperature: 0.7,
      aiMaxTokens: 4096,
      emailNotifications: false,
      notificationDigest: "weekly",
      webhookUrl: "https://hooks.example.com/notify",
      auditRetentionDays: 180,
      chatHistoryRetentionDays: 30,
      modules: { crm: { defaultTaxRate: 0.15 } },
    };
    const result = orgSettingsSchema.parse(settings);
    expect(result.timezone).toBe("America/New_York");
    expect(result.modules.crm).toEqual({ defaultTaxRate: 0.15 });
  });

  it("rejects invalid timezone type", () => {
    expect(() => orgSettingsSchema.parse({ timezone: 123 })).toThrow();
  });

  it("rejects invalid notificationDigest", () => {
    expect(() => orgSettingsSchema.parse({ notificationDigest: "hourly" })).toThrow();
  });

  it("rejects aiTemperature out of range", () => {
    expect(() => orgSettingsSchema.parse({ aiTemperature: 3 })).toThrow();
    expect(() => orgSettingsSchema.parse({ aiTemperature: -1 })).toThrow();
  });

  it("rejects auditRetentionDays below 1", () => {
    expect(() => orgSettingsSchema.parse({ auditRetentionDays: 0 })).toThrow();
  });

  it("rejects invalid webhookUrl", () => {
    expect(() => orgSettingsSchema.parse({ webhookUrl: "not-a-url" })).toThrow();
  });

  it("accepts optional fields as undefined", () => {
    const result = orgSettingsSchema.parse({
      aiModel: undefined,
      aiTemperature: undefined,
      webhookUrl: undefined,
    });
    expect(result.aiModel).toBeUndefined();
    expect(result.webhookUrl).toBeUndefined();
  });
});

describe("orgSettingsUpdateSchema", () => {
  it("accepts partial objects", () => {
    const result = orgSettingsUpdateSchema.parse({ currency: "GBP" });
    expect(result.currency).toBe("GBP");
    expect(result.timezone).toBeUndefined();
  });

  it("accepts empty object", () => {
    const result = orgSettingsUpdateSchema.parse({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("accepts nested module updates", () => {
    const result = orgSettingsUpdateSchema.parse({
      modules: { crm: { defaultTaxRate: 0.2 } },
    });
    expect(result.modules?.crm).toEqual({ defaultTaxRate: 0.2 });
  });
});

describe("userPreferencesSchema", () => {
  it("applies defaults for empty object", () => {
    const result = userPreferencesSchema.parse({});
    expect(result.theme).toBe("system");
    expect(result.accent).toBe("maroon");
    expect(result.timezone).toBeUndefined();
    expect(result.locale).toBeUndefined();
    expect(result.notifications).toEqual({});
  });

  it("accepts valid full preferences", () => {
    const prefs: UserPreferences = {
      theme: "dark",
      accent: "teal",
      timezone: "Asia/Tokyo",
      locale: "ja",
      notifications: {
        emailDigest: "never",
        pushEnabled: false,
      },
    };
    const result = userPreferencesSchema.parse(prefs);
    expect(result.theme).toBe("dark");
    expect(result.accent).toBe("teal");
    expect(result.timezone).toBe("Asia/Tokyo");
  });

  it("rejects invalid theme", () => {
    expect(() => userPreferencesSchema.parse({ theme: "blue" })).toThrow();
  });

  it("accepts partial notification prefs", () => {
    const result = userPreferencesSchema.parse({
      notifications: { pushEnabled: false },
    });
    expect(result.notifications.pushEnabled).toBe(false);
    expect(result.notifications.emailDigest).toBeUndefined();
  });
});

describe("userPreferencesUpdateSchema", () => {
  it("accepts partial objects", () => {
    const result = userPreferencesUpdateSchema.parse({ theme: "light" });
    expect(result.theme).toBe("light");
    expect(result.timezone).toBeUndefined();
  });

  it("accepts empty object", () => {
    const result = userPreferencesUpdateSchema.parse({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("accepts nested notification partial", () => {
    const result = userPreferencesUpdateSchema.parse({
      notifications: { pushEnabled: false },
    });
    expect(result.notifications?.pushEnabled).toBe(false);
    expect(result.notifications?.emailDigest).toBeUndefined();
  });
});
