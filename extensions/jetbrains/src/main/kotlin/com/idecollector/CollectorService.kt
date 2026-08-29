package com.idecollector

import com.idecollector.schema.EventTypes
import com.idecollector.schema.FileInfo
import com.idecollector.schema.IdeEvent
import com.idecollector.schema.IdeInfo
import com.idecollector.schema.ProjectInfo
import com.idecollector.schema.RepositoryInfo
import com.idecollector.schema.WorkspaceInfo
import com.idecollector.sdk.EventCollector
import com.idecollector.sdk.EventQueue
import com.idecollector.sdk.HttpEventTransport
import com.idecollector.settings.CollectorSettings
import com.idecollector.settings.CredentialStore
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.serialization.json.JsonElement
import java.nio.file.Paths
import java.security.MessageDigest
import java.util.UUID

/**
 * Project-scoped service that owns the collector for one open project.
 *
 * This is the JetBrains equivalent of `extensions/vscode/src/extension.ts`: it
 * assembles the same SDK pieces (queue, transport, collector), supplies the
 * ambient context, and translates platform concepts into the canonical schema.
 * Nothing below this layer knows it is running inside IntelliJ.
 */
@Service(Service.Level.PROJECT)
class CollectorService(private val project: Project) : Disposable {

    private val log = Logger.getInstance(CollectorService::class.java)
    private val sessionId = UUID.randomUUID().toString()
    private var collector: EventCollector? = null

    val documentThrottleMillis: Long
        get() = CollectorSettings.getInstance().state.documentThrottleMillis

    init {
        start()
    }

    private fun start() {
        val settings = CollectorSettings.getInstance().state
        if (!settings.enabled) {
            log.info("IDE Event Collector: telemetry disabled")
            return
        }

        val credentials = CredentialStore.load()
        if (credentials == null) {
            log.warn("IDE Event Collector: no installation credentials; run the Register action")
            return
        }

        val config = EventCollector.CollectorConfig(
            enabled = true,
            ingestionEndpoint = settings.ingestionEndpoint,
            batchSize = settings.batchSize,
            flushIntervalMillis = settings.flushIntervalMillis,
            maxQueueSize = settings.maxQueueSize,
            redactSecrets = settings.redactSecrets,
            disabledEventTypes = settings.disabledEventTypes.toSet(),
            documentThrottleMillis = settings.documentThrottleMillis,
        )

        // Queue lives in the IDE's system directory: per-user, outside any
        // project, so buffered events are never committed to a repository.
        val queuePath = Paths.get(PathManager.getSystemPath(), "ide-collector", "event-queue.json")

        val queue = EventQueue(
            maxQueueSize = config.maxQueueSize,
            storagePath = queuePath,
            onDrop = { log.warn("IDE Event Collector: local queue full, dropped oldest event") },
        )

        val transport = HttpEventTransport(
            endpoint = config.ingestionEndpoint,
            installationId = credentials.installationId,
            tokenProvider = { CredentialStore.load()?.installationToken },
        )

        collector = EventCollector(
            config = config,
            identity = EventCollector.Identity(
                userId = credentials.userId,
                installationId = credentials.installationId,
                sessionId = sessionId,
            ),
            contextProvider = ::currentContext,
            queue = queue,
            transport = transport,
            log = { message, throwable -> log.warn(message, throwable) },
        ).also { it.start() }

        capture(EventTypes.SESSION_STARTED)
        capture(EventTypes.PROJECT_OPENED)
        capture(EventTypes.EXTENSION_ACTIVATED)

        // The IntelliJ Platform exposes no public API for observing AI
        // assistant activity (its own or a third party's), so the gap is
        // reported rather than left as silently missing data.
        capture(
            EventTypes.AI_FEATURE_UNAVAILABLE,
            payload = mapOf(
                "reason" to kotlinx.serialization.json.JsonPrimitive(
                    "no_public_api_for_observing_assistant_activity"
                ),
            ),
        )
    }

    fun capture(
        eventType: String,
        file: FileInfo? = null,
        payload: Map<String, JsonElement> = emptyMap(),
        throttleKey: String? = null,
        throttleMillis: Long = 0,
    ): IdeEvent? = collector?.capture(
        eventType = eventType,
        file = file,
        payload = payload,
        throttleKey = throttleKey,
        throttleMillis = throttleMillis,
    )

    /**
     * Ambient context attached to every event. Read fresh each call so events
     * emitted after a branch change carry the new branch.
     */
    private fun currentContext(): EventCollector.EventContext {
        val appInfo = ApplicationInfo.getInstance()
        return EventCollector.EventContext(
            ide = IdeInfo(
                // e.g. "IntelliJ IDEA", "PyCharm", "GoLand" - one plugin serves
                // the whole family, and events stay attributable per product.
                name = "jetbrains:${appInfo.versionName.lowercase().replace(" ", "-")}",
                version = appInfo.fullVersion,
            ),
            workspace = project.basePath?.let { WorkspaceInfo(id = stableId(it), name = project.name) },
            project = project.basePath?.let { ProjectInfo(id = stableId(it), name = project.name) },
            repository = currentRepository(),
        )
    }

    /**
     * Reads the current Git repository through Git4Idea if it is installed.
     * Accessed reflectively so the plugin still loads in an IDE without the Git
     * plugin, where git events are simply unavailable.
     */
    private fun currentRepository(): RepositoryInfo? = try {
        val managerClass = Class.forName("git4idea.repo.GitRepositoryManager")
        val manager = managerClass
            .getMethod("getInstance", Project::class.java)
            .invoke(null, project)
        @Suppress("UNCHECKED_CAST")
        val repositories = managerClass
            .getMethod("getRepositories")
            .invoke(manager) as List<Any>

        repositories.firstOrNull()?.let { repo ->
            val root = repo.javaClass.getMethod("getRoot").invoke(repo) as VirtualFile
            val branch = runCatching {
                repo.javaClass.getMethod("getCurrentBranchName").invoke(repo) as? String
            }.getOrNull()
            RepositoryInfo(id = stableId(root.path), name = root.name, branch = branch)
        }
    } catch (e: Throwable) {
        null
    }

    /**
     * Project-relative path. Absolute paths leak the developer's username and
     * directory layout, so a file outside the project reports only its name -
     * matching the VS Code adapter's behavior exactly.
     */
    fun relativePath(file: VirtualFile): String {
        val base = project.basePath ?: return file.name
        val normalized = if (base.endsWith("/")) base else "$base/"
        return if (file.path.startsWith(normalized)) file.path.removePrefix(normalized) else file.name
    }

    fun fileInfo(file: VirtualFile): FileInfo =
        FileInfo(path = relativePath(file), language = file.extension)

    override fun dispose() {
        capture(EventTypes.SESSION_ENDED)
        capture(EventTypes.EXTENSION_DEACTIVATED)
        collector?.dispose()
        collector = null
    }

    companion object {
        /** Stable, non-reversible identifier for a path. */
        fun stableId(value: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
            return digest.joinToString("") { "%02x".format(it) }.take(32)
        }
    }
}
