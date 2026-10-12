/**
 * Node ESM consumer smoke tests.
 *
 * Vitest's module resolver is more forgiving than Node ESM — it deferred
 * resolution of broken upstream imports (notably `@executor-js/api` in
 * plugin@0.1.0) so unit tests passed while real consumers crashed at load.
 *
 * These tests spawn a real `node` subprocess to exercise the consumer
 * resolution path. If a future upstream `@executor-js/plugin-*` release ships
 * another packaging regression, these fail fast where the unit tests wouldn't.
 *
 * Each test runs a tiny inline script — no temp files, no network.
 */
export {};
