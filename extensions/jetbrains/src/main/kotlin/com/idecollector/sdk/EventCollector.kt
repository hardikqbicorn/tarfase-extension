package com.idecollector.sdk

import com.idecollector.schema.FileInfo
import com.idecollector.schema.IdeEvent
import com.idecollector.schema.IdeInfo
import com.idecollector.schema.ProjectInfo
import com.idecollector.schema.RepositoryInfo
import com.idecollector.schema.WorkspaceInfo
import kotlinx.serialization.json.JsonElement
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.Json

/**
 * Kotlin port of `packages/event-sdk/src/collector.ts`.
 *
 * The contract is identical to the TypeScript SDK: `capture` does only
 * synchronous policy checks and an enqueue, so it is safe to call from
 * IntelliJ's EDT and never blocks typing or editor operations. Delivery
 * happens on a background scheduler.
 */
class EventCollector(
    private val config: CollectorConfig,
    private val identity: Identity,
    private val contextProvider: () -> EventContext,
    private val queue: EventQueue,
    private val transport: EventTransport,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
) {
    data class Identity(val userId: String, val installationId: String, val sessionId: String)

    data class EventContext(
        val ide: IdeInfo,
        val workspace: WorkspaceInfo? = null,
        val project: ProjectInfo? = null,
        val repository: RepositoryInfo? = null,
    )

    data class CollectorConfig(
        val enabled: Boolean = false,
        val ingestionEndpoint: String = "http://localhost:8080",
        val batchSize: Int = 50,
        val flushIntervalMillis: Long = 5_000,
        val maxQueueSize: Int = 10_000,
        val maxDeliveryAttempts: Int = 10,
        val redactSecrets: Boolean = true,
        val disabledEventTypes: Set<String> = emptySet(),
        val cursorThrottleMillis: Long = 2_000,
        val documentThrottleMillis: Long = 1_000,
    )

    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "ide-collector-flush").apply { isDaemon = true }
    }
    private val throttleState = ConcurrentHashMap<String, Long>()
    private val flushInFlight = AtomicBoolean(false)
    private val disposed = AtomicBoolean(false)

    val eventsCaptured = AtomicLong(0)
    val eventsThrottled = AtomicLong(0)
    val eventsSent = AtomicLong(0)
    val flushFailures = AtomicLong(0)

    fun start() {
        queue.load()
        scheduler.scheduleWithFixedDelay(
            { runCatching { flush() }.onFailure { log("flush loop error", it) } },
            config.flushIntervalMillis,
            config.flushIntervalMillis,
            TimeUnit.MILLISECONDS,
        )
    }

    /**
     * Records an event. Returns null when policy (opt-out, filter, throttle)
     * suppressed it. Never performs I/O.
     */
    fun capture(
        eventType: String,
        file: FileInfo? = null,
        payload: Map<String, JsonElement> = emptyMap(),
        repository: RepositoryInfo? = null,
        throttleKey: String? = null,
        throttleMillis: Long = 0,
    ): IdeEvent? {
        if (disposed.get() || !config.enabled) return null
        if (eventType in config.disabledEventTypes) return null
        if (throttleKey != null && isThrottled(throttleKey, throttleMillis)) {
            eventsThrottled.incrementAndGet()
            return null
        }

        val context = contextProvider()
        val event = IdeEvent.create(
            eventType = eventType,
            userId = identity.userId,
            installationId = identity.installationId,
            sessionId = identity.sessionId,
            ide = context.ide,
            workspace = context.workspace,
            project = context.project,
            repository = repository ?: context.repository,
            file = file,
            payload = if (config.redactSecrets) Redactor.redactPayload(payload) else payload,
        )

        queue.enqueue(event)
        eventsCaptured.incrementAndGet()
        return event
    }

    fun flush() {
        if (flushInFlight.getAndSet(true)) return
        try {
            val batch = queue.peekReady(config.batchSize)
            if (batch.isEmpty()) return

            // Evict poison pills so one permanently-failing event cannot block
            // the queue forever.
            val exhausted = batch.filter { it.attempts >= config.maxDeliveryAttempts }
            if (exhausted.isNotEmpty()) {
                queue.ack(exhausted.map { it.event.eventId }.toSet())
            }

            val sendable = batch.filter { it.attempts < config.maxDeliveryAttempts }
            if (sendable.isEmpty()) return

            try {
                val result = transport.send(sendable.map { it.event })
                queue.ack((result.accepted + result.rejected).toSet())
                eventsSent.addAndGet(result.accepted.size.toLong())
            } catch (e: Exception) {
                // Retain for retry; nack applies exponential backoff.
                queue.nack(sendable.map { it.event.eventId }.toSet())
                flushFailures.incrementAndGet()
                log("flush failed, events retained for retry", e)
            }
            queue.persist()
        } finally {
            flushInFlight.set(false)
        }
    }

    fun dispose() {
        if (disposed.getAndSet(true)) return
        scheduler.shutdown()
        runCatching { flush() }
        queue.persist()
    }

    private fun isThrottled(key: String, intervalMillis: Long): Boolean {
        if (intervalMillis <= 0) return false
        val now = System.currentTimeMillis()
        val last = throttleState[key]
        if (last != null && now - last < intervalMillis) return true
        throttleState[key] = now
        return false
    }
}

data class TransportResult(val accepted: List<String>, val rejected: List<String>)

interface EventTransport {
    fun send(events: List<IdeEvent>): TransportResult
}

/**
 * Ships batches to the ingestion service over HTTPS. As in the TypeScript SDK,
 * the plugin never talks to Kafka directly: brokers are not exposed to
 * developer machines, and the ingestion service owns auth and validation.
 */
class HttpEventTransport(
    private val endpoint: String,
    private val installationId: String,
    private val tokenProvider: () -> String?,
) : EventTransport {
    private val json = Json { encodeDefaults = true; explicitNulls = false }
    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override fun send(events: List<IdeEvent>): TransportResult {
        val token = tokenProvider() ?: throw IllegalStateException("Missing installation credential")

        val body = json.encodeToString(
            EventBatch.serializer(),
            EventBatch(installationId = installationId, events = events),
        )

        val request = HttpRequest.newBuilder()
            .uri(URI.create("$endpoint/v1/events"))
            .timeout(Duration.ofSeconds(15))
            .header("content-type", "application/json")
            .header("authorization", "Bearer $token")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()

        val response = client.send(request, HttpResponse.BodyHandlers.ofString())

        return when (response.statusCode()) {
            in 200..299 -> parseResult(response.body(), events)
            // Permanently invalid: the server names which events to drop.
            400, 422 -> parseResult(response.body(), events, defaultToRejected = true)
            else -> throw IllegalStateException("Ingestion returned ${response.statusCode()}")
        }
    }

    private fun parseResult(
        body: String,
        events: List<IdeEvent>,
        defaultToRejected: Boolean = false,
    ): TransportResult = try {
        val parsed = json.decodeFromString(IngestResponse.serializer(), body)
        TransportResult(
            accepted = parsed.accepted ?: if (defaultToRejected) emptyList() else events.map { it.eventId },
            rejected = parsed.rejected ?: if (defaultToRejected) events.map { it.eventId } else emptyList(),
        )
    } catch (e: Exception) {
        TransportResult(
            accepted = if (defaultToRejected) emptyList() else events.map { it.eventId },
            rejected = if (defaultToRejected) events.map { it.eventId } else emptyList(),
        )
    }

    @kotlinx.serialization.Serializable
    private data class EventBatch(
        @kotlinx.serialization.SerialName("installation_id") val installationId: String,
        val events: List<IdeEvent>,
    )

    @kotlinx.serialization.Serializable
    private data class IngestResponse(
        val accepted: List<String>? = null,
        val rejected: List<String>? = null,
    )
}
