import { z } from "zod";

/**
 * Organization-level settings stored in `organizations.settings` jsonb.
 * Merge strategy: client sends partial, server merges with existing, validates full result.
 */
export const orgSettingsSchema = z.object({
  // Localization
  timezone: z.string().default("UTC"),
  locale: z.string().default("en"),
  currency: z.string().default("USD"),

  // AI defaults
  aiModel: z.string().optional(),
  aiTemperature: z.number().min(0).max(2).optional(),
  aiMaxTokens: z.number().int().min(1).max(128_000).optional(),

  // Notifications
  emailNotifications: z.boolean().default(true),
  notificationDigest: z.enum(["daily", "weekly", "never"]).default("daily"),
  webhookUrl: z.string().url().optional(),

  // Data retention
  auditRetentionDays: z.number().int().min(1).max(3650).default(365),
  chatHistoryRetentionDays: z.number().int().min(1).max(365).default(90),

  // Module-specific (generic key-value)
  modules: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

/**
 * Per-user preferences stored in `users.settings` jsonb.
 * Fields that are undefined fall back to the org-level setting.
 */
export const userPreferencesSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).default("system"),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  notifications: z
    .object({
      emailDigest: z.enum(["daily", "weekly", "never"]).optional(),
      pushEnabled: z.boolean().optional(),
    })
    .default({}),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

/**
 * Partial schema for updating org settings (merged with existing).
 * Fields omitted by the client are `undefined` so the merge step knows to keep existing values.
 */
export const orgSettingsUpdateSchema = z.object({
  timezone: z.string().optional(),
  locale: z.string().optional(),
  currency: z.string().optional(),
  aiModel: z.string().optional(),
  aiTemperature: z.number().min(0).max(2).optional(),
  aiMaxTokens: z.number().int().min(1).max(128_000).optional(),
  emailNotifications: z.boolean().optional(),
  notificationDigest: z.enum(["daily", "weekly", "never"]).optional(),
  webhookUrl: z.string().url().optional(),
  auditRetentionDays: z.number().int().min(1).max(3650).optional(),
  chatHistoryRetentionDays: z.number().int().min(1).max(365).optional(),
  modules: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

/**
 * Partial schema for updating user preferences (merged with existing).
 * Fields omitted by the client are `undefined` so the merge step knows to keep existing values.
 */
export const userPreferencesUpdateSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  notifications: z
    .object({
      emailDigest: z.enum(["daily", "weekly", "never"]).optional(),
      pushEnabled: z.boolean().optional(),
    })
    .optional(),
});
