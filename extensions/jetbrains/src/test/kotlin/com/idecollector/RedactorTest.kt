package com.idecollector

import com.idecollector.sdk.Redactor
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * These mirror `packages/crypto/src/redaction.test.ts`. The two
 * implementations must agree: a rule that exists in one and not the other
 * means secrets leave one IDE family and not another.
 */
class RedactorTest {

    @Test
    fun `redacts env-style secret assignments`() {
        val output = Redactor.redactString("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456")
        assertFalse(output.contains("sk-abcdefghijklmnopqrstuvwxyz123456"))
        assertTrue(output.contains("[REDACTED]"))
    }

    @Test
    fun `redacts passwords`() {
        val output = Redactor.redactString("DATABASE_PASSWORD=hunter2")
        assertFalse(output.contains("hunter2"))
    }

    @Test
    fun `redacts bearer tokens`() {
        val output = Redactor.redactString("Authorization: Bearer abc.def-ghi_123")
        assertFalse(output.contains("abc.def-ghi_123"))
    }

    @Test
    fun `redacts github tokens`() {
        val output = Redactor.redactString("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
        assertFalse(output.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"))
    }

    @Test
    fun `redacts private key blocks`() {
        val key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
        assertFalse(Redactor.redactString(key).contains("MIIEpAIBAAKCAQEA"))
    }

    @Test
    fun `redacts sensitive keys regardless of value shape`() {
        val payload = mapOf(
            "password" to JsonPrimitive("hunter2"),
            "safe" to JsonPrimitive("ok"),
        )
        val result = Redactor.redactPayload(payload)
        assertEquals(JsonPrimitive("[REDACTED]"), result["password"])
        assertEquals(JsonPrimitive("ok"), result["safe"])
    }

    @Test
    fun `redacts nested sensitive keys`() {
        val payload = mapOf(
            "outer" to buildJsonObject { put("apiKey", JsonPrimitive("abc123")) },
        )
        val result = Redactor.redactPayload(payload)
        assertFalse(result.toString().contains("abc123"))
    }

    @Test
    fun `leaves non-sensitive payloads untouched`() {
        val payload = mapOf(
            "file_path" to JsonPrimitive("src/index.ts"),
            "line_count" to JsonPrimitive(42),
        )
        assertEquals(payload, Redactor.redactPayload(payload))
    }
}
