package com.tmuxworktree.mobile.core.relay.v2.codec

/**
 * Sorted-keys canonical JSON used by the state and outbox hash paths.
 *
 * The output feeds SHA-256 identity/dedupe hashes, so it must stay byte-stable across callers;
 * keep this as the single implementation rather than re-deriving it per module.
 */
internal object RelayV2CanonicalJson {
    fun stringify(value: Any?): String = buildString { appendValue(value) }

    private fun StringBuilder.appendValue(value: Any?) {
        when (value) {
            null -> append("null")
            is Boolean -> append(if (value) "true" else "false")
            is Byte, is Short, is Int, is Long -> append((value as Number).toLong())
            is String -> appendString(value)
            is List<*> -> {
                append('[')
                value.forEachIndexed { index, item ->
                    if (index > 0) append(',')
                    appendValue(item)
                }
                append(']')
            }
            is Map<*, *> -> {
                val entries = value.entries.map {
                    require(it.key is String)
                    (it.key as String) to it.value
                }.sortedBy { it.first }
                append('{')
                entries.forEachIndexed { index, (key, item) ->
                    if (index > 0) append(',')
                    appendString(key)
                    append(':')
                    appendValue(item)
                }
                append('}')
            }
            else -> error("Unsupported canonical JSON value")
        }
    }

    private fun StringBuilder.appendString(value: String) {
        append('"')
        var index = 0
        while (index < value.length) {
            val character = value[index]
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\t' -> append("\\t")
                '\n' -> append("\\n")
                '\u000C' -> append("\\f")
                '\r' -> append("\\r")
                else -> when {
                    character.code < 0x20 -> append(
                        "\\u" + character.code.toString(16).padStart(4, '0'),
                    )
                    character.isHighSurrogate() -> {
                        require(index + 1 < value.length && value[index + 1].isLowSurrogate())
                        append(character)
                        append(value[index + 1])
                        index += 1
                    }
                    character.isLowSurrogate() -> error("Unpaired low surrogate")
                    else -> append(character)
                }
            }
            index += 1
        }
        append('"')
    }
}
