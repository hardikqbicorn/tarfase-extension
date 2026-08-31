import { ParsedArgs, optionString } from "../args";
import { detectIdes, listInstalledExtensions } from "../ide";
import { EXTENSION_ID } from "../vsix";
import { handoffPath, readHandoff } from "../handoff";
import { readSettings } from "../settings";
import { fail, heading, indent, info, ok, warn } from "../output";

/**
 * `ide-collector doctor`
 *
 * Answers "why isn't this working" without making the user read logs. Each
 * check reports the remedy rather than the raw symptom, in the order things
 * actually break: IDE present -> extension installed -> collection enabled ->
 * registered -> backend reachable.
 */
export async function doctorCommand(args: ParsedArgs): Promise<number> {
  const ingestionOverride = optionString(args.options, "endpoint");
  let problems = 0;

  // ---- IDEs ------------------------------------------------------------------
  heading("IDEs");
  const detected = await detectIdes();
  if (detected.length === 0) {
    problems++;
    fail(
      "No VS Code-family IDE found on PATH.",
      "Install the IDE's shell command: Command Palette -> \"Shell Command: Install 'code' command in PATH\"."
    );
  } else {
    for (const ide of detected) ok(`${ide.label}${ide.version ? ` ${ide.version}` : ""}`);
  }

  // ---- Extension installed ---------------------------------------------------
  heading("Extension");
  let installedAnywhere = false;
  for (const ide of detected) {
    const extensions = await listInstalledExtensions(ide);
    const installed = extensions.some((e) => e.toLowerCase() === EXTENSION_ID.toLowerCase());
    if (installed) {
      installedAnywhere = true;
      ok(`Installed in ${ide.label}`);
    } else {
      warn(`Not installed in ${ide.label}`, "Run: ide-collector install");
    }
  }
  if (detected.length > 0 && !installedAnywhere) problems++;

  // ---- Settings --------------------------------------------------------------
  heading("Configuration");
  let ingestionEndpoint = ingestionOverride ?? "http://localhost:8080";
  let enabledAnywhere = false;

  for (const ide of detected) {
    try {
      const { settings, existed } = await readSettings(ide.settingsDir);
      const enabled = settings["telemetry.enabled"] === true;
      const endpoint = settings["telemetry.ingestionEndpoint"];

      if (enabled) {
        enabledAnywhere = true;
        ok(`${ide.label}: collection enabled`);
      } else {
        warn(
          `${ide.label}: collection is off`,
          existed
            ? "Run: ide-collector config set telemetry.enabled true"
            : "No settings.json yet. Run: ide-collector config set telemetry.enabled true"
        );
      }

      if (typeof endpoint === "string" && !ingestionOverride) ingestionEndpoint = endpoint;
    } catch (err) {
      warn(`${ide.label}: could not read settings`, err instanceof Error ? err.message : "");
    }
  }
  if (detected.length > 0 && !enabledAnywhere) problems++;

  // ---- Credential ------------------------------------------------------------
  heading("Credential");
  const handoff = await readHandoff();
  switch (handoff.status) {
    case "ok":
      warn(
        "A staged credential is waiting to be imported.",
        "Open the IDE, or focus its window if it is already open. The extension moves\n" +
          "the credential into the OS keychain and deletes the staged file within a few\n" +
          "seconds. If it does not, reload the window ('Developer: Reload Window')."
      );
      break;
    case "expired":
      problems++;
      fail(
        "The staged credential expired before the extension imported it.",
        `Delete ${handoffPath()} and run \`ide-collector login\` again.`
      );
      break;
    case "invalid":
      problems++;
      fail("The staged credential file is unreadable.", `Delete ${handoffPath()} and log in again.`);
      break;
    case "missing":
      // Expected once the extension has imported it. The CLI cannot read the
      // keychain, so it cannot confirm the extension holds a credential.
      info("No staged credential (expected once the extension has imported one).");
      info("The CLI cannot read the OS keychain, so check the extension itself:");
      indent('Command Palette -> "IDE Collector: Show Status"', "    ");
      break;
  }

  // ---- Backend ---------------------------------------------------------------
  heading("Backend");
  for (const [name, url] of [
    ["Ingestion", `${ingestionEndpoint}/health`],
    ["Control plane", `${ingestionEndpoint.replace(/:8080$/, ":8081")}/health`],
  ] as const) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) ok(`${name} reachable (${url})`);
      else {
        problems++;
        fail(`${name} returned ${response.status} (${url})`);
      }
    } catch (err) {
      problems++;
      fail(
        `${name} unreachable (${url})`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  console.log("");
  if (problems === 0) {
    ok("No problems found.");
    return 0;
  }
  fail(`${problems} problem(s) found - see the remedies above.`);
  return 1;
}
