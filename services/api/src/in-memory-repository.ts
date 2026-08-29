import { randomUUID } from "crypto";
import {
  ApiRepository,
  CreateInstallationInput,
  EnrollmentCodeRecord,
  InstallationRecord,
  UserRecord,
} from "./repository";

/**
 * In-memory ApiRepository used by tests (and usable as a smoke-test backend).
 * Mirrors the Postgres implementation's semantics, notably single-use
 * enrollment codes and revocation.
 */
export class InMemoryApiRepository implements ApiRepository {
  users = new Map<string, UserRecord>();
  installations = new Map<string, InstallationRecord>();
  /** installation id -> stored token hash, mirroring the installations.token_hash column. */
  installationTokenHashes = new Map<string, string>();
  enrollmentCodes = new Map<string, EnrollmentCodeRecord>();
  events: Record<string, unknown>[] = [];
  healthy = true;

  async findOrCreateUser(email: string | null, _externalId: string | null): Promise<UserRecord> {
    if (email) {
      for (const user of this.users.values()) {
        if (user.email === email) return user;
      }
    }
    const user: UserRecord = { id: randomUUID(), email, telemetry_enabled: true };
    this.users.set(user.id, user);
    return user;
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    return this.users.get(userId);
  }

  async createEnrollmentCode(userId: string, codeHash: string, expiresAt: Date): Promise<void> {
    this.enrollmentCodes.set(codeHash, {
      code_hash: codeHash,
      user_id: userId,
      expires_at: expiresAt.toISOString(),
      consumed_at: null,
    });
  }

  async consumeEnrollmentCode(codeHash: string): Promise<EnrollmentCodeRecord | undefined> {
    const record = this.enrollmentCodes.get(codeHash);
    if (!record) return undefined;
    if (record.consumed_at) return undefined;
    if (new Date(record.expires_at).getTime() <= Date.now()) return undefined;
    record.consumed_at = new Date().toISOString();
    return record;
  }

  async createInstallation(input: CreateInstallationInput): Promise<InstallationRecord> {
    const installation: InstallationRecord = {
      id: input.id,
      user_id: input.userId,
      ide_name: input.ideName,
      ide_version: input.ideVersion ?? null,
      machine_id: input.machineId ?? null,
      revoked_at: null,
    };
    this.installations.set(installation.id, installation);
    this.installationTokenHashes.set(installation.id, input.tokenHash);
    return installation;
  }

  async getInstallation(installationId: string): Promise<InstallationRecord | undefined> {
    return this.installations.get(installationId);
  }

  async revokeInstallation(installationId: string): Promise<boolean> {
    const installation = this.installations.get(installationId);
    if (!installation || installation.revoked_at) return false;
    installation.revoked_at = new Date().toISOString();
    return true;
  }

  async touchInstallation(_installationId: string): Promise<void> {}

  async queryEvents(filters: {
    userId?: string;
    installationId?: string;
    sessionId?: string;
    eventType?: string;
    since?: string;
    limit: number;
  }): Promise<Record<string, unknown>[]> {
    return this.events
      .filter((e) => !filters.userId || e.user_id === filters.userId)
      .filter((e) => !filters.installationId || e.installation_id === filters.installationId)
      .filter((e) => !filters.sessionId || e.session_id === filters.sessionId)
      .filter((e) => !filters.eventType || e.event_type === filters.eventType)
      .slice(0, filters.limit);
  }

  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }

  async close(): Promise<void> {}
}
