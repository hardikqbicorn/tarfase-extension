import { IDEEvent, IdeInfo } from "@ide-collector/event-schema";

/**
 * Ambient context an adapter attaches to every event. Adapters implement
 * this by reading their IDE's current state; the SDK never reaches into
 * IDE APIs itself, which is what keeps the core IDE-agnostic.
 */
export interface EventContext {
  ide: IdeInfo;
  workspace?: IDEEvent["workspace"];
  project?: IDEEvent["project"];
  repository?: IDEEvent["repository"];
}

export interface ContextProvider {
  getContext(): EventContext;
}

/** Identity of the current installation/user/session. */
export interface CollectorIdentity {
  userId: string;
  installationId: string;
  sessionId: string;
}
