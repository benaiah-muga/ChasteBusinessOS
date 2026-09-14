import { chasteVitestDbSetup } from "@chaste/db/test-fixture";

export const { setup, teardown } = chasteVitestDbSetup({ prefix: "mfg" });
