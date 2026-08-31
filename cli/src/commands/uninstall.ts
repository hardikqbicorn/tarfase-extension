import { ParsedArgs, optionBool, optionString } from "../args";
import { detectIdes, listInstalledExtensions, selectIdes, uninstallExtension } from "../ide";
import { EXTENSION_ID } from "../vsix";
import { clearHandoff, handoffPath } from "../handoff";
import { applyCollectorSettings, readSettings, writeSettings } from "../settings";
import { fail, heading, info, ok, warn } from "../output";

/**
 * `ide-collector uninstall`
 *
 * Removes the extension and clears any staged credential. Also flips
 * telemetry.enabled to false, so that if the extension is reinstalled later it
 * does not silently resume collecting on the strength of an old setting.
 */
export async function uninstallCommand(args: ParsedArgs): Promise<number> {
  const idePreference = optionString(args.options, "ide");
  const keepSettings = optionBool(args.options, "keep-settings");

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

  heading("Removing extension");
  for (const ide of targets) {
    const installed = await listInstalledExtensions(ide);
    if (!installed.some((e) => e.toLowerCase() === EXTENSION_ID.toLowerCase())) {
      info(`${ide.label}: not installed`);
      continue;
    }
    try {
      await uninstallExtension(ide, EXTENSION_ID);
      ok(`${ide.label}`);
    } catch (err) {
      warn(`${ide.label}`, err instanceof Error ? err.message : String(err));
    }
  }

  heading("Clearing local state");
  await clearHandoff();
  ok(`Removed any staged credential (${handoffPath()})`);

  if (!keepSettings) {
    for (const ide of targets) {
      try {
        const { settings, existed } = await readSettings(ide.settingsDir);
        if (!existed) continue;
        const merged = applyCollectorSettings(settings, { enabled: false });
        await writeSettings(ide.settingsDir, merged);
        ok(`${ide.label}: telemetry.enabled set to false`);
      } catch {
        // Non-fatal.
      }
    }
  }

  info("");
  info("The installation token in your OS keychain is left in place; the extension");
  info("removes it via \"IDE Collector: Sign Out and Clear Credentials\".");
  info("To revoke it server-side, an operator runs:");
  info("  POST /v1/installations/<id>/revoke");

  return 0;
}
