import { mkdir, readFile, writeFile, rename } from "fs/promises";
import { dirname } from "path";
import { QueuePersistence } from "./persistence";

/**
 * Filesystem-backed persistence for Node.js IDE hosts (VS Code, Cursor,
 * Windsurf). Writes go to a temp file then atomically rename over the
 * real file so a crash mid-write never corrupts the queue.
 */
export class FileSystemQueuePersistence implements QueuePersistence {
  constructor(private readonly filePath: string) {}

  async load(): Promise<string | undefined> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
  }

  async save(serialized: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, this.filePath);
  }
}
