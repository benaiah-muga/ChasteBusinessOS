import {
  assertHarnessProfile,
  compositionDigest,
  inspectComposition,
  type HarnessBundleManifest,
  type HarnessConfigPatch,
  type HarnessProfile,
} from "./profile";

export type HarnessRuntimeStatus = "created" | "mounting" | "mounted" | "unmounting" | "unmounted" | "failed";

export interface HarnessEvent {
  sequence: number;
  type: string;
  serviceId?: string;
  detail?: string;
  at: string;
}

export interface HarnessServiceContainer {
  get<T>(serviceId: string): T | undefined;
  require<T>(serviceId: string): T;
  has(serviceId: string): boolean;
  ids(): string[];
}

export interface HarnessServiceContext {
  profile: HarnessProfile;
  config: Readonly<Record<string, unknown>>;
  services: HarnessServiceContainer;
  compositionDigest: string;
  emit(type: string, detail?: string): void;
}

export type HarnessCleanup = () => void | Promise<void>;

export interface HarnessMountResult {
  value?: unknown;
  cleanup?: HarnessCleanup;
}

export interface HarnessServiceDefinition {
  id: string;
  version: string;
  dependsOn?: string[];
  provides?: string[];
  mount(context: HarnessServiceContext):
    | HarnessMountResult
    | HarnessCleanup
    | void
    | Promise<HarnessMountResult | HarnessCleanup | void>;
}

export interface HarnessBundle {
  manifest: HarnessBundleManifest;
  services: HarnessServiceDefinition[];
}

export interface HarnessRuntimeOptions {
  profile: HarnessProfile;
  bundles?: HarnessBundle[];
  patches?: HarnessConfigPatch[];
  now?: () => Date;
}

class ServiceContainer implements HarnessServiceContainer {
  constructor(private readonly values: Map<string, unknown>) {}

  get<T>(serviceId: string): T | undefined {
    return this.values.get(serviceId) as T | undefined;
  }

  require<T>(serviceId: string): T {
    const service = this.get<T>(serviceId);
    if (service === undefined) throw new Error(`service is not mounted: ${serviceId}`);
    return service;
  }

  has(serviceId: string): boolean {
    return this.values.has(serviceId);
  }

  ids(): string[] {
    return [...this.values.keys()].sort();
  }
}

function mergePatchValues(patches: HarnessConfigPatch[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch.values)) merged[key] = value;
  }
  return merged;
}

function topologicalOrder(services: HarnessServiceDefinition[]): HarnessServiceDefinition[] {
  const byId = new Map<string, HarnessServiceDefinition>();
  for (const service of services) {
    if (byId.has(service.id)) throw new Error(`service already declared: ${service.id}`);
    byId.set(service.id, service);
  }

  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const ordered: HarnessServiceDefinition[] = [];
  const visit = (id: string): void => {
    if (permanent.has(id)) return;
    if (temporary.has(id)) throw new Error(`service dependency cycle includes: ${id}`);
    const service = byId.get(id);
    if (!service) throw new Error(`service dependency is missing: ${id}`);
    temporary.add(id);
    for (const dependency of [...(service.dependsOn ?? [])].sort()) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    ordered.push(service);
  };
  for (const service of services) visit(service.id);
  return ordered;
}

export class HarnessRuntime {
  readonly profile: HarnessProfile;
  readonly compositionDigest: string;
  private readonly services = new Map<string, unknown>();
  private readonly cleanups: Array<{ id: string; cleanup: HarnessCleanup }> = [];
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly history: HarnessEvent[] = [];
  private readonly now: () => Date;
  private readonly bundles: HarnessBundleManifest[];
  private readonly patches: HarnessConfigPatch[];
  private readonly orderedServices: HarnessServiceDefinition[];
  private readonly config: Readonly<Record<string, unknown>>;
  private statusValue: HarnessRuntimeStatus = "created";

  constructor(options: HarnessRuntimeOptions) {
    this.profile = assertHarnessProfile(options.profile);
    const bundles = options.bundles ?? [];
    const patches = options.patches ?? [];
    this.bundles = bundles.map((bundle) => bundle.manifest);
    this.patches = patches.map((patch) => ({ ...patch, values: { ...patch.values } }));
    for (const bundle of bundles) {
      if (bundle.manifest.serviceIds.slice().sort().join("\0") !== bundle.services.map((s) => s.id).sort().join("\0")) {
        throw new Error(`bundle ${bundle.manifest.id} manifest does not match services`);
      }
    }
    this.compositionDigest = compositionDigest({ profile: this.profile, bundles: this.bundles, patches: this.patches });
    this.orderedServices = topologicalOrder(bundles.flatMap((bundle) => bundle.services));
    this.config = Object.freeze(mergePatchValues(patches));
    this.now = options.now ?? (() => new Date());
  }

  get status(): HarnessRuntimeStatus {
    return this.statusValue;
  }

  get events(): readonly HarnessEvent[] {
    return this.history.slice();
  }

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  service<T>(serviceId: string): T | undefined {
    return new ServiceContainer(this.services).get<T>(serviceId);
  }

  mountedServiceIds(): string[] {
    return new ServiceContainer(this.services).ids();
  }

  async mount(): Promise<void> {
    if (this.statusValue === "mounted") return;
    if (this.statusValue === "mounting" || this.statusValue === "unmounting") {
      throw new Error(`cannot mount runtime while ${this.statusValue}`);
    }
    this.statusValue = "mounting";
    this.emit("runtime.mounting");
    try {
      for (const definition of this.orderedServices) {
        const context: HarnessServiceContext = {
          profile: this.profile,
          config: this.config,
          services: new ServiceContainer(this.services),
          compositionDigest: this.compositionDigest,
          emit: (type, detail) => this.emit(type, definition.id, detail),
        };
        const mounted = await definition.mount(context);
        const normalized =
          typeof mounted === "function"
            ? { value: {}, cleanup: mounted }
            : mounted && typeof mounted === "object" && ("value" in mounted || "cleanup" in mounted)
              ? { value: mounted.value ?? {}, cleanup: mounted.cleanup ?? (() => undefined) }
              : mounted === undefined
                ? { value: {}, cleanup: () => undefined }
                : (() => {
                    throw new Error(`service ${definition.id} returned an invalid mount value`);
                  })();
        this.services.set(definition.id, normalized.value);
        this.cleanups.push({ id: definition.id, cleanup: normalized.cleanup });
        this.emit("service.mounted", definition.id);
      }
      this.statusValue = "mounted";
      this.emit("runtime.mounted");
    } catch (error) {
      await this.rollbackMount();
      this.statusValue = "failed";
      this.emit("runtime.mount.failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async unmount(): Promise<void> {
    if (this.statusValue === "created" || this.statusValue === "unmounted") return;
    if (this.statusValue === "mounting" || this.statusValue === "unmounting") {
      throw new Error(`cannot unmount runtime while ${this.statusValue}`);
    }
    this.statusValue = "unmounting";
    this.emit("runtime.unmounting");
    const failures: unknown[] = [];
    while (this.cleanups.length > 0) {
      const mounted = this.cleanups.pop()!;
      try {
        await mounted.cleanup();
      } catch (error) {
        failures.push(error);
      } finally {
        this.services.delete(mounted.id);
        this.emit("service.unmounted", mounted.id);
      }
    }
    this.statusValue = failures.length > 0 ? "failed" : "unmounted";
    this.emit(failures.length > 0 ? "runtime.unmount.failed" : "runtime.unmounted");
    if (failures.length > 0) throw new AggregateError(failures, "one or more harness services failed to unmount");
  }

  inspect(): {
    status: HarnessRuntimeStatus;
    profile: Pick<HarnessProfile, "id" | "version" | "environment">;
    profileDigest: string;
    compositionDigest: string;
    bundles: Array<Pick<HarnessBundleManifest, "id" | "version" | "serviceIds" | "requiredBundleIds">>;
    patches: Array<{ id: string; version: string; configKeys: string[] }>;
    mountedServices: string[];
    configKeys: string[];
  } {
    const composition = inspectComposition({
      profile: this.profile,
      compositionDigest: this.compositionDigest,
      bundles: this.bundles,
      patches: this.patches,
    });
    return {
      status: this.statusValue,
      profile: composition.profile,
      profileDigest: composition.profileDigest,
      compositionDigest: this.compositionDigest,
      bundles: composition.bundles,
      patches: composition.patches,
      mountedServices: this.mountedServiceIds(),
      configKeys: Object.keys(this.config).sort(),
    };
  }

  private async rollbackMount(): Promise<void> {
    while (this.cleanups.length > 0) {
      const mounted = this.cleanups.pop()!;
      try {
        await mounted.cleanup();
      } finally {
        this.services.delete(mounted.id);
        this.emit("service.unmounted", mounted.id);
      }
    }
  }

  private emit(type: string, serviceId?: string, detail?: string): void {
    const event: HarnessEvent = {
      sequence: this.history.length,
      type,
      ...(serviceId ? { serviceId } : {}),
      ...(detail ? { detail } : {}),
      at: this.now().toISOString(),
    };
    this.history.push(event);
    for (const listener of this.listeners) listener(event);
  }
}

export function createHarnessRuntime(options: HarnessRuntimeOptions): HarnessRuntime {
  return new HarnessRuntime(options);
}
