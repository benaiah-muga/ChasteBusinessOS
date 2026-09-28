# React and Go build baseline

Measured on 2026-09-28 from commit `8262d5082def982cdf6a77a649efb3b04a130c5f`.
The benchmark ran ten sequential production builds per stack with shared dependency
and compiler caches left warm. Each sample records GNU `time` wall time and peak
resident memory. Raw samples and toolchain details are in
[`benchmarks/phase-0-builds.json`](benchmarks/phase-0-builds.json).

| Build | Command scope | Median wall time | p95 wall time | Median peak memory |
|---|---|---:|---:|---:|
| Next.js | Full current app, TypeScript, static generation, route output | 25.225 s | 28.850 s | 797.1 MiB |
| Vite | Current React shell, TypeScript, 165 transformed modules | 11.035 s | 12.900 s | 611.5 MiB |
| Go | API, jobs worker, and outbox worker binaries | 2.205 s | 2.550 s | 229.0 MiB |

The Vite result is not a like-for-like speed comparison: Vite currently builds
the shell, while Next builds 30 pages and the legacy API surface. The Go result
is reported separately because it compiles server binaries. These measurements
establish repeatable build baselines and do not establish a speedup or parity.

The Next build emitted existing Better Auth warnings because `BETTER_AUTH_URL`
is unset and Turbopack warnings about dynamic filesystem access in coding-agent
connections. Builds still succeeded. The Vite and Go builds had no reported
failures.

This baseline covers production build wall time and memory only. Dev startup,
edit-to-ready, HTTP latency and throughput, browser navigation, demo fixtures,
and request-level parity remain open phase 0 work. Browser checks were deferred
by the user for this migration session.
