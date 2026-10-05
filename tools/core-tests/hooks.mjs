// Module resolution for run.mjs: `claude-code/testing` is the shim beside this
// file, and `../hooks/core` (no extension, as the plugin's bundler allows) is
// `../hooks/core.ts`.

const SHIM = new URL('./claude-code-testing.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'claude-code/testing') return { url: SHIM, shortCircuit: true }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    if (isRelative && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    throw err
  }
}
