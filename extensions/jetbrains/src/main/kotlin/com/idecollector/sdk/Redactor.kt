package com.idecollector.sdk

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/**
 * Kotlin port of `packages/crypto/src/redaction.ts`. The rules must stay in
 * step with the TypeScript implementation: the ingestion service applies the
 * same redaction again at the trust boundary, so a rule missing here is caught
 * server-side, but relying on that would mean secrets crossing the network.
 */
object Redactor {
    private const val REDACTED = "[REDACTED]"

    private val sensitiveKeys = listOf(
        Regex("password", RegexOption.IGNORE_CASE),
        Regex("passwd", RegexOption.IGNORE_CASE),
        Regex("secret", RegexOption.IGNORE_CASE),
        Regex("api[_-]?key", RegexOption.IGNORE_CASE),
        Regex("access[_-]?key", RegexOption.IGNORE_CASE),
        Regex("private[_-]?key", RegexOption.IGNORE_CASE),
        Regex("auth(orization)?[_-]?token", RegexOption.IGNORE_CASE),
        Regex("^token$", RegexOption.IGNORE_CASE),
        Regex("bearer", RegexOption.IGNORE_CASE),
        Regex("ssh[_-]?key", RegexOption.IGNORE_CASE),
        Regex("credit[_-]?card", RegexOption.IGNORE_CASE),
        Regex("client[_-]?secret", RegexOption.IGNORE_CASE),
        Regex("refresh[_-]?token", RegexOption.IGNORE_CASE),
    )

    private data class Rule(val pattern: Regex, val replacement: String)

    private val rules = listOf(
        Rule(
            Regex(
                "\\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*\\s*[:=]\\s*)(\\S+)",
                RegexOption.IGNORE_CASE,
            ),
            "$1$REDACTED",
        ),
        Rule(Regex("\\b(AKIA|ASIA)[0-9A-Z]{16}\\b"), REDACTED),
        Rule(Regex("\\b(Bearer\\s+)[A-Za-z0-9\\-._~+/]+=*", RegexOption.IGNORE_CASE), "$1$REDACTED"),
        Rule(Regex("\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b"), REDACTED),
        Rule(
            Regex("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----"),
            REDACTED,
        ),
        Rule(Regex("\\bsk-[A-Za-z0-9]{20,}\\b"), REDACTED),
        Rule(Regex("\\bgh[pousr]_[A-Za-z0-9]{20,}\\b"), REDACTED),
        Rule(Regex("\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b"), REDACTED),
    )

    fun redactString(input: String): String {
        var output = input
        for (rule in rules) {
            output = rule.pattern.replace(output, rule.replacement)
        }
        return output
    }

    fun isSensitiveKey(key: String): Boolean = sensitiveKeys.any { it.containsMatchIn(key) }

    fun redact(element: JsonElement, depth: Int = 0): JsonElement {
        if (depth > 8) return JsonPrimitive(REDACTED)
        return when (element) {
            is JsonPrimitive ->
                if (element.isString) JsonPrimitive(redactString(element.content)) else element

            is JsonArray -> buildJsonArray {
                element.forEach { add(redact(it, depth + 1)) }
            }

            is JsonObject -> buildJsonObject {
                element.forEach { (key, value) ->
                    if (isSensitiveKey(key)) {
                        put(key, JsonPrimitive(REDACTED))
                    } else {
                        put(key, redact(value, depth + 1))
                    }
                }
            }
        }
    }

    fun redactPayload(payload: Map<String, JsonElement>): Map<String, JsonElement> =
        payload.mapValues { (key, value) ->
            if (isSensitiveKey(key)) JsonPrimitive(REDACTED) else redact(value)
        }
}
