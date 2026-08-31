import { build } from "esbuild";

/**
 * Bundles the extension into a single file.
 *
 * A .vsix ships no node_modules, and this extension imports four workspace
 * packages (@ide-collector/*) that live outside its own directory. Without
 * bundling, an installed extension fails on activation with "Cannot find
 * module '@ide-collector/event-schema'" - it packages cleanly and then does
 * nothing, which is the worst way for this to break.
 *
 * `vscode` stays external: it is injected by the extension host and has no
 * package to resolve. Node builtins are external for the same reason.
 */
const production = process.argv.includes("--production");

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "bundle/extension.js",
  platform: "node",
  format: "cjs",
  // Matches the Node version in the engines' VS Code range.
  target: "node18",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "warning",
});
