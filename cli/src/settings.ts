import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";

/**
 * Reads and writes an IDE's user settings.json.
 *
 * VS Code settings files are JSON with comments and trailing commas (JSONC),
 * which JSON.parse rejects. Rather than pull in a JSONC parser, comments and
 * trailing commas are stripped before parsing, and the file is rewritten as
 * plain JSON. That loses a user's comments, so `set` explains what it is about
 * to touch and every write goes through a backup first.
 */

export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    out += ch;
  }

  // Trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function readSettings(
  settingsDir: string
): Promise<{ path: string; settings: Record<string, unknown>; existed: boolean }> {
  const path = join(settingsDir, "settings.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw) || "{}") as Record<string, unknown>;
    return { path, settings: parsed, existed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, settings: {}, existed: false };
    }
    throw new Error(
      `Could not parse ${path}: ${err instanceof Error ? err.message : String(err)}\n` +
        `Fix the file by hand, or set the values through the IDE's settings UI.`
    );
  }
}

export async function writeSettings(
  settingsDir: string,
  settings: Record<string, unknown>
): Promise<{ path: string; backupPath?: string }> {
  const path = join(settingsDir, "settings.json");
  await mkdir(settingsDir, { recursive: true });

  let backupPath: string | undefined;
  try {
    const existing = await readFile(path, "utf8");
    backupPath = `${path}.ide-collector-backup`;
    await writeFile(backupPath, existing, { mode: 0o600 });
  } catch {
    // No existing file to back up.
  }

  // Temp file + rename, so an interrupted write cannot leave settings truncated.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n");
  await rename(tmp, path);

  return { path, backupPath };
}

export interface CollectorSettings {
  ingestionEndpoint?: string;
  registrationEndpoint?: string;
  enabled?: boolean;
}

/** Merges collector settings into an existing settings object, leaving everything else alone. */
export function applyCollectorSettings(
  settings: Record<string, unknown>,
  values: CollectorSettings
): Record<string, unknown> {
  const merged = { ...settings };
  if (values.enabled !== undefined) merged["telemetry.enabled"] = values.enabled;
  if (values.ingestionEndpoint !== undefined) {
    merged["telemetry.ingestionEndpoint"] = values.ingestionEndpoint;
  }
  if (values.registrationEndpoint !== undefined) {
    merged["telemetry.registrationEndpoint"] = values.registrationEndpoint;
  }
  return merged;
}
