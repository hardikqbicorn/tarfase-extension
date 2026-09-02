package com.idecollector.listeners

import com.idecollector.CollectorService
import com.idecollector.schema.EventTypes
import com.idecollector.schema.FileInfo
import com.intellij.openapi.fileEditor.FileDocumentManagerListener
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.components.service
import kotlinx.serialization.json.JsonPrimitive

/**
 * IntelliJ Platform equivalents of the VS Code file collectors.
 *
 * The mapping between platform listeners and canonical event types is the only
 * IDE-specific logic here - everything after `capture` is shared with every
 * other adapter.
 */

/** file.opened / file.closed / editor.active_changed */
class CollectorFileEditorListener(private val project: Project) : FileEditorManagerListener {

    override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
        val collector = project.service<CollectorService>()
        collector.capture(
            eventType = EventTypes.FILE_OPENED,
            file = collector.fileInfo(file),
            payload = mapOf("is_writable" to JsonPrimitive(file.isWritable)),
        )
    }

    override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
        val collector = project.service<CollectorService>()
        collector.capture(
            eventType = EventTypes.FILE_CLOSED,
            file = collector.fileInfo(file),
        )
    }

    override fun selectionChanged(event: FileEditorManagerEvent) {
        val file = event.newFile ?: return
        val collector = project.service<CollectorService>()
        collector.capture(
            eventType = EventTypes.EDITOR_ACTIVE_CHANGED,
            file = collector.fileInfo(file),
        )
    }
}

/** file.saved - fires for every document the platform flushes to disk. */
class CollectorSaveListener : FileDocumentManagerListener {

    override fun beforeDocumentSaving(document: com.intellij.openapi.editor.Document) {
        val file = com.intellij.openapi.fileEditor.FileDocumentManager
            .getInstance()
            .getFile(document) ?: return

        // A save is project-agnostic at this level, so the event is attributed
        // to whichever open project contains the file.
        val project = com.intellij.openapi.project.ProjectManager.getInstance()
            .openProjects
            .firstOrNull { it.basePath != null && file.path.startsWith(it.basePath!!) }
            ?: return

        val collector = project.service<CollectorService>()
        collector.capture(
            eventType = EventTypes.FILE_SAVED,
            file = collector.fileInfo(file),
            payload = mapOf(
                "line_count" to JsonPrimitive(document.lineCount),
                "size_bytes" to JsonPrimitive(document.textLength),
            ),
        )
    }
}

/**
 * editor.document_changed - the highest-frequency signal in the IDE, so it is
 * throttled per file. Only the shape of the change is recorded, never its text.
 */
class CollectorDocumentListener(private val project: Project) : DocumentListener {

    override fun documentChanged(event: DocumentEvent) {
        val file = com.intellij.openapi.fileEditor.FileDocumentManager
            .getInstance()
            .getFile(event.document) ?: return

        val collector = project.service<CollectorService>()
        val relativePath = collector.relativePath(file)

        collector.capture(
            eventType = EventTypes.EDITOR_DOCUMENT_CHANGED,
            file = FileInfo(path = relativePath, language = file.extension),
            payload = mapOf(
                "chars_added" to JsonPrimitive(event.newLength),
                "chars_removed" to JsonPrimitive(event.oldLength),
                "likely_bulk_insert" to JsonPrimitive(event.newLength > 200),
            ),
            throttleKey = "document_changed:$relativePath",
            throttleMillis = collector.documentThrottleMillis,
        )
    }
}
