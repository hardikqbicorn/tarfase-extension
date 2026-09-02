package com.idecollector.settings

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.Service

/**
 * Persisted, user-editable settings. Mirrors the VS Code extension's
 * `telemetry.*` configuration so the two adapters expose the same controls.
 *
 * Note what is NOT here: no credential. Tokens live in the IDE's PasswordSafe
 * (see CredentialStore), which is backed by the OS keychain - never in
 * settings, which are plain XML and are synced by Settings Repository.
 */
@Service(Service.Level.APP)
@State(
    name = "IdeEventCollectorSettings",
    storages = [Storage("ide-event-collector.xml")],
)
class CollectorSettings : PersistentStateComponent<CollectorSettings.State> {

    data class State(
        /** Collection is strictly opt-in. */
        var enabled: Boolean = false,
        var ingestionEndpoint: String = "http://localhost:8080",
        var registrationEndpoint: String = "http://localhost:8081",
        var batchSize: Int = 50,
        var flushIntervalMillis: Long = 5_000,
        var maxQueueSize: Int = 10_000,
        var redactSecrets: Boolean = true,
        var hashFilePaths: Boolean = false,
        var documentThrottleMillis: Long = 1_000,
        var cursorThrottleMillis: Long = 2_000,
        var disabledEventTypes: MutableList<String> = mutableListOf(),
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    companion object {
        fun getInstance(): CollectorSettings =
            ApplicationManager.getApplication().getService(CollectorSettings::class.java)
    }
}

/**
 * Installation credentials, stored in the IDE's PasswordSafe so they are held
 * in the OS keychain rather than on disk in the clear.
 */
object CredentialStore {

    data class InstallationCredentials(
        val installationId: String,
        val installationToken: String,
        val userId: String,
    )

    private const val SERVICE_KEY = "ide-event-collector"

    private fun attributes(): CredentialAttributes =
        CredentialAttributes(generateServiceName("IDE Event Collector", SERVICE_KEY))

    fun load(): InstallationCredentials? {
        val credentials = PasswordSafe.instance.get(attributes()) ?: return null
        val token = credentials.getPasswordAsString() ?: return null
        // userName holds "installationId:userId"; the password holds the token.
        val parts = credentials.userName?.split(":") ?: return null
        if (parts.size != 2) return null
        return InstallationCredentials(
            installationId = parts[0],
            userId = parts[1],
            installationToken = token,
        )
    }

    fun store(credentials: InstallationCredentials) {
        PasswordSafe.instance.set(
            attributes(),
            Credentials(
                "${credentials.installationId}:${credentials.userId}",
                credentials.installationToken,
            ),
        )
    }

    fun clear() {
        PasswordSafe.instance.set(attributes(), null)
    }
}
