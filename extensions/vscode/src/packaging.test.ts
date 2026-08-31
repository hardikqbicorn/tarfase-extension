import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const extensionRoot = join(__dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(extensionRoot, "package.json"), "utf8")
) as { main: string };
const bundlePath = join(extensionRoot, manifest.main);

/**
 * A .vsix ships no node_modules, and this extension imports four workspace
 * packages. Unbundled, it packages cleanly and then fails on activation with
 * "Cannot find module '@ide-collector/event-schema'" - installed, listed, and
 * doing nothing. These check the artifact that actually ships.
 *
 * The bundle only exists after a build, so on a fresh clone (where `npm test`
 * is meant to work without one) there is nothing to check. CI builds first.
 */
const hasBundle = existsSync(bundlePath);
const whenBuilt = hasBundle ? it : it.skip;

describe("packaged extension", () => {
  it("points main at the bundler's output, not tsc's", () => {
    expect(manifest.main).toMatch(/^\.\/bundle\//);
  });

  it("excludes build inputs and tsc output from the .vsix", () => {
    const ignored = readFileSync(join(extensionRoot, ".vscodeignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());

    for (const pattern of ["src/**", "dist/**", "node_modules/**", ".env"]) {
      expect(ignored).toContain(pattern);
    }
  });

  whenBuilt("inlines the workspace packages", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle).not.toMatch(/require\(["']@ide-collector\//);
  });

  whenBuilt("leaves only vscode and node builtins to resolve at runtime", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    const required = new Set(
      [...bundle.matchAll(/require\(["']([^"')]+)["']\)/g)].map((m) => m[1])
    );

    for (const request of required) {
      const bare = request.replace(/^node:/, "").split("/")[0];
      expect(
        request === "vscode" || BUILTINS.has(bare),
        `bundle requires "${request}", which a .vsix cannot resolve`
      ).toBe(true);
    }
  });
});

/** Modules the extension host resolves for us; everything else must be inlined. */
const BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "console",
  "constants",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);
