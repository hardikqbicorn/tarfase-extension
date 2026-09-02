import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Detection of installed VS Code-family IDEs.
 *
 * Each fork ships its own CLI shim (`code`, `cursor`, `windsurf`) that accepts
 * `--install-extension`. Detection is by running `<cli> --version`, not by
 * probing paths: a working CLI on PATH is exactly the precondition `install`
 * needs, so testing for it directly avoids finding an app bundle whose shim was
 * never added to PATH.
 */

export type IdeId = "vscode" | "cursor" | "windsurf";

export interface IdeTarget {
  id: IdeId;
  /** Human name for output. */
  label: string;
  /** CLI command used to install extensions. */
  command: string;
  /** Version reported by `<command> --version`, when detected. */
  version?: string;
  /** Directory holding the IDE's user settings.json. */
  settingsDir: string;
}

export const KNOWN_IDES: Array<Omit<IdeTarget, "version">> = [
  {
    id: "vscode",
    label: "VS Code",
    command: "code",
    settingsDir: userSettingsDir("Code"),
  },
  {
    id: "cursor",
    label: "Cursor",
    command: "cursor",
    settingsDir: userSettingsDir("Cursor"),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    command: "windsurf",
    settingsDir: userSettingsDir("Windsurf"),
  },
];

/**
 * Per-platform location of an IDE's user settings.json.
 * macOS:   ~/Library/Application Support/<Name>/User
 * Windows: %APPDATA%\<Name>\User
 * Linux:   ~/.config/<Name>/User
 */
export function userSettingsDir(appName: string, platform = process.platform): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", appName, "User");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, appName, "User");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), appName, "User");
}

export type CommandRunner = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: CommandRunner = async (command, args) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/** Returns the IDEs whose CLI responds to `--version`. */
export async function detectIdes(run: CommandRunner = defaultRunner): Promise<IdeTarget[]> {
  const found: IdeTarget[] = [];

  for (const ide of KNOWN_IDES) {
    try {
      const { stdout } = await run(ide.command, ["--version"]);
      // `code --version` prints version, commit, arch on three lines.
      const version = stdout.split("\n")[0]?.trim() || undefined;
      found.push({ ...ide, version });
    } catch {
      // Not installed, or its CLI shim is not on PATH.
    }
  }

  return found;
}

export async function installExtension(
  ide: IdeTarget,
  vsixPath: string,
  run: CommandRunner = defaultRunner
): Promise<string> {
  const { stdout, stderr } = await run(ide.command, [
    "--install-extension",
    vsixPath,
    "--force",
  ]);
  return (stdout || stderr).trim();
}

export async function uninstallExtension(
  ide: IdeTarget,
  extensionId: string,
  run: CommandRunner = defaultRunner
): Promise<string> {
  const { stdout, stderr } = await run(ide.command, ["--uninstall-extension", extensionId]);
  return (stdout || stderr).trim();
}

export async function listInstalledExtensions(
  ide: IdeTarget,
  run: CommandRunner = defaultRunner
): Promise<string[]> {
  try {
    const { stdout } = await run(ide.command, ["--list-extensions"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolves the `--ide` flag against what is installed.
 * Returns every detected IDE when no preference is given, so `install` can
 * target all of them rather than guessing which one the user meant.
 */
export function selectIdes(detected: IdeTarget[], preference?: string): IdeTarget[] {
  if (!preference) return detected;

  const wanted = preference.toLowerCase();
  const match = detected.filter((ide) => ide.id === wanted);
  if (match.length === 0) {
    const names = detected.map((i) => i.id).join(", ") || "none detected";
    throw new Error(
      `No installed IDE matches --ide ${preference}. Detected: ${names}.\n` +
        `If the IDE is installed, its command-line shim may not be on PATH.\n` +
        `In VS Code: Command Palette -> "Shell Command: Install 'code' command in PATH".`
    );
  }
  return match;
}
