import { ParsedArgs, optionString } from "../args";
import { detectIdes, selectIdes } from "../ide";
import { readSettings, writeSettings } from "../settings";
import { fail, heading, info, ok } from "../output";

/**
 * `ide-collector config get|set`
 *
 * Only keys under the `telemetry.` prefix are writable. The CLI has no business
 * editing arbitrary IDE settings, and refusing anything else means a typo
 * cannot silently rewrite an unrelated key.
 */

const WRITABLE_PREFIX = "telemetry.";

const BOOLEAN_KEYS = new Set([
  "telemetry.enabled",
  "telemetry.redactSecrets",
  "telemetry.hashFilePaths",
  "telemetry.encryptLocalQueue",
  "telemetry.capture.workspace",
  "telemetry.capture.file",
  "telemetry.capture.editor",
  "telemetry.capture.terminal",
  "telemetry.capture.git",
  "telemetry.capture.buildTestDebug",
  "telemetry.capture.ai",
]);

const NUMBER_KEYS = new Set([
  "telemetry.batchSize",
  "telemetry.flushInterval",
  "telemetry.maxQueueSize",
  "telemetry.throttle.cursorMovedMs",
  "telemetry.throttle.selectionChangedMs",
  "telemetry.throttle.documentChangedMs",
  "telemetry.throttle.diagnosticsMs",
]);

export function coerceSettingValue(key: string, raw: string): boolean | number | string {
  if (BOOLEAN_KEYS.has(key)) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`${key} expects true or false, got "${raw}"`);
  }
  if (NUMBER_KEYS.has(key)) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`${key} expects a number, got "${raw}"`);
    return parsed;
  }
  return raw;
}

export async function configCommand(args: ParsedArgs): Promise<number> {
  const [action, key, value] = args.positionals;
  const idePreference = optionString(args.options, "ide");

  if (action !== "get" && action !== "set") {
    fail("Usage: ide-collector config get <key> | ide-collector config set <key> <value>");
    return 1;
  }

  const detected = await detectIdes();
  if (detected.length === 0) {
    fail("No VS Code-family IDE found on PATH.");
    return 1;
  }

  let targets;
  try {
    targets = selectIdes(detected, idePreference);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // ---- get -------------------------------------------------------------------
  if (action === "get") {
    heading("Settings");
    for (const ide of targets) {
      const { settings } = await readSettings(ide.settingsDir);
      if (key) {
        info(`${ide.label}: ${key} = ${JSON.stringify(settings[key] ?? null)}`);
      } else {
        const collectorKeys = Object.keys(settings)
          .filter((k) => k.startsWith(WRITABLE_PREFIX))
          .sort();
        info(`${ide.label}:`);
        if (collectorKeys.length === 0) info("  (none set)");
        for (const k of collectorKeys) info(`  ${k} = ${JSON.stringify(settings[k])}`);
      }
    }
    return 0;
  }

  // ---- set -------------------------------------------------------------------
  if (!key || value === undefined) {
    fail("Usage: ide-collector config set <key> <value>");
    return 1;
  }

  if (!key.startsWith(WRITABLE_PREFIX)) {
    fail(
      `Refusing to write "${key}".`,
      `This command only writes ${WRITABLE_PREFIX}* keys. Change anything else through the IDE.`
    );
    return 1;
  }

  let coerced: boolean | number | string;
  try {
    coerced = coerceSettingValue(key, value);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }

  heading("Updating settings");
  for (const ide of targets) {
    try {
      const { settings } = await readSettings(ide.settingsDir);
      settings[key] = coerced;
      const { path, backupPath } = await writeSettings(ide.settingsDir, settings);
      ok(`${ide.label}: ${key} = ${JSON.stringify(coerced)}`);
      info(path);
      if (backupPath) info(`backup: ${backupPath}`);
    } catch (err) {
      fail(`${ide.label}`, err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  info("");
  info("Reload the IDE window for the change to take effect.");
  return 0;
}
