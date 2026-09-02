import { ParsedArgs, optionBool, optionString } from "../args";
import { detectIdes, installExtension, selectIdes, IdeTarget } from "../ide";
import { DEFAULT_REPO, resolveVsix } from "../vsix";
import { registerInstallation } from "../register";
import { writeHandoff } from "../handoff";
import { applyCollectorSettings, readSettings, writeSettings } from "../settings";
import { confirm, isInteractive } from "../prompt";
import { bold, dim, fail, heading, indent, info, ok, step, warn } from "../output";

/**
 * `ide-collector setup` - the whole thing in one command.
 *
 * install + config + login run as one sequence: detect the IDEs, install the
 * extension, ask for consent, write the endpoints, turn collection on,
 * register, and stage the credential. The individual commands remain for
 * anything that needs them separately; this is the path a new user takes.
 *
 * The consent prompt is the one thing that does not collapse into the flag
 * list. `install` deliberately does not enable collection because a flag
 * buried in an install command is not meaningful consent - and folding the
 * steps together must not smuggle that back in. So `setup` prints what will
 * and will not be collected and waits for an answer, and without a terminal to
 * ask it stops and tells you to pass `--yes`.
 */

const CONSENT_NOTICE = `
Collection is off until you agree. Once on, the extension records:

  - files opened, saved, created, renamed and deleted (paths and languages)
  - which functions, classes and variables each save changed, by name, and
    how many lines - never the code itself
  - editing activity: cursor moves, selections, document changes
  - git activity: branch checkouts, commits, pulls, pushes, merges
  - builds, tests, debug sessions and diagnostics
  - terminal command names and exit codes
  - AI assistant activity, when the IDE exposes it

It never records:

  - passwords, API keys, tokens or other credentials
  - environment variables or the contents of .env files
  - private keys, and the contents of your files - no line of source code
    leaves your machine, only its structure
  - your command arguments beyond the command name

Anything matching a secret pattern is redacted before it leaves your machine,
and again at ingestion. You can turn collection off at any time with:

  ide-collector config set telemetry.enabled false
`.trim();

export async function setupCommand(args: ParsedArgs): Promise<number> {
  const idePreference = optionString(args.options, "ide");
  const explicitVsix = optionString(args.options, "vsix");
  const version = optionString(args.options, "extension-version") ?? "latest";
  const repo = optionString(args.options, "repo") ?? DEFAULT_REPO;
  const code = optionString(args.options, "code");
  const assumeYes = optionBool(args.options, "yes");

  const ingestionEndpoint =
    optionString(args.options, "endpoint") ??
    optionString(args.options, "ingestion-endpoint") ??
    "http://localhost:8080";
  const registrationEndpoint =
    optionString(args.options, "registration-endpoint") ?? "http://localhost:8081";

  // ---- 1. Detect --------------------------------------------------------------
  heading("1/4  Finding your IDE");
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

  let targets: IdeTarget[];
  try {
    targets = selectIdes(detected, idePreference);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }

  for (const ide of targets) {
    ok(`${ide.label}${ide.version ? ` ${ide.version}` : ""}`);
  }

  // ---- 2. Consent -------------------------------------------------------------
  // Asked before installing anything, so declining costs nothing and leaves the
  // machine as it was.
  heading("2/4  What gets collected");
  console.log(dim(CONSENT_NOTICE));
  console.log("");

  if (!assumeYes) {
    if (!isInteractive()) {
      fail(
        "Cannot ask for consent without a terminal.",
        [
          "This looks like a script or a pipe, so there is nobody to answer the prompt.",
          "Re-run with --yes to confirm the notice above up front:",
          "",
          "  ide-collector setup --yes",
        ].join("\n")
      );
      return 1;
    }

    const agreed = await confirm(`${bold("Turn collection on?")} [y/N]`);
    if (!agreed) {
      info("Nothing was installed or changed.");
      return 1;
    }
  } else {
    info("Consent given with --yes.");
  }

  // ---- 3. Install -------------------------------------------------------------
  heading("3/4  Installing the extension");

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
    fail("Could not obtain the extension package.", err instanceof Error ? err.message : String(err));
    return 1;
  }

  const installed: IdeTarget[] = [];
  for (const ide of targets) {
    try {
      await installExtension(ide, vsixPath);
      ok(`Installed into ${ide.label}`);
      installed.push(ide);
    } catch (err) {
      fail(`${ide.label}`, err instanceof Error ? err.message : String(err));
    }
  }

  if (installed.length === 0) {
    fail("The extension could not be installed into any IDE.");
    return 1;
  }

  // Endpoints and the enable flag go in together: an IDE that is switched on
  // but still pointing at the previous backend is a worse state than either.
  for (const ide of installed) {
    try {
      const { settings } = await readSettings(ide.settingsDir);
      const merged = applyCollectorSettings(settings, {
        enabled: true,
        ingestionEndpoint,
        registrationEndpoint,
      });
      const { backupPath } = await writeSettings(ide.settingsDir, merged);
      ok(`Configured ${ide.label} and enabled collection`);
      if (backupPath) info(dim(`previous settings backed up to ${backupPath}`));
    } catch (err) {
      warn(
        `${ide.label}: could not write settings`,
        [
          err instanceof Error ? err.message : String(err),
          "Set telemetry.enabled and the endpoints from the IDE's settings UI instead.",
        ].join("\n")
      );
    }
  }

  // ---- 4. Register ------------------------------------------------------------
  heading("4/4  Registering this installation");
  info(dim(`Control plane: ${registrationEndpoint}`));

  const outcome = await registerInstallation({
    registrationEndpoint,
    code,
    ideName: installed[0].id,
  });

  if (!outcome.ok) {
    fail(outcome.message, outcome.detail);
    // The extension is installed and configured, so the remaining work is one
    // command rather than a repeat of the whole setup. Say so, rather than
    // leaving a half-finished machine looking like a total failure.
    heading("Partly done");
    info("The extension is installed and configured; only registration failed.");
    info("Once the backend is reachable, finish with:");
    indent(
      `ide-collector login${code ? ` --code ${code}` : ""} \\\n  --registration-endpoint ${registrationEndpoint} \\\n  --ingestion-endpoint ${ingestionEndpoint}`,
      "     "
    );
    return 1;
  }

  ok(`Registered as installation ${outcome.payload.installation_id.slice(0, 8)}...`);

  const handoff = await writeHandoff({
    installation_id: outcome.payload.installation_id,
    installation_token: outcome.payload.installation_token,
    user_id: outcome.payload.user_id,
    ingestion_endpoint: ingestionEndpoint,
    registration_endpoint: registrationEndpoint,
  });
  ok("Credential staged for the extension");
  info(dim(`${handoff} (mode 0600, expires in 30 minutes)`));

  // ---- Done -------------------------------------------------------------------
  heading("Done");
  info("Open your IDE. The extension picks the credential up within a few seconds,");
  info("moves it into your OS keychain, and starts collecting.");
  info("");
  info("Check it is running:");
  indent("ide-collector doctor", "     ");
  info("Turn it off at any time:");
  indent("ide-collector config set telemetry.enabled false", "     ");

  return 0;
}
