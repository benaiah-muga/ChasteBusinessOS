import type {
  ActionContext,
  Actor,
  Capability,
  CapabilityRegistry,
  CapabilityResult,
  KernelExecutor,
} from "@chaste/kernel";
import type { HarnessServiceDefinition } from "./runtime";

export interface CapabilityBridgeOptions {
  registry: CapabilityRegistry;
  executor: Pick<KernelExecutor, "execute">;
  enabledModules?: ReadonlySet<string> | null;
}

export interface HarnessCapabilityBridge {
  list(actor: Actor): Capability[];
  resolve(capabilityId: string): Capability;
  execute<I, O>(
    capabilityId: string,
    context: ActionContext,
    input: I,
    options?: { approvedApprovalId?: string },
  ): Promise<CapabilityResult<O>>;
}

export const CAPABILITY_BRIDGE_SERVICE_ID = "chaste.capability.bridge";

export function createCapabilityBridge(options: CapabilityBridgeOptions): HarnessCapabilityBridge {
  const scoped = options.registry.scopedToModules(options.enabledModules ?? null);
  return {
    list(actor) {
      return scoped.forActor(actor);
    },
    resolve(capabilityId) {
      return scoped.require(capabilityId);
    },
    execute(capabilityId, context, input, executeOptions) {
      // The bridge deliberately has no direct capability.execute path. The
      // supplied KernelExecutor remains the authority for policy, approval,
      // receipts, inverses, audit and module enablement.
      return options.executor.execute(capabilityId, context, input, executeOptions);
    },
  };
}

export function capabilityBridgeService(bridge: HarnessCapabilityBridge): HarnessServiceDefinition {
  return {
    id: CAPABILITY_BRIDGE_SERVICE_ID,
    version: "1.0.0",
    mount: () => ({ value: bridge }),
  };
}
