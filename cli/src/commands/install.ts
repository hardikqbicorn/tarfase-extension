import { ParsedArgs, optionBool, optionString } from "../args";
import { DEFAULT_REPO, resolveVsix } from "../vsix";
import { detectIdes, installExtension, selectIdes } from "../ide";
import { applyCollectorSettings, readSettings, writeSettings } from "../settings";
import { fail, heading, indent, info, ok, step, warn } from "../output";

/**
 * `ide-collector install`
 *
 * Detects installed VS Code-family IDEs, resolves a .vsix, installs it, and
 * optionally writes the backend endpoints into the IDE's settings.
 *
 * Telemetry is NOT switched on here. Collection is opt-in by design, and a CLI
 * flag buried in an install command is not meaningful consent - `--enable` has
 * to be passed deliberately, and `login` prints how to turn it on otherwise.
 */
export async function installCommand(args: ParsedArgs): Promise<number> {
  const idePreference = optionString(args.options, "ide");
  const explicitVsix = optionString(args.options, "vsix");
  const version = optionString(args.options, "extension-version") ?? "latest";
  const repo = optionString(args.options, "repo") ?? DEFAULT_REPO;
  const ingestion = optionString(args.options, "endpoint");
  const registration = optionString(args.options, "registration-endpoint");
  const enable = optionBool(args.options, "enable");

  heading("Detecting IDEs");
  const detected = await detectIdes();

  if (detected.length === 0) {
    fail(
      "No VS Code-family IDE found on PATH.",
      [
        "Looked for the `code`, `cursor`, and `windsurf` commands.",
        "",
        "If one is installed, its shell command may not be on PATH:",
        "  VS Code  -> Command Palette -> Shell Command: Install 'code' command in PATH",
        "  Cursor   -> Command Palette -> Install 'cursor' command",
        "  Windsurf -> Command Palette -> Install 'windsurf' command",
      ].join("\n")
    );
    return 1;
  }

  for (const ide of detected) {
    ok(`${ide.label}${ide.version ? ` ${ide.version}` : ""}`);
  }

  let targets;
  try {
    targets = selectIdes(detected, idePreference);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // ---- Resolve the .vsix -----------------------------------------------------
  heading("Resolving extension package");
  let vsixPath: string;
  try {
    const resolved = await resolveVsix({
      explicit: explicitVsix,
      repo,
      version,
      token: process.env.GITHUB_TOKEN,
      onProgress: step,
    });
    vsixPath = resolved.path;
    ok(resolved.description);
  } catch (err) {
    fail(
      "Could not obtain the extension package.",
      err instanceof Error ? err.message : String(err)
    );
    return 1;
  }

  // ---- Install ---------------------------------------------------------------
  heading("Installing");
  let failures = 0;

  for (const ide of targets) {
    try {
      const output = await installExtension(ide, vsixPath);
      ok(`${ide.label}`);
      if (output) indent(output.split("\n").slice(-1)[0] ?? "");
    } catch (err) {
      failures++;
      fail(`${ide.label}`, err instanceof Error ? err.message : String(err));
    }
  }

  if (failures === targets.length) return 1;

  // ---- Settings --------------------------------------------------------------
  if (ingestion || registration || enable) {
    heading("Writing settings");
    for (const ide of targets) {
      try {
        const { settings } = await readSettings(ide.settingsDir);
        const merged = applyCollectorSettings(settings, {
          ingestionEndpoint: ingestion,
          registrationEndpoint: registration,
          enabled: enable ? true : undefined,
        });
        const { path, backupPath } = await writeSettings(ide.settingsDir, merged);
        ok(`${ide.label}: ${path}`);
        if (backupPath) {
          info(`backup written to ${backupPath}`);
        }
      } catch (err) {
        warn(
          `${ide.label}: could not update settings`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  // ---- Next steps ------------------------------------------------------------
  heading("Next steps");
  if (!enable) {
    info("1. Enable collection (it is off by default):");
    indent("ide-collector config set telemetry.enabled true", "     ");
    info("   or tick `telemetry.enabled` in the IDE's settings.");
    info("2. Register this installation:");
  } else {
    info("1. Register this installation:");
  }
  indent("ide-collector login --code <enrollment-code>", "     ");
  info("Then restart the IDE so the extension picks up the credential.");

  return 0;
}
