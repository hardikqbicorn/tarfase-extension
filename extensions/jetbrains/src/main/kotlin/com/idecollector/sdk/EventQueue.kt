package com.idecollector.sdk

import com.idecollector.schema.IdeEvent
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * Kotlin port of `packages/event-sdk/src/queue.ts`: a bounded, ordered,
 * crash-recoverable local buffer.
 *
 * Unlike the TypeScript version, this runs on a multi-threaded platform -
 * IntelliJ fires listeners from several threads - so every mutation is guarded
 * by a lock. Persistence writes to a temp file and atomically moves it into
 * place, so an IDE crash mid-write cannot corrupt the queue.
 */
class EventQueue(
    private val maxQueueSize: Int,
    private val storagePath: Path,
    private val onDrop: (QueuedEvent) -> Unit = {},
) {
    @Serializable
    data class QueuedEvent(
        val event: IdeEvent,
        var attempts: Int = 0,
        var nextRetryAtMillis: Long = 0,
        val enqueuedAtMillis: Long = System.currentTimeMillis(),
    )

    @Serializable
    private data class Snapshot(val version: Int = 1, val items: List<QueuedEvent> = emptyList())

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val lock = ReentrantLock()
    private val items = ArrayDeque<QueuedEvent>()

    @Volatile
    var totalDropped: Int = 0
        private set

    val size: Int get() = lock.withLock { items.size }

    /** Restores any events persisted by a previous IDE session. */
    fun load() {
        lock.withLock {
            if (!Files.exists(storagePath)) return
            try {
                val snapshot = json.decodeFromString<Snapshot>(Files.readString(storagePath))
                items.clear()
                items.addAll(snapshot.items)
            } catch (e: Exception) {
                // A corrupt or stale-format queue is treated as empty rather
                // than blocking startup.
                items.clear()
            }
        }
    }

    fun enqueue(event: IdeEvent) {
        lock.withLock {
            if (items.size >= maxQueueSize) {
                items.removeFirstOrNull()?.let {
                    totalDropped++
                    onDrop(it)
                }
            }
            items.addLast(QueuedEvent(event))
        }
    }

    /** Oldest-first events currently past their retry backoff. */
    fun peekReady(limit: Int): List<QueuedEvent> = lock.withLock {
        val now = System.currentTimeMillis()
        items.asSequence().filter { it.nextRetryAtMillis <= now }.take(limit).toList()
    }

    fun ack(eventIds: Set<String>) {
        lock.withLock { items.removeAll { it.event.eventId in eventIds } }
    }

    /** Marks events failed, applying exponential backoff with full jitter. */
    fun nack(eventIds: Set<String>) {
        lock.withLock {
            items.filter { it.event.eventId in eventIds }.forEach {
                it.attempts += 1
                it.nextRetryAtMillis = System.currentTimeMillis() + backoffMillis(it.attempts - 1)
            }
        }
    }

    fun persist() {
        val snapshot = lock.withLock { Snapshot(items = items.toList()) }
        try {
            Files.createDirectories(storagePath.parent)
            val temp = storagePath.resolveSibling("${storagePath.fileName}.tmp")
            Files.writeString(temp, json.encodeToString(Snapshot.serializer(), snapshot))
            Files.move(temp, storagePath, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: Exception) {
            // Losing the on-disk copy is survivable; failing the IDE is not.
        }
    }

    private fun backoffMillis(attempt: Int): Long {
        val raw = min(500.0 * 2.0.pow(attempt), 30_000.0)
        return Random.nextLong(raw.toLong().coerceAtLeast(1))
    }
}
