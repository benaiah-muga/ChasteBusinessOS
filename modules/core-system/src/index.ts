import {
  defineQuery,
  type BusinessModule,
  type ModuleManifest,
  type ModuleRegistry,
} from "@chaste/kernel";
import { z } from "zod";

export const coreSystemManifest: ModuleManifest = {
  id: "core-system",
  name: "Core System",
  version: "0.1.0",
  description: "Always-on system capabilities",
  dependencies: [],
  permissions: ["core.modules.read"],
  capabilities: ["core.modules"],
  specialist: {
    id: "system",
    displayName: "System Agent",
    description: "Modules, policies, and platform capabilities",
    toolTags: ["core"],
  },
};

export function createCoreSystemModule(modules: ModuleRegistry): BusinessModule {
  return {
    manifest: coreSystemManifest,
    register({ queries }) {
      queries.register(
        defineQuery({
          name: "core.modules.list",
          description: "List installed modules",
          permissions: ["core.modules.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                version: z.string(),
                capabilities: z.array(z.string()),
              }),
            ),
          }),
          handler: async () => ({
            items: modules.list().map((m) => ({
              id: m.id,
              name: m.name,
              version: m.version,
              capabilities: m.capabilities,
            })),
          }),
        }),
      );
    },
  };
}
