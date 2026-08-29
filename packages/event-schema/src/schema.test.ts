import { describe, expect, it } from "vitest";
import { validateEvent } from "./schema";
import { createEvent } from "./factory";
import { EVENT_TYPES } from "./event-types";

describe("event schema", () => {
  it("accepts a well-formed event built by the factory", () => {
    const event = createEvent({
      eventType: EVENT_TYPES.FILE_SAVED,
      userId: "user-1",
      installationId: "install-1",
      sessionId: "session-1",
      ide: { name: "vscode", version: "1.90.0" },
      file: { path: "src/index.ts", language: "typescript" },
      payload: { lineCount: 42 },
    });

    const result = validateEvent(event);
    expect(result.valid).toBe(true);
    expect(result.event?.event_id).toBe(event.event_id);
  });

  it("rejects an event missing required fields", () => {
    const result = validateEvent({ event_type: "file.saved" });
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("rejects an unknown event_type", () => {
    const event = createEvent({
      eventType: "totally.unknown",
      userId: "u",
      installationId: "i",
      sessionId: "s",
      ide: { name: "vscode" },
    });
    const result = validateEvent(event);
    expect(result.valid).toBe(false);
  });

  it("rejects a non-uuid event_id", () => {
    const event = createEvent({
      eventType: EVENT_TYPES.FILE_SAVED,
      userId: "u",
      installationId: "i",
      sessionId: "s",
      ide: { name: "vscode" },
    });
    (event as any).event_id = "not-a-uuid";
    const result = validateEvent(event);
    expect(result.valid).toBe(false);
  });
});
