import { Mastra } from "@mastra/core";

export interface MastraConfig {
  databaseUrl: string;
  schemaName?: string;
}

export function createMastraInstance(cfg: MastraConfig) {
  // Mastra PG storage requires proper SCRAM auth which conflicts with
  // local trust auth setups. Initialize lazily and gracefully degrade.
  const mastra = new Mastra({
    storage: undefined,
    vectors: undefined,
  });

  return mastra;
}

export async function createMastraInstanceWithStorage(cfg: MastraConfig): Promise<Mastra> {
  try {
    const { PostgresStore, PgVector } = await import("@mastra/pg");

    const schemaName = cfg.schemaName ?? "mastra";

    const store = new PostgresStore({
      id: "chaste-storage",
      connectionString: cfg.databaseUrl,
      schemaName,
    });

    const vector = new PgVector({
      id: "chaste-vector",
      connectionString: cfg.databaseUrl,
      schemaName,
    });

    const mastra = new Mastra({
      storage: store,
      vectors: { default: vector },
    });

    console.log("Mastra PG storage initialized successfully");
    return mastra;
  } catch (err) {
    console.warn("Mastra PG storage unavailable, using in-memory:", (err as Error).message);
    return new Mastra({
      storage: undefined,
      vectors: undefined,
    });
  }
}

export type ChasteMastra = Mastra;
