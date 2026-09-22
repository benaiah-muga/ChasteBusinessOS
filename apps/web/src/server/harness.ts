import {
  BUILTIN_PROFILES,
  CAPABILITY_BRIDGE_SERVICE_ID,
  capabilityBridgeService,
  createCapabilityBridge,
  createHarnessRuntime,
  type HarnessBundle,
  type HarnessBundleManifest,
  type HarnessConfigPatch,
  type HarnessCapabilityBridge,
  type HarnessProfile,
  type HarnessRuntime,
} from "@chaste/harness";
import { canonicalJson } from "@chaste/plugin-kit";
import { type Database } from "@chaste/db";
import { buildExecutor, composeRegistry } from "./kernel";

export interface ChasteHarnessOptions {
  profile?: HarnessProfile;
  enabledModules?: string[] | null;
  failOnAuditError?: boolean;
  bundles?: HarnessBundleManifest[];
  patches?: HarnessConfigPatch[];
  bundleResolvers?: ChasteHarnessBundleResolver[];
}

export interface ChasteHarnessBundleContext {
  profile: HarnessProfile;
  bridge: HarnessCapabilityBridge;
  registry: ReturnType<typeof composeRegistry>;
  executor: ReturnType<typeof buildExecutor>;
}

export type ChasteHarnessBundleResolver = (
  manifest: HarnessBundleManifest,
  context: ChasteHarnessBundleContext,
) => HarnessBundle | undefined;

export interface ChasteHarness {
  runtime: HarnessRuntime;
  bridge: HarnessCapabilityBridge;
  registry: ReturnType<typeof composeRegistry>;
  executor: ReturnType<typeof buildExecutor>;
}

const DEFAULT_ERP_BUNDLE: HarnessBundleManifest = {
  id: "chaste-erp",
  version: "1.0.0",
  serviceIds: [CAPABILITY_BRIDGE_SERVICE_ID],
};

const erpBundleResolver: ChasteHarnessBundleResolver = (manifest, context) => {
  if (
    manifest.id !== DEFAULT_ERP_BUNDLE.id ||
    manifest.version !== DEFAULT_ERP_BUNDLE.version ||
    manifest.serviceIds.length !== 1 ||
    manifest.serviceIds[0] !== CAPABILITY_BRIDGE_SERVICE_ID ||
    manifest.requiredBundleIds?.length
  ) {
    return undefined;
  }
  return {
    manifest: { ...manifest },
    services: [capabilityBridgeService(context.bridge)],
  };
};

function resolveBundles(
  manifests: HarnessBundleManifest[],
  context: ChasteHarnessBundleContext,
  resolvers: ChasteHarnessBundleResolver[],
): HarnessBundle[] {
  return manifests.map((manifest) => {
    for (const resolver of resolvers) {
      const bundle = resolver(manifest, context);
      if (!bundle) continue;
      if (canonicalJson(bundle.manifest) !== canonicalJson(manifest)) {
        throw new Error(`bundle resolver changed manifest for ${manifest.id}@${manifest.version}`);
      }
      return bundle;
    }
    throw new Error(
      `persisted harness composition is not supported: no approved bundle resolver for ${manifest.id}@${manifest.version}`,
    );
  });
}

/**
 * Consolidation adapter for the existing app composition. The harness owns
 * lifecycle and inspection; the registry and KernelExecutor remain the only
 * capability discovery and execution authority.
 */
export function createChasteHarness(db: Database["db"], options: ChasteHarnessOptions = {}): ChasteHarness {
  const profile = options.profile ?? BUILTIN_PROFILES["erp-prod"];
  const enabledModules =
    options.enabledModules !== undefined
      ? options.enabledModules
      : profile.allowedModules.length > 0
        ? profile.allowedModules
        : null;
  const registry = composeRegistry(db);
  const executor = buildExecutor(db, registry, {
    enabledModules,
    failOnAuditError: options.failOnAuditError,
  });
  const bridge = createCapabilityBridge({
    registry,
    executor,
    enabledModules: enabledModules === null ? null : new Set(enabledModules),
  });
  const manifests = options.bundles ?? [DEFAULT_ERP_BUNDLE];
  const patches = options.patches ?? [];
  const bundleResolvers = [erpBundleResolver, ...(options.bundleResolvers ?? [])];
  const runtime = createHarnessRuntime({
    profile,
    bundles: resolveBundles(manifests, { profile, bridge, registry, executor }, bundleResolvers),
    patches,
  });
  return { runtime, bridge, registry, executor };
}
