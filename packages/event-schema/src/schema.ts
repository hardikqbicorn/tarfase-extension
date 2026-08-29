import { z } from "zod";
import { EVENT_TYPE_VALUES } from "./event-types";

/**
 * Bump whenever a breaking change is made to the wire shape.
 * Consumers key their validation/migration logic off this value so
 * older producers keep working while the backend evolves.
 */
export const CURRENT_SCHEMA_VERSION = "1.0.0";
export const SUPPORTED_SCHEMA_VERSIONS = ["1.0.0"] as const;

const isoTimestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: "timestamp must be a valid ISO-8601 string",
});

const uuidLike = z.string().uuid();

export const IdeInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
});

export const WorkspaceInfoSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .optional();

export const ProjectInfoSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .optional();

export const RepositoryInfoSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    branch: z.string().optional(),
  })
  .optional();

export const FileInfoSchema = z
  .object({
    path: z.string().optional(),
    language: z.string().optional(),
  })
  .optional();

/**
 * The canonical, versioned IDE event envelope. Every extension adapter
 * produces events matching this exact shape regardless of source IDE.
 */
export const IDEEventSchema = z.object({
  event_id: uuidLike,
  event_type: z.enum(EVENT_TYPE_VALUES as [string, ...string[]]),
  timestamp: isoTimestamp,

  user_id: z.string().min(1),
  installation_id: z.string().min(1),
  session_id: z.string().min(1),

  ide: IdeInfoSchema,
  workspace: WorkspaceInfoSchema,
  project: ProjectInfoSchema,
  repository: RepositoryInfoSchema,
  file: FileInfoSchema,

  payload: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).optional(),

  schema_version: z.string(),
});

export type IDEEvent = z.infer<typeof IDEEventSchema>;
export type IdeInfo = z.infer<typeof IdeInfoSchema>;

export interface EventValidationResult {
  valid: boolean;
  event?: IDEEvent;
  errors?: string[];
}

export function validateEvent(input: unknown): EventValidationResult {
  const result = IDEEventSchema.safeParse(input);
  if (result.success) {
    return { valid: true, event: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}

export function isSupportedSchemaVersion(version: string): boolean {
  return (SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(version);
}

/** Batch envelope used by extensions -> ingestion API. */
export const EventBatchSchema = z.object({
  installation_id: z.string().min(1),
  events: z.array(IDEEventSchema).min(1).max(1000),
});
export type EventBatch = z.infer<typeof EventBatchSchema>;
