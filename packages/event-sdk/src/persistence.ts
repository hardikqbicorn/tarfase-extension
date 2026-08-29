/**
 * Pluggable persistence for the local offline queue. Extensions running in
 * Node.js (VS Code/Cursor/Windsurf host) use the filesystem implementation;
 * other hosts (browser webviews, tests) can supply an in-memory or
 * IndexedDB-backed implementation without touching the queue logic.
 */
export interface QueuePersistence {
  load(): Promise<string | undefined>;
  save(serialized: string): Promise<void>;
}

export class InMemoryQueuePersistence implements QueuePersistence {
  private data: string | undefined;
  async load(): Promise<string | undefined> {
    return this.data;
  }
  async save(serialized: string): Promise<void> {
    this.data = serialized;
  }
}
