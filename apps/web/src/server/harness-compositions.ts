import { and, eq } from "drizzle-orm";
import {
  harnessCompositions,
  withOrgContext,
  type Database,
} from "@chaste/db";
import {
  assertHarnessProfile,
  compositionDigest,
  harnessBundleManifestSchema,
  harnessConfigPatchSchema,
  inspectComposition,
  profileDigest,
  type HarnessBundleManifest,
  type HarnessConfigPatch,
  type HarnessCompositionInspection,
  type HarnessProfile,
} from "@chaste/harness";

export interface PersistHarnessCompositionInput {
  orgId: string;
  profile: HarnessProfile;
  bundles: HarnessBundleManifest[];
  patches?: HarnessConfigPatch[];
}

export interface PersistedHarnessCompositionInspection extends HarnessCompositionInspection {
  id: string;
}

export function parseHarnessComposition(row: typeof harnessCompositions.$inferSelect): {
  profile: HarnessProfile;
  bundles: HarnessBundleManifest[];
  patches: HarnessConfigPatch[];
} {
  return {
    profile: assertHarnessProfile(row.profile),
    bundles: harnessBundleManifestSchema.array().parse(row.bundles),
    patches: harnessConfigPatchSchema.array().parse(row.patches),
  };
}

function assertPersistedIdentity(row: typeof harnessCompositions.$inferSelect): void {
  const parts = parseHarnessComposition(row);
  if (profileDigest(parts.profile) !== row.profileDigest) {
    throw new Error(`harness composition ${row.id} has an invalid profile digest`);
  }
  if (
    compositionDigest({ profile: parts.profile, bundles: parts.bundles, patches: parts.patches }) !==
    row.compositionDigest
  ) {
    throw new Error(`harness composition ${row.id} has an invalid composition digest`);
  }
}

export async function persistHarnessComposition(
  db: Database["db"],
  input: PersistHarnessCompositionInput,
): Promise<typeof harnessCompositions.$inferSelect> {
  const profile = assertHarnessProfile(input.profile);
  const bundles = harnessBundleManifestSchema.array().parse(input.bundles);
  const patches = harnessConfigPatchSchema.array().parse(input.patches ?? []);
  const digest = compositionDigest({ profile, bundles, patches });

  return withOrgContext(db, input.orgId, async (tx) => {
    await tx
      .insert(harnessCompositions)
      .values({
        orgId: input.orgId,
        profileId: profile.id,
        profileVersion: profile.version,
        environment: profile.environment,
        profileDigest: profileDigest(profile),
        compositionDigest: digest,
        profile: profile as object,
        bundles: bundles as object,
        patches: patches as object,
      })
      .onConflictDoNothing({
        target: [harnessCompositions.orgId, harnessCompositions.compositionDigest],
      });
    const [row] = await tx
      .select()
      .from(harnessCompositions)
      .where(and(eq(harnessCompositions.orgId, input.orgId), eq(harnessCompositions.compositionDigest, digest)))
      .limit(1);
    if (!row) throw new Error("harness composition was not persisted");
    assertPersistedIdentity(row);
    return row;
  });
}

export async function getHarnessComposition(
  db: Database["db"],
  orgId: string,
  compositionId: string,
): Promise<typeof harnessCompositions.$inferSelect | null> {
  return withOrgContext(db, orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(harnessCompositions)
      .where(and(eq(harnessCompositions.id, compositionId), eq(harnessCompositions.orgId, orgId)))
      .limit(1);
    if (row) assertPersistedIdentity(row);
    return row ?? null;
  });
}

export async function inspectHarnessComposition(
  db: Database["db"],
  orgId: string,
  compositionId: string,
): Promise<PersistedHarnessCompositionInspection | null> {
  const row = await getHarnessComposition(db, orgId, compositionId);
  if (!row) return null;
  const parts = parseHarnessComposition(row);
  return {
    id: row.id,
    ...inspectComposition({
      profile: parts.profile,
      profileDigest: row.profileDigest,
      compositionDigest: row.compositionDigest,
      bundles: parts.bundles,
      patches: parts.patches,
    }),
  };
}
