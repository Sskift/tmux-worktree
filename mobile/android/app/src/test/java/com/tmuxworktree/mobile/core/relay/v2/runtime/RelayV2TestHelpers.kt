package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxResult
import java.security.MessageDigest
import java.util.Base64

/**
 * F052: SHA-256 + Base64 URL no-padding fingerprint shared by relay v2 tests.
 * Uses explicit UTF-8 (equivalent to the JVM default toByteArray() on all copies).
 */
internal fun fingerprint(token: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)),
    )

/**
 * F052: Assert a relay v2 outbox result is Applied and return it.
 * Standardises the previous assertTrue/check/raw-cast copies on check().
 */
internal fun RelayV2OutboxResult.expectApplied(): RelayV2OutboxResult.Applied {
    check(this is RelayV2OutboxResult.Applied)
    return this
}

/**
 * F049: Deep-clone a fixture map so tests can mutate it without touching the
 * shared golden. Fully recursive (superset of the previous Map-only copies):
 * nested Maps and Lists inside Lists are cloned too.
 */
@Suppress("UNCHECKED_CAST")
internal fun deepClone(source: Map<String, Any?>): MutableMap<String, Any?> =
    linkedMapOf<String, Any?>().apply {
        source.forEach { (key, value) -> put(key, deepCloneValue(value)) }
    }

private fun deepCloneValue(value: Any?): Any? = when (value) {
    is Map<*, *> -> deepClone(value as Map<String, Any?>)
    is List<*> -> value.map(::deepCloneValue).toMutableList()
    else -> value
}

/** F049: Extract the "payload" object from a relay v2 frame. */
@Suppress("UNCHECKED_CAST")
internal fun MutableMap<String, Any?>.payload(): MutableMap<String, Any?> =
    getValue("payload") as MutableMap<String, Any?>

/** F049: Extract a string field from a fixture map, with a field-name error message. */
internal fun Map<String, Any?>.stringValue(name: String): String =
    this[name] as? String ?: error("Fixture field must be a string: " + name)

/** F049: Extract a string-list field from a fixture map, with a field-name error message. */
internal fun Map<String, Any?>.stringList(name: String): List<String> =
    (this[name] as? List<*>)?.map {
        it as? String ?: error("Fixture list item must be a string: " + name)
    } ?: error("Fixture field must be an array: " + name)
