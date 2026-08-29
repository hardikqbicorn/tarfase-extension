import { decrypt, encrypt } from "@ide-collector/crypto";
import { QueuePersistence } from "./persistence";

/**
 * Wraps any persistence implementation so the offline queue is encrypted at
 * rest with a key held in the IDE's OS secret store. A stale/corrupt blob is
 * treated as an empty queue rather than crashing the extension.
 */
export class EncryptedQueuePersistence implements QueuePersistence {
  constructor(
    private readonly inner: QueuePersistence,
    private readonly secret: string
  ) {}

  async load(): Promise<string | undefined> {
    const raw = await this.inner.load();
    if (!raw) return undefined;
    try {
      return decrypt(raw, this.secret);
    } catch {
      return undefined;
    }
  }

  async save(serialized: string): Promise<void> {
    await this.inner.save(encrypt(serialized, this.secret));
  }
}
