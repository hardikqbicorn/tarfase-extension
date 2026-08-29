/**
 * Installation registration flow.
 *
 *   IDE Extension -> POST /v1/installations/register -> API
 *   API returns { installation_id, installation_token, user_id }
 *   Extension stores the token in the IDE's OS-backed secret store.
 *
 * No credential is ever hard-coded in an extension; the enrollment code the
 * user pastes in is short-lived and exchanged once for a long-lived token.
 */

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory store used by tests. Never use this in a shipped extension. */
export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export interface InstallationCredentials {
  installationId: string;
  installationToken: string;
  userId: string;
}

export interface RegisterOptions {
  registrationEndpoint: string;
  /** Short-lived enrollment code issued by the backend / web console. */
  enrollmentCode: string;
  ide: { name: string; version?: string };
  machineId: string;
  fetchImpl?: typeof fetch;
}

const CREDENTIAL_KEY = "ide-collector.installation";

export class RegistrationClient {
  constructor(private readonly secretStore: SecretStore) {}

  async getStoredCredentials(): Promise<InstallationCredentials | undefined> {
    const raw = await this.secretStore.get(CREDENTIAL_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as InstallationCredentials;
    } catch {
      return undefined;
    }
  }

  async storeCredentials(credentials: InstallationCredentials): Promise<void> {
    await this.secretStore.set(CREDENTIAL_KEY, JSON.stringify(credentials));
  }

  async clearCredentials(): Promise<void> {
    await this.secretStore.delete(CREDENTIAL_KEY);
  }

  /** Exchanges an enrollment code for durable installation credentials. */
  async register(options: RegisterOptions): Promise<InstallationCredentials> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("No fetch implementation available");

    const response = await fetchImpl(
      `${options.registrationEndpoint}/v1/installations/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_code: options.enrollmentCode,
          ide_name: options.ide.name,
          ide_version: options.ide.version,
          machine_id: options.machineId,
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Registration failed (${response.status}): ${body}`);
    }

    const body = (await response.json()) as {
      installation_id: string;
      installation_token: string;
      user_id: string;
    };

    const credentials: InstallationCredentials = {
      installationId: body.installation_id,
      installationToken: body.installation_token,
      userId: body.user_id,
    };
    await this.storeCredentials(credentials);
    return credentials;
  }
}
