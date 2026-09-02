import * as vscode from "vscode";
import { SecretStore } from "@ide-collector/event-sdk";

/**
 * Backs the SDK's SecretStore with VS Code's `SecretStorage`, which delegates
 * to the OS keychain (Keychain on macOS, libsecret on Linux, Credential
 * Manager on Windows). Credentials never touch the extension's settings or
 * global state, and never appear in a settings-sync payload.
 */
export class VSCodeSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}
