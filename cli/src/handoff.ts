import { chmod, mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * Credential handoff between the CLI and the extension.
 *
 * The extension stores its installation token in the OS keychain, via VS Code's
 * SecretStorage. A CLI process cannot write there - SecretStorage is only
 * reachable from inside the extension host. So `ide-collector login` writes the
 * credential to a file that the extension imports on its next activation, moves
 * into the keychain, and deletes.
 *
 * The file is the weak point in that chain, so it is deliberately short-lived:
 * mode 0600, in the user's home directory rather than a shared temp dir, and
 * carrying an expiry the extension enforces on import. A stale file that never
 * got imported stops being usable rather than sitting on disk indefinitely.
 */

export interface HandoffPayload {
  version: 1;
  installation_id: string;
  installation_token: string;
  user_id: string;
  ingestion_endpoint: string;
  registration_endpoint: string;
  /** ISO-8601. The extension refuses to import after this. */
  expires_at: string;
  created_by: string;
}

/** Default lifetime: long enough to open the IDE, short enough not to linger. */
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

export function handoffPath(home = homedir()): string {
  return join(home, ".ide-collector", "pending-credential.json");
}

export async function writeHandoff(
  payload: Omit<HandoffPayload, "version" | "expires_at" | "created_by"> & {
    expiresAt?: Date;
  },
  path = handoffPath()
): Promise<string> {
  const body: HandoffPayload = {
    version: 1,
    installation_id: payload.installation_id,
    installation_token: payload.installation_token,
    user_id: payload.user_id,
    ingestion_endpoint: payload.ingestion_endpoint,
    registration_endpoint: payload.registration_endpoint,
    expires_at: (payload.expiresAt ?? new Date(Date.now() + HANDOFF_TTL_MS)).toISOString(),
    created_by: "ide-collector-cli",
  };

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written 0600 before any content lands, so the token is never briefly
  // world-readable on a machine with a permissive umask.
  await writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);

  return path;
}

export interface HandoffReadResult {
  status: "ok" | "missing" | "expired" | "invalid";
  payload?: HandoffPayload;
}

export async function readHandoff(
  path = handoffPath(),
  now = Date.now()
): Promise<HandoffReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { status: "missing" };
  }

  let parsed: HandoffPayload;
  try {
    parsed = JSON.parse(raw) as HandoffPayload;
  } catch {
    return { status: "invalid" };
  }

  if (
    parsed?.version !== 1 ||
    !parsed.installation_id ||
    !parsed.installation_token ||
    !parsed.user_id
  ) {
    return { status: "invalid" };
  }

  const expiresAt = Date.parse(parsed.expires_at);
  if (Number.isNaN(expiresAt) || expiresAt <= now) {
    return { status: "expired", payload: parsed };
  }

  return { status: "ok", payload: parsed };
}

export async function clearHandoff(path = handoffPath()): Promise<void> {
  await rm(path, { force: true });
}
