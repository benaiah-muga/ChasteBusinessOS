import { z } from "zod";
import type { CommandRegistry } from "./command.js";
import type { QueryRegistry } from "./query.js";

export const specialistProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  toolTags: z.array(z.string()).default([]),
});

export type SpecialistProfile = z.infer<typeof specialistProfileSchema>;

export const moduleManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
  specialist: specialistProfileSchema.optional(),
});

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

export interface ModuleContext {
  commands: CommandRegistry;
  queries: QueryRegistry;
}

export interface BusinessModule {
  manifest: ModuleManifest;
  register(ctx: ModuleContext): void | Promise<void>;
}

export interface ModuleRegistry {
  register(mod: BusinessModule): Promise<void>;
  get(id: string): BusinessModule | undefined;
  list(): ModuleManifest[];
  specialists(): SpecialistProfile[];
}

export function createModuleRegistry(
  commands: CommandRegistry,
  queries: QueryRegistry,
): ModuleRegistry {
  const modules = new Map<string, BusinessModule>();

  return {
    async register(mod) {
      const manifest = moduleManifestSchema.parse(mod.manifest);
      if (modules.has(manifest.id)) {
        throw new Error(`Module already registered: ${manifest.id}`);
      }
      for (const dep of manifest.dependencies) {
        if (!modules.has(dep)) {
          throw new Error(`Module ${manifest.id} missing dependency: ${dep}`);
        }
      }
      await mod.register({ commands, queries });
      modules.set(manifest.id, { ...mod, manifest });
    },
    get(id) {
      return modules.get(id);
    },
    list() {
      return [...modules.values()].map((m) => m.manifest);
    },
    specialists() {
      return [...modules.values()]
        .map((m) => m.manifest.specialist)
        .filter((s): s is SpecialistProfile => Boolean(s));
    },
  };
}
