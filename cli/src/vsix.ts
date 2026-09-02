import { createWriteStream } from "fs";
import { mkdir, readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

/**
 * Locating the extension package to install.
 *
 * Three sources, in the order `install` tries them:
 *   1. --vsix <path>        an explicit local file
 *   2. a local build        extensions/vscode/*.vsix, for contributors
 *   3. a GitHub release     the published artifact, for everyone else
 */

export const DEFAULT_REPO = "hardikqbicorn/tarfase-extension";
/**
 * `publisher.name` from extensions/vscode/package.json - the id VS Code
 * reports from `--list-extensions` and accepts for `--uninstall-extension`.
 *
 * Duplicated here rather than imported because the CLI ships without the
 * repository. A test asserts the two stay in step, which is how a rename gets
 * caught rather than silently breaking `doctor` and `uninstall`.
 */
export const EXTENSION_ID = "Tarfase.tarfase";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
}

/** Finds a .vsix built locally in the repo, if the CLI is run from a checkout. */
export async function findLocalVsix(
  searchDir: string,
): Promise<string | undefined> {
  try {
    const entries = await readdir(searchDir);
    const candidates = entries.filter((e) => e.endsWith(".vsix")).sort();
    if (candidates.length === 0) return undefined;
    // Last by name is the highest version under the usual name-x.y.z.vsix scheme.
    return join(searchDir, candidates[candidates.length - 1]);
  } catch {
    return undefined;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

export interface FetchLike {
  (
    url: string,
    init?: { headers?: Record<string, string> },
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    json(): Promise<unknown>;
    body: unknown;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

/**
 * Reads release metadata from the GitHub API.
 *
 * `version` may be "latest" or a tag. The token is optional and only needed
 * for a private repository or to avoid the unauthenticated rate limit.
 */
export async function fetchReleaseInfo(
  repo: string,
  version: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  token?: string,
): Promise<ReleaseInfo> {
  const path =
    version === "latest"
      ? "releases/latest"
      : `releases/tags/${encodeURIComponent(version)}`;
  const url = `https://api.github.com/repos/${repo}/${path}`;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "ide-collector-cli",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetchImpl(url, { headers });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `No release "${version}" found for ${repo}.\n` +
          `If the extension has not been released yet, build it locally and install that:\n` +
          `  npm run build -w extensions/vscode && npx vsce package\n` +
          `  ide-collector install --vsix extensions/vscode/<file>.vsix`,
      );
    }
    if (response.status === 403) {
      throw new Error(
        `GitHub API rate limit or access denied (403).\n` +
          `Set GITHUB_TOKEN to raise the limit, or pass --vsix with a local file.`,
      );
    }
    throw new Error(
      `GitHub API returned ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as ReleaseInfo;
}

export function selectVsixAsset(release: ReleaseInfo): ReleaseAsset {
  const asset = release.assets?.find((a) => a.name.endsWith(".vsix"));
  if (!asset) {
    throw new Error(
      `Release ${release.tag_name} has no .vsix asset attached.\n` +
        `Assets present: ${release.assets?.map((a) => a.name).join(", ") || "none"}`,
    );
  }
  return asset;
}

/** Downloads an asset to a temp directory and returns the local path. */
export async function downloadAsset(
  asset: ReleaseAsset,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  targetDir = join(tmpdir(), "ide-collector-cli"),
): Promise<string> {
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, asset.name);

  const response = await fetchImpl(asset.browser_download_url, {
    headers: { "user-agent": "ide-collector-cli" },
  });
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  }

  await mkdir(dirname(target), { recursive: true });

  if (response.body) {
    // Stream to disk so a large artifact is not held in memory.
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(target),
    );
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    await pipeline(Readable.from(buffer), createWriteStream(target));
  }

  return target;
}

/** Walks up from `startDir` looking for a repo checkout containing the extension. */
export async function findRepoExtensionDir(
  startDir: string,
): Promise<string | undefined> {
  let current = resolve(startDir);

  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(current, "extensions", "vscode");
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch {
      // keep walking up
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

export interface ResolvedVsix {
  path: string;
  /** Which of the three sources it came from, for reporting. */
  origin: "explicit" | "local-build" | "release";
  description: string;
}

/**
 * Applies the three-source order above and reports which one won.
 *
 * Shared by `install` and `setup` so the two cannot drift into resolving the
 * package differently - the surprise of `setup` downloading a release while
 * `install` picks up a stale local build would be hard to diagnose.
 */
export async function resolveVsix(options: {
  explicit?: string;
  repo?: string;
  version?: string;
  cwd?: string;
  token?: string;
  onProgress?: (message: string) => void;
}): Promise<ResolvedVsix> {
  const { explicit, onProgress } = options;
  const repo = options.repo ?? DEFAULT_REPO;
  const version = options.version ?? "latest";

  if (explicit) {
    if (!(await fileExists(explicit))) {
      throw new Error(`No file at ${explicit}`);
    }
    return { path: explicit, origin: "explicit", description: `Using ${explicit}` };
  }

  const repoExtensionDir = await findRepoExtensionDir(options.cwd ?? process.cwd());
  if (repoExtensionDir) {
    const local = await findLocalVsix(repoExtensionDir);
    if (local) {
      return { path: local, origin: "local-build", description: `Using locally built ${local}` };
    }
  }

  onProgress?.(`Fetching the ${version} release from ${repo}`);
  const release = await fetchReleaseInfo(repo, version, undefined, options.token);
  const asset = selectVsixAsset(release);
  const path = await downloadAsset(asset);
  return {
    path,
    origin: "release",
    description: `Downloaded ${asset.name} (${release.tag_name})`,
  };
}
