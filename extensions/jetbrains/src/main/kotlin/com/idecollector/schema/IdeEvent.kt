package com.idecollector.schema

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * Kotlin representation of the canonical event envelope defined in
 * `packages/event-schema`. The JSON wire format is byte-for-byte compatible
 * with the TypeScript producers, so the ingestion service, Kafka topics, and
 * database schema are shared unchanged across every IDE.
 *
 * When the canonical schema changes, this file and
 * `packages/event-schema/src/schema.ts` must be updated together and
 * SCHEMA_VERSION bumped.
 */
@Serializable
data class IdeInfo(
    val name: String,
    val version: String? = null,
)

@Serializable
data class WorkspaceInfo(
    val id: String? = null,
    val name: String? = null,
)

@Serializable
data class ProjectInfo(
    val id: String? = null,
    val name: String? = null,
)

@Serializable
data class RepositoryInfo(
    val id: String? = null,
    val name: String? = null,
    val branch: String? = null,
)

@Serializable
data class FileInfo(
    val path: String? = null,
    val language: String? = null,
)

@Serializable
data class IdeEvent(
    @SerialName("event_id") val eventId: String,
    @SerialName("event_type") val eventType: String,
    val timestamp: String,
    @SerialName("user_id") val userId: String,
    @SerialName("installation_id") val installationId: String,
    @SerialName("session_id") val sessionId: String,
    val ide: IdeInfo,
    val workspace: WorkspaceInfo? = null,
    val project: ProjectInfo? = null,
    val repository: RepositoryInfo? = null,
    val file: FileInfo? = null,
    val payload: Map<String, JsonElement> = emptyMap(),
    val metadata: Map<String, JsonElement>? = null,
    @SerialName("schema_version") val schemaVersion: String = SCHEMA_VERSION,
) {
    companion object {
        const val SCHEMA_VERSION = "1.0.0"

        private val ISO: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT

        fun create(
            eventType: String,
            userId: String,
            installationId: String,
            sessionId: String,
            ide: IdeInfo,
            workspace: WorkspaceInfo? = null,
            project: ProjectInfo? = null,
            repository: RepositoryInfo? = null,
            file: FileInfo? = null,
            payload: Map<String, JsonElement> = emptyMap(),
            metadata: Map<String, JsonElement>? = null,
        ): IdeEvent = IdeEvent(
            eventId = UUID.randomUUID().toString(),
            eventType = eventType,
            timestamp = ISO.format(Instant.now()),
            userId = userId,
            installationId = installationId,
            sessionId = sessionId,
            ide = ide,
            workspace = workspace,
            project = project,
            repository = repository,
            file = file,
            payload = payload,
            metadata = metadata,
        )
    }
}

/**
 * Mirror of `packages/event-schema/src/event-types.ts`. Only the subset the
 * IntelliJ Platform can actually observe is listed; the canonical catalog is
 * larger and is the source of truth.
 */
object EventTypes {
    // Workspace / project
    const val WORKSPACE_OPENED = "workspace.opened"
    const val WORKSPACE_CLOSED = "workspace.closed"
    const val PROJECT_OPENED = "project.opened"
    const val PROJECT_CHANGED = "project.changed"

    // File
    const val FILE_OPENED = "file.opened"
    const val FILE_CLOSED = "file.closed"
    const val FILE_CREATED = "file.created"
    const val FILE_DELETED = "file.deleted"
    const val FILE_RENAMED = "file.renamed"
    const val FILE_SAVED = "file.saved"
    const val FILE_MODIFIED = "file.modified"

    // Editor
    const val EDITOR_CURSOR_MOVED = "editor.cursor_moved"
    const val EDITOR_SELECTION_CHANGED = "editor.selection_changed"
    const val EDITOR_ACTIVE_CHANGED = "editor.active_changed"
    const val EDITOR_DOCUMENT_CHANGED = "editor.document_changed"

    // Git (via the Git4Idea plugin)
    const val GIT_BRANCH_CHECKOUT = "git.branch_checkout"
    const val GIT_COMMIT = "git.commit"
    const val GIT_PUSH = "git.push"
    const val GIT_PULL = "git.pull"
    const val GIT_REPOSITORY_CHANGED = "git.repository_changed"

    // Build / test / debug
    const val BUILD_STARTED = "build.started"
    const val BUILD_COMPLETED = "build.completed"
    const val BUILD_FAILED = "build.failed"
    const val TEST_STARTED = "test.started"
    const val TEST_COMPLETED = "test.completed"
    const val TEST_FAILED = "test.failed"
    const val DEBUGGER_STARTED = "debugger.started"
    const val DEBUGGER_STOPPED = "debugger.stopped"
    const val BREAKPOINT_ADDED = "breakpoint.added"
    const val BREAKPOINT_REMOVED = "breakpoint.removed"

    // AI
    const val AI_FEATURE_UNAVAILABLE = "ai.feature_unavailable"

    // Lifecycle
    const val SESSION_STARTED = "session.started"
    const val SESSION_ENDED = "session.ended"
    const val EXTENSION_ACTIVATED = "extension.activated"
    const val EXTENSION_DEACTIVATED = "extension.deactivated"
}
