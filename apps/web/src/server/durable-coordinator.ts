import { inspectComposition } from "@chaste/harness";
import { type Database } from "@chaste/db";
import {
  createChasteHarness,
  type ChasteHarness,
  type ChasteHarnessBundleResolver,
} from "./harness";
import {
  getHarnessComposition,
  parseHarnessComposition,
  type PersistedHarnessCompositionInspection,
} from "./harness-compositions";
import { createDurableRun, type CreateDurableRunInput } from "./durable-runs";
import { assertHarnessCompositionApproved } from "./harness-approval";

export interface ExpectedHarnessProfile {
  id?: string;
  version?: string;
  environment?: "erp-prod" | "erp-dev" | "erp-review" | "erp-worker";
}

export interface StartProfileAwareDurableRunInput
  extends Omit<CreateDurableRunInput, "harnessCompositionId"> {
  harnessCompositionId: string;
  compositionApprovalId: string;
  expectedProfile?: ExpectedHarnessProfile;
  bundleResolvers?: ChasteHarnessBundleResolver[];
}

export interface ProfileAwareDurableRun {
  runId: string;
  composition: PersistedHarnessCompositionInspection;
  harness: ChasteHarness;
  dispose(): Promise<void>;
}

function assertExpectedProfile(
  profile: { id: string; version: string; environment: string },
  expected: ExpectedHarnessProfile | undefined,
): void {
  if (!expected) return;
  if (expected.id !== undefined && expected.id !== profile.id) {
    throw new Error(`harness profile mismatch: expected ${expected.id}, got ${profile.id}`);
  }
  if (expected.version !== undefined && expected.version !== profile.version) {
    throw new Error(`harness profile version mismatch: expected ${expected.version}, got ${profile.version}`);
  }
  if (expected.environment !== undefined && expected.environment !== profile.environment) {
    throw new Error(`harness environment mismatch: expected ${expected.environment}, got ${profile.environment}`);
  }
}

/**
 * Resolves the tenant-approved composition before creating a run, mounts the
 * existing KernelExecutor bridge with that profile, and verifies both live and
 * durable identities before returning an execution-ready coordinator result.
 */
export async function startProfileAwareDurableRun(
  db: Database["db"],
  input: StartProfileAwareDurableRunInput,
): Promise<ProfileAwareDurableRun> {
  const row = await getHarnessComposition(db, input.orgId, input.harnessCompositionId);
  if (!row) throw new Error("harness composition not found for organization");

  const parts = parseHarnessComposition(row);
  assertExpectedProfile(parts.profile, input.expectedProfile);
  await assertHarnessCompositionApproved(
    db,
    input.orgId,
    row.id,
    row.compositionDigest,
    input.compositionApprovalId,
  );

  const harness = createChasteHarness(db, {
    profile: parts.profile,
    enabledModules: parts.profile.allowedModules.length > 0 ? parts.profile.allowedModules : null,
    bundles: parts.bundles,
    patches: parts.patches,
    bundleResolvers: input.bundleResolvers,
  });
  const liveIdentity = harness.runtime.inspect();
  if (
    liveIdentity.profileDigest !== row.profileDigest ||
    liveIdentity.compositionDigest !== row.compositionDigest
  ) {
    throw new Error("live harness identity does not match the persisted composition");
  }

  await harness.runtime.mount();
  try {
    const {
      expectedProfile: _expectedProfile,
      bundleResolvers: _bundleResolvers,
      compositionApprovalId: _compositionApprovalId,
      ...runInput
    } = input;
    const runId = await createDurableRun(db, {
      ...runInput,
      harnessCompositionId: row.id,
    });
    return {
      runId,
      composition: {
        id: row.id,
        profile: { id: parts.profile.id, version: parts.profile.version, environment: parts.profile.environment },
        profileDigest: row.profileDigest,
        compositionDigest: row.compositionDigest,
        bundles: parts.bundles,
        patches: inspectComposition({
          profile: parts.profile,
          profileDigest: row.profileDigest,
          compositionDigest: row.compositionDigest,
          bundles: parts.bundles,
          patches: parts.patches,
        }).patches,
      },
      harness,
      dispose: () => harness.runtime.unmount(),
    };
  } catch (error) {
    await harness.runtime.unmount();
    throw error;
  }
}
