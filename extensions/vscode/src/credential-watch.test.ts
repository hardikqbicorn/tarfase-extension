import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { startCredentialWatch, type CredentialWatch } from "./credential-watch";

const FILENAME = "pending-credential.json";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls rather than sleeping a fixed time, so the test is not timing-fragile. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

describe("startCredentialWatch", () => {
  let root: string;
  let dir: string;
  let watch: CredentialWatch | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cred-watch-"));
    // Deliberately not created: the watch has to make its own directory, which
    // is the state a machine is in before the CLI has ever run.
    dir = join(root, ".ide-collector");
  });

  afterEach(async () => {
    watch?.close();
    watch = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it("imports a credential that appears after the watch starts", async () => {
    let imported = 0;
    let started = 0;

    watch = startCredentialWatch({
      dir,
      filename: FILENAME,
      onCandidate: async () => {
        imported++;
        return true;
      },
      onImported: async () => {
        started++;
      },
    });
    await watch.ready;

    await writeFile(join(dir, FILENAME), "{}");

    expect(await until(() => started > 0)).toBe(true);
    expect(imported).toBeGreaterThan(0);
  });

  it("does not start the collector when nothing was staged", async () => {
    let started = 0;

    watch = startCredentialWatch({
      dir,
      filename: FILENAME,
      onCandidate: async () => false,
      onImported: async () => {
        started++;
      },
    });
    await watch.ready;

    await watch.check();
    expect(started).toBe(0);
  });

  it("ignores other files in the directory", async () => {
    let candidates = 0;

    watch = startCredentialWatch({
      dir,
      filename: FILENAME,
      onCandidate: async () => {
        candidates++;
        return false;
      },
      onImported: async () => undefined,
    });
    await watch.ready;

    await writeFile(join(dir, "unrelated.log"), "noise");
    await sleep(150);

    expect(candidates).toBe(0);
  });

  it("collapses overlapping checks into one import", async () => {
    // A single write produces several fs events, and the focus trigger can
    // land among them. Each must not become its own collector restart.
    let inFlight = 0;
    let maxInFlight = 0;
    let imports = 0;

    watch = startCredentialWatch({
      dir,
      filename: FILENAME,
      onCandidate: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(50);
        inFlight--;
        imports++;
        return false;
      },
      onImported: async () => undefined,
    });
    await watch.ready;

    await Promise.all([watch.check(), watch.check(), watch.check()]);

    expect(maxInFlight).toBe(1);
    expect(imports).toBe(1);
  });

  it("surfaces an import failure instead of throwing into the watcher", async () => {
    const errors: string[] = [];

    watch = startCredentialWatch({
      dir,
      filename: FILENAME,
      onCandidate: async () => {
        throw new Error("keychain unavailable");
      },
      onImported: async () => undefined,
      onError: (error) => errors.push(error.message),
    });
    await watch.ready;

    await watch.check();
    expect(errors).toEqual(["keychain unavailable"]);
  });

  it("stops checking once closed", async () => {
    let candidates = 0;

    watch = startCredentialWatch({
      dir,
      filename: FILENAME,
      onCandidate: async () => {
        candidates++;
        return false;
      },
      onImported: async () => undefined,
    });
    await watch.ready;
    watch.close();

    await writeFile(join(dir, FILENAME), "{}");
    await watch.check();
    await sleep(150);

    expect(candidates).toBe(0);
  });
});
