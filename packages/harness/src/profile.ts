import { canonicalJson } from "@chaste/plugin-kit";
import { createHash } from "node:crypto";
import { z } from "zod";

export const harnessEnvironmentSchema = z.enum(["erp-prod", "erp-dev", "erp-review", "erp-worker"]);
export type HarnessEnvironment = z.infer<typeof harnessEnvironmentSchema>;

const authoritySchema = z.object({
  allowSourceWrites: z.boolean(),
  allowProcessLaunch: z.boolean(),
  allowCodeExecution: z.boolean(),
  allowRegistryMutation: z.boolean(),
  allowNetwork: z.boolean(),
});

export const harnessProfileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  environment: harnessEnvironmentSchema,
  authority: authoritySchema,
  allowedModules: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
});

export type HarnessAuthority = z.infer<typeof authoritySchema>;
export type HarnessProfile = z.infer<typeof harnessProfileSchema>;

export const harnessBundleManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  serviceIds: z.array(z.string().min(1)),
  requiredBundleIds: z.array(z.string().min(1)).optional(),
});

export type HarnessBundleManifest = z.infer<typeof harnessBundleManifestSchema>;

export const harnessConfigPatchSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  values: z.record(z.string(), z.unknown()),
});

export type HarnessConfigPatch = z.infer<typeof harnessConfigPatchSchema>;

export interface HarnessCompositionInspection {
  profile: Pick<HarnessProfile, "id" | "version" | "environment">;
  profileDigest: string;
  compositionDigest: string;
  bundles: Array<Pick<HarnessBundleManifest, "id" | "version" | "serviceIds" | "requiredBundleIds">>;
  patches: Array<{ id: string; version: string; configKeys: string[] }>;
}

export function inspectComposition(input: {
  profile: HarnessProfile;
  profileDigest?: string;
  compositionDigest: string;
  bundles: HarnessBundleManifest[];
  patches: HarnessConfigPatch[];
}): HarnessCompositionInspection {
  const profile = assertHarnessProfile(input.profile);
  return {
    profile: { id: profile.id, version: profile.version, environment: profile.environment },
    profileDigest: input.profileDigest ?? profileDigest(profile),
    compositionDigest: input.compositionDigest,
    bundles: input.bundles.map((bundle) => ({
      id: bundle.id,
      version: bundle.version,
      serviceIds: [...bundle.serviceIds].sort(),
      ...(bundle.requiredBundleIds ? { requiredBundleIds: [...bundle.requiredBundleIds].sort() } : {}),
    })),
    patches: input.patches.map((patch) => ({
      id: patch.id,
      version: patch.version,
      configKeys: Object.keys(patch.values).sort(),
    })),
  };
}

export const BUILTIN_PROFILES: Record<HarnessEnvironment, HarnessProfile> = {
  "erp-prod": {
    id: "erp-prod",
    version: "1.0.0",
    environment: "erp-prod",
    authority: {
      allowSourceWrites: false,
      allowProcessLaunch: false,
      allowCodeExecution: false,
      allowRegistryMutation: false,
      allowNetwork: false,
    },
    allowedModules: [],
  },
  "erp-dev": {
    id: "erp-dev",
    version: "1.0.0",
    environment: "erp-dev",
    authority: {
      allowSourceWrites: true,
      allowProcessLaunch: true,
      allowCodeExecution: true,
      allowRegistryMutation: true,
      allowNetwork: false,
    },
    allowedModules: [],
  },
  "erp-review": {
    id: "erp-review",
    version: "1.0.0",
    environment: "erp-review",
    authority: {
      allowSourceWrites: false,
      allowProcessLaunch: false,
      allowCodeExecution: false,
      allowRegistryMutation: false,
      allowNetwork: false,
    },
    allowedModules: [],
  },
  "erp-worker": {
    id: "erp-worker",
    version: "1.0.0",
    environment: "erp-worker",
    authority: {
      allowSourceWrites: false,
      allowProcessLaunch: false,
      allowCodeExecution: false,
      allowRegistryMutation: false,
      allowNetwork: true,
    },
    allowedModules: [],
  },
};

const restrictedEnvironments = new Set<HarnessEnvironment>(["erp-prod", "erp-review", "erp-worker"]);

export function assertHarnessProfile(input: unknown): HarnessProfile {
  const profile = harnessProfileSchema.parse(input);
  if (restrictedEnvironments.has(profile.environment)) {
    const forbidden = Object.entries(profile.authority)
      .filter(([key, enabled]) => enabled && key !== "allowNetwork")
      .map(([key]) => key);
    if (forbidden.length > 0) {
      throw new Error(
        `profile ${profile.id} expands restricted authority: ${forbidden.sort().join(", ")}`,
      );
    }
  }
  return profile;
}

export function profileDigest(profile: HarnessProfile): string {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

export function compositionDigest(input: {
  profile: HarnessProfile;
  bundles: HarnessBundleManifest[];
  patches: HarnessConfigPatch[];
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        profile: assertHarnessProfile(input.profile),
        bundles: input.bundles,
        patches: input.patches,
      }),
    )
    .digest("hex");
}
