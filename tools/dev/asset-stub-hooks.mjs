/**
 * Node module hooks that stub non-code assets (CSS) when tests import UI components
 * under node:test. Vite handles these imports in the real build; here they resolve to
 * an empty module so DOM-free render tests can import components that import their
 * stylesheet. Registered by tools/dev/test-hooks.mjs.
 */
const ASSET_RE = /\.(css)(\?.*)?$/;

export async function resolve(specifier, context, nextResolve) {
  if (ASSET_RE.test(specifier)) {
    const parent = context.parentURL ?? `file://${process.cwd()}/`;
    return { url: new URL(specifier, parent).href, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (ASSET_RE.test(url)) return { format: 'module', source: 'export default "";', shortCircuit: true };
  return nextLoad(url, context);
}
