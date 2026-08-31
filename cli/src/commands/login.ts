import { hostname, platform, userInfo } from "os";
import { createHash } from "crypto";
import { ParsedArgs, optionString } from "../args";
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
    optionString(args.options, "registration-endpoint") ??
    optionString(args.options, "endpoint") ??
    "http://localhost:8081";
  const ingestionEndpoint =
    optionString(args.options, "ingestion-endpoint") ?? "http://localhost:8080";
  const idePreference = optionString(args.options, "ide");

  heading("Registering this installation");
  info(`Control plane: ${registrationEndpoint}`);

  // A stable per-machine identifier that is not the hostname or username:
  // those leak more than is needed to tell two installations apart.
  const machineId = createHash("sha256")
    .update(`${hostname()}|${userInfo().username}|${platform()}`)
    .digest("hex")
    .slice(0, 32);

  const body: Record<string, unknown> = {
    ide_name: idePreference ?? "vscode",
    machine_id: machineId,
    platform: platform(),
  };
  if (code) body.enrollment_code = code;

  let payload: {
    installation_id: string;
    installation_token: string;
    user_id: string;
  };

  try {
    const response = await fetch(`${registrationEndpoint}/v1/installations/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401) {
        fail(
          "Registration was rejected.",
          code
            ? "The enrollment code is invalid, expired, or already used. Codes are single-use\nand expire 15 minutes after they are issued. Ask for a fresh one."
            : "This backend requires an enrollment code. Pass one with --code <code>."
        );
      } else if (response.status === 503) {
        fail(
          "The control plane cannot reach its database.",
          "This is a server-side problem, not yours. Whoever runs the backend should\ncheck `npm run check:db` and the api container logs."
        );
      } else {
        fail(`Registration failed (${response.status}).`, text.slice(0, 500));
      }
      return 1;
    }

    payload = (await response.json()) as typeof payload;
  } catch (err) {
    fail(
      `Could not reach the control plane at ${registrationEndpoint}.`,
      [
        err instanceof Error ? err.message : String(err),
        "",
        "Is the backend running? Check with:",
        `  curl ${registrationEndpoint}/health`,
      ].join("\n")
    );
    return 1;
  }

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
  info("Restart your IDE (or run the 'Developer: Reload Window' command).");
  info("On activation the extension moves the credential into your OS keychain");
  info("and deletes the staged file.");
  info("");
  info("If collection is still off, turn it on with:");
  indent("ide-collector config set telemetry.enabled true", "     ");

  return 0;
}
