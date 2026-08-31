import { createHash } from "crypto";
import { hostname, platform, userInfo } from "os";

/**
 * Registration against the control plane.
 *
 * Shared by `login` and `setup`. The CLI makes this call rather than the
 * extension because it is the thing the user is already looking at, and
 * because a failure here can be explained in a terminal rather than a
 * notification toast.
 */

export interface RegistrationPayload {
  installation_id: string;
  installation_token: string;
  user_id: string;
}

export type RegisterOutcome =
  | { ok: true; payload: RegistrationPayload }
  | { ok: false; message: string; detail?: string };

/**
 * A stable per-machine identifier that is not the hostname or the username.
 * Two installations need to be distinguishable; the backend does not need to
 * know whose laptop this is, so it gets a hash rather than the inputs.
 */
export function machineFingerprint(): string {
  return createHash("sha256")
    .update(`${hostname()}|${userInfo().username}|${platform()}`)
    .digest("hex")
    .slice(0, 32);
}

export async function registerInstallation(options: {
  registrationEndpoint: string;
  code?: string;
  ideName?: string;
  fetchImpl?: typeof fetch;
}): Promise<RegisterOutcome> {
  const { registrationEndpoint, code } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  const body: Record<string, unknown> = {
    ide_name: options.ideName ?? "vscode",
    machine_id: machineFingerprint(),
    platform: platform(),
  };
  if (code) body.enrollment_code = code;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(`${registrationEndpoint}/v1/installations/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach the control plane at ${registrationEndpoint}.`,
      detail: [
        err instanceof Error ? err.message : String(err),
        "",
        "Is the backend running? Check with:",
        `  curl ${registrationEndpoint}/health`,
      ].join("\n"),
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");

    if (response.status === 401) {
      return {
        ok: false,
        message: "Registration was rejected.",
        detail: code
          ? "The enrollment code is invalid, expired, or already used. Codes are single-use\nand expire 15 minutes after they are issued. Ask for a fresh one."
          : "This backend requires an enrollment code. Pass one with --code <code>.",
      };
    }

    if (response.status === 503) {
      return {
        ok: false,
        message: "The control plane cannot reach its database.",
        detail:
          "This is a server-side problem, not yours. Whoever runs the backend should\ncheck `npm run check:db` and the api container logs.",
      };
    }

    return {
      ok: false,
      message: `Registration failed (${response.status}).`,
      detail: text.slice(0, 500) || undefined,
    };
  }

  const payload = (await response.json()) as RegistrationPayload;

  if (!payload?.installation_id || !payload.installation_token || !payload.user_id) {
    return {
      ok: false,
      message: "The control plane returned an incomplete registration.",
      detail:
        "Expected installation_id, installation_token and user_id. This is a backend\nbug rather than a configuration problem.",
    };
  }

  return { ok: true, payload };
}
