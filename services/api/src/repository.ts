import { Pool } from "pg";

export interface UserRecord {
  id: string;
  email: string | null;
  telemetry_enabled: boolean;
}

export interface InstallationRecord {
  id: string;
  user_id: string;
  ide_name: string;
  ide_version: string | null;
  machine_id: string | null;
  revoked_at: string | null;
}

export interface EnrollmentCodeRecord {
  code_hash: string;
  user_id: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Data access seam. The Postgres implementation is used in production; tests
 * substitute an in-memory implementation so the auth logic is verifiable
 * without a live database.
 */
export interface ApiRepository {
  findOrCreateUser(email: string | null, externalId: string | null): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  createEnrollmentCode(userId: string, codeHash: string, expiresAt: Date): Promise<void>;
  consumeEnrollmentCode(codeHash: string): Promise<EnrollmentCodeRecord | undefined>;
  createInstallation(input: {
    userId: string;
    ideName: string;
    ideVersion?: string;
    extensionVersion?: string;
    machineId?: string;
    platform?: string;
    tokenHash: string;
  }): Promise<InstallationRecord>;
  getInstallation(installationId: string): Promise<InstallationRecord | undefined>;
  revokeInstallation(installationId: string): Promise<boolean>;
  touchInstallation(installationId: string): Promise<void>;
  queryEvents(filters: {
    userId?: string;
    installationId?: string;
    sessionId?: string;
    eventType?: string;
    since?: string;
    limit: number;
  }): Promise<Record<string, unknown>[]>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresApiRepository implements ApiRepository {
  constructor(private readonly pool: Pool) {}

  async findOrCreateUser(email: string | null, externalId: string | null): Promise<UserRecord> {
    if (email) {
      const existing = await this.pool.query<UserRecord>(
        `SELECT id, email, telemetry_enabled FROM users WHERE email = $1`,
        [email]
      );
      if (existing.rows[0]) return existing.rows[0];
    }
    const inserted = await this.pool.query<UserRecord>(
      `INSERT INTO users (email, external_id) VALUES ($1, $2)
       RETURNING id, email, telemetry_enabled`,
      [email, externalId]
    );
    return inserted.rows[0];
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const result = await this.pool.query<UserRecord>(
      `SELECT id, email, telemetry_enabled FROM users WHERE id = $1`,
      [userId]
    );
    return result.rows[0];
  }

  async createEnrollmentCode(userId: string, codeHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO enrollment_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
      [codeHash, userId, expiresAt.toISOString()]
    );
  }

  /**
   * Atomically marks a code consumed. The `consumed_at IS NULL` guard in the
   * UPDATE makes redemption single-use even under concurrent requests.
   */
  async consumeEnrollmentCode(codeHash: string): Promise<EnrollmentCodeRecord | undefined> {
    const result = await this.pool.query<EnrollmentCodeRecord>(
      `UPDATE enrollment_codes
          SET consumed_at = NOW()
        WHERE code_hash = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
      RETURNING code_hash, user_id, expires_at, consumed_at`,
      [codeHash]
    );
    return result.rows[0];
  }

  async createInstallation(input: {
    userId: string;
    ideName: string;
    ideVersion?: string;
    extensionVersion?: string;
    machineId?: string;
    platform?: string;
    tokenHash: string;
  }): Promise<InstallationRecord> {
    const result = await this.pool.query<InstallationRecord>(
      `INSERT INTO installations
         (user_id, ide_name, ide_version, extension_version, machine_id, platform, token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, ide_name, ide_version, machine_id, revoked_at`,
      [
        input.userId,
        input.ideName,
        input.ideVersion ?? null,
        input.extensionVersion ?? null,
        input.machineId ?? null,
        input.platform ?? null,
        input.tokenHash,
      ]
    );
    return result.rows[0];
  }

  async getInstallation(installationId: string): Promise<InstallationRecord | undefined> {
    const result = await this.pool.query<InstallationRecord>(
      `SELECT id, user_id, ide_name, ide_version, machine_id, revoked_at
         FROM installations WHERE id = $1`,
      [installationId]
    );
    return result.rows[0];
  }

  async revokeInstallation(installationId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE installations SET revoked_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND revoked_at IS NULL`,
      [installationId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async touchInstallation(installationId: string): Promise<void> {
    await this.pool.query(`UPDATE installations SET last_seen_at = NOW() WHERE id = $1`, [
      installationId,
    ]);
  }

  async queryEvents(filters: {
    userId?: string;
    installationId?: string;
    sessionId?: string;
    eventType?: string;
    since?: string;
    limit: number;
  }): Promise<Record<string, unknown>[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const push = (clause: string, value: unknown) => {
      params.push(value);
      conditions.push(clause.replace("$?", `$${params.length}`));
    };

    if (filters.userId) push("user_id = $?", filters.userId);
    if (filters.installationId) push("installation_id = $?", filters.installationId);
    if (filters.sessionId) push("session_id = $?", filters.sessionId);
    if (filters.eventType) push("event_type = $?", filters.eventType);
    if (filters.since) push('"timestamp" >= $?', filters.since);

    params.push(filters.limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await this.pool.query(
      `SELECT event_id, event_type, user_id, installation_id, session_id, ide_name, ide_version,
              "timestamp", workspace_name, project_name, repository_name, branch,
              file_path, language, payload, metadata, schema_version, ingested_at
         FROM raw_events
         ${where}
        ORDER BY "timestamp" DESC
        LIMIT $${params.length}`,
      params
    );
    return result.rows;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
