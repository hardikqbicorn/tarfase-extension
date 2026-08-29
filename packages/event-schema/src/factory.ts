import { v4 as uuidv4 } from "uuid";
import { CURRENT_SCHEMA_VERSION, IDEEvent, IdeInfo } from "./schema";
import { EventType } from "./event-types";

export interface CreateEventInput {
  eventType: EventType | string;
  userId: string;
  installationId: string;
  sessionId: string;
  ide: IdeInfo;
  workspace?: IDEEvent["workspace"];
  project?: IDEEvent["project"];
  repository?: IDEEvent["repository"];
  file?: IDEEvent["file"];
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

/** Builds a schema-conformant event envelope with a fresh UUID + timestamp. */
export function createEvent(input: CreateEventInput): IDEEvent {
  return {
    event_id: uuidv4(),
    event_type: input.eventType,
    timestamp: input.timestamp ?? new Date().toISOString(),
    user_id: input.userId,
    installation_id: input.installationId,
    session_id: input.sessionId,
    ide: input.ide,
    workspace: input.workspace,
    project: input.project,
    repository: input.repository,
    file: input.file,
    payload: input.payload ?? {},
    metadata: input.metadata,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
}
