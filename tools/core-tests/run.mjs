// Runs aware-mod's pure tests (aware-mod/tests/core.test.ts) on plain Node, so
// they run where `claude plugin test` cannot: in CI, or with mods switched off.
// The engine-level tests (band.test.tsx) need the engine and stay on
// `claude plugin test aware-mod`.
//
//   node --experimental-strip-types tools/core-tests/run.mjs     (Node 22.6+)
//
// hooks.mjs points `claude-code/testing` at a node:test shim and resolves the
// extensionless relative imports the plugin's bundler accepts.

import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
await import('../../aware-mod/tests/core.test.ts')
