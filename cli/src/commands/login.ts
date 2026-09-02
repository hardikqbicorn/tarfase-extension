import { ParsedArgs, optionString } from "../args";
import { registerInstallation } from "../register";
import { writeHandoff } from "../handoff";
import { detectIdes, selectIdes } from "../ide";
import { applyCollectorSettings, readSettings, writeSettings } from "../settings";
import { fail, heading, indent, info, ok, step } from "../output";

/**
 * `ide-collector login`
 *
 * Exchanges an enrollment code for installation credentials, then hands them to
 * the extension through the handoff file (see handoff.ts for why a file).
 *
 * The CLI does the network call rather than the extension because it is the
 * thing the user is already looking at, and because an error here can be
 * explained in a terminal rather than a notification toast.
 */
export async function loginCommand(args: ParsedArgs): Promise<number> {
  const code = optionString(args.options, "code");
  const registrationEndpoint =
    optionString(args.options, "registration-endpoint") ?? "http://localhost:8081";
  // `--endpoint` means the ingestion API in `install` and `setup`, so it means
  // that here too. It used to fall back to the control plane, which made the
  // same flag mean two different services depending on the subcommand.
  const ingestionEndpoint =
    optionString(args.options, "ingestion-endpoint") ??
    optionString(args.options, "endpoint") ??
    "http://localhost:8080";
  const idePreference = optionString(args.options, "ide");

  heading("Registering this installation");
  info(`Control plane: ${registrationEndpoint}`);

  const outcome = await registerInstallation({
    registrationEndpoint,
    code,
    ideName: idePreference ?? "vscode",
  });

  if (!outcome.ok) {
    fail(outcome.message, outcome.detail);
    return 1;
  }

  const payload = outcome.payload;

  ok(`Registered as installation ${payload.installation_id.slice(0, 8)}...`);

  // ---- Hand the credential to the extension ---------------------------------
  const path = await writeHandoff({
    installation_id: payload.installation_id,
    installation_token: payload.installation_token,
    user_id: payload.user_id,
    ingestion_endpoint: ingestionEndpoint,
    registration_endpoint: registrationEndpoint,
  });
  ok("Credential staged for the extension");
  info(`${path} (mode 0600, expires in 30 minutes)`);

  // ---- Point the IDE at the right endpoints ---------------------------------
  const detected = await detectIdes();
  const targets = idePreference ? selectIdes(detected, idePreference) : detected;

  if (targets.length > 0) {
    step("Updating IDE settings");
    for (const ide of targets) {
      try {
        const { settings } = await readSettings(ide.settingsDir);
        const merged = applyCollectorSettings(settings, {
          ingestionEndpoint,
          registrationEndpoint,
        });
        await writeSettings(ide.settingsDir, merged);
        ok(`${ide.label}`);
      } catch {
        // Non-fatal: the user can set endpoints through the settings UI.
      }
    }
  }

  heading("Next step");
  info("Open your IDE. A running one picks the credential up within a few seconds;");
  info("either way the extension moves it into your OS keychain and deletes the");
  info("staged file.");
  info("");
  info("If collection is still off, turn it on with:");
  indent("ide-collector config set telemetry.enabled true", "     ");

  return 0;
}
