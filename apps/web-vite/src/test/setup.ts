import { configure } from "@testing-library/react";

// Lazy Go-backed routes can take longer than the one-second default when the
// full suite runs every workspace and database test in parallel.
configure({ asyncUtilTimeout: 5_000 });
