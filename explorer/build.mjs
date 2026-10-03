// Bundles the team console's own modules (../team-console/src) into engine.js for the browser.
// The AI calls are not bundled: with no key, the graphs use the backend's own rules and templates.
import { build } from 'esbuild';

await build({
  entryPoints: ['entry.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'XE',
  platform: 'browser',
  target: 'es2020',
  charset: 'utf8',
  minify: false,
  minifySyntax: true,
  legalComments: 'none',
  define: { 'process.env.GRAPH_ENGINE': '"built-in"' }, // the backend's built-in runner executes the same graph definition
  external: ['@langchain/langgraph'],
  outfile: 'engine.js',
  logLevel: 'warning',
});
console.log('engine.js written');
