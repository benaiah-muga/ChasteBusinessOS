import { chasteVitestDbSetup } from "./src/test-fixture";

export const { setup, teardown } = chasteVitestDbSetup({ prefix: "db" });
