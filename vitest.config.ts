import { defineConfig } from "vitest/config";
import { resolve } from "path";

/**
 * Tests run against package *sources* (not built `dist/`) so `npm test` works
 * on a fresh clone without a build step and gives accurate coverage.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ide-collector/event-schema": resolve(
        __dirname,
        "packages/event-schema/src/index.ts",
      ),
      "@ide-collector/crypto": resolve(
        __dirname,
        "packages/crypto/src/index.ts",
      ),
      "@ide-collector/shared-utils": resolve(
        __dirname,
        "packages/shared-utils/src/index.ts",
      ),
      "@ide-collector/event-sdk": resolve(
        __dirname,
        "packages/event-sdk/src/index.ts",
      ),
      // The extension imports the real `vscode` module, which only exists
      // inside a running IDE. Aliasing it to a stub lets the collectors be
      // exercised for real in unit tests.
      vscode: resolve(__dirname, "extensions/vscode/test/vscode-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "services/**/*.test.ts",
      "extensions/vscode/src/**/*.test.ts",
      "scripts/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
