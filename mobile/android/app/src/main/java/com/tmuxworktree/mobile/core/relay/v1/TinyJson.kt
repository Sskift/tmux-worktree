package com.tmuxworktree.mobile.core.relay.v1

import kotlin.math.floor

/** Small dependency-free JSON implementation used so the protocol core stays JVM-testable. */
internal object TinyJson {
    fun parseObject(source: String): Map<String, Any?> {
        val parser = Parser(source)
        val value = parser.parseValue()
        parser.skipWhitespace()
        require(parser.finished()) { "unexpected trailing JSON at ${parser.position()}" }
        @Suppress("UNCHECKED_CAST")
        return value as? Map<String, Any?> ?: error("JSON root must be an object")
    }

    fun stringify(value: Any?): String = buildString { appendValue(value) }

    private fun StringBuilder.appendValue(value: Any?) {
        when (value) {
            null -> append("null")
            is String -> appendQuoted(value)
            is Boolean -> append(if (value) "true" else "false")
            is Byte, is Short, is Int, is Long -> append(value.toString())
            is Float -> appendFiniteNumber(value.toDouble())
            is Double -> appendFiniteNumber(value)
            is Map<*, *> -> {
                append('{')
                var first = true
                value.forEach { (key, item) ->
                    if (key !is String) return@forEach
                    if (!first) append(',')
                    first = false
                    appendQuoted(key)
                    append(':')
                    appendValue(item)
                }
                append('}')
            }
            is Iterable<*> -> {
                append('[')
                var first = true
                value.forEach { item ->
                    if (!first) append(',')
                    first = false
                    appendValue(item)
                }
                append(']')
            }
            else -> error("unsupported JSON value: ${value::class.java.name}")
        }
    }

    private fun StringBuilder.appendFiniteNumber(value: Double) {
        require(value.isFinite()) { "JSON does not support non-finite numbers" }
        if (value == floor(value) && value >= Long.MIN_VALUE && value <= Long.MAX_VALUE) {
            append(value.toLong())
        } else {
            append(value)
        }
    }

    private fun StringBuilder.appendQuoted(value: String) {
        append('"')
        value.forEach { char ->
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (char.code < 0x20) {
                    append("\\u")
                    append(char.code.toString(16).padStart(4, '0'))
                } else {
                    append(char)
                }
            }
        }
        append('"')
    }

    private class Parser(private val source: String) {
        private var index: Int = 0

        fun position(): Int = index
        fun finished(): Boolean = index >= source.length

        fun skipWhitespace() {
            while (index < source.length && source[index].isWhitespace()) index++
        }

        fun parseValue(): Any? {
            skipWhitespace()
            require(index < source.length) { "unexpected end of JSON" }
            return when (source[index]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't' -> parseLiteral("true", true)
                'f' -> parseLiteral("false", false)
                'n' -> parseLiteral("null", null)
                '-', in '0'..'9' -> parseNumber()
                else -> error("unexpected JSON character '${source[index]}' at $index")
            }
        }

        private fun parseObject(): Map<String, Any?> {
            expect('{')
            skipWhitespace()
            val result = linkedMapOf<String, Any?>()
            if (takeIf('}')) return result
            while (true) {
                skipWhitespace()
                require(index < source.length && source[index] == '"') { "object key expected at $index" }
                val key = parseString()
                skipWhitespace()
                expect(':')
                result[key] = parseValue()
                skipWhitespace()
                if (takeIf('}')) return result
                expect(',')
            }
        }

        private fun parseArray(): List<Any?> {
            expect('[')
            skipWhitespace()
            val result = mutableListOf<Any?>()
            if (takeIf(']')) return result
            while (true) {
                result += parseValue()
                skipWhitespace()
                if (takeIf(']')) return result
                expect(',')
            }
        }

        private fun parseString(): String {
            expect('"')
            val result = StringBuilder()
            while (index < source.length) {
                val char = source[index++]
                when (char) {
                    '"' -> return result.toString()
                    '\\' -> {
                        require(index < source.length) { "unterminated escape" }
                        when (val escaped = source[index++]) {
                            '"', '\\', '/' -> result.append(escaped)
                            'b' -> result.append('\b')
                            'f' -> result.append('\u000C')
                            'n' -> result.append('\n')
                            'r' -> result.append('\r')
                            't' -> result.append('\t')
                            'u' -> {
                                require(index + 4 <= source.length) { "short unicode escape" }
                                val code = source.substring(index, index + 4).toIntOrNull(16)
                                    ?: error("invalid unicode escape at $index")
                                result.append(code.toChar())
                                index += 4
                            }
                            else -> error("invalid escape '$escaped' at ${index - 1}")
                        }
                    }
                    else -> {
                        require(char.code >= 0x20) { "control character in string" }
                        result.append(char)
                    }
                }
            }
            error("unterminated string")
        }

        private fun parseNumber(): Number {
            val start = index
            if (source[index] == '-') index++
            require(index < source.length) { "invalid number" }
            if (source[index] == '0') {
                index++
            } else {
                require(source[index] in '1'..'9') { "invalid number at $index" }
                while (index < source.length && source[index].isDigit()) index++
            }
            var decimal = false
            if (index < source.length && source[index] == '.') {
                decimal = true
                index++
                require(index < source.length && source[index].isDigit()) { "invalid fraction" }
                while (index < source.length && source[index].isDigit()) index++
            }
            if (index < source.length && (source[index] == 'e' || source[index] == 'E')) {
                decimal = true
                index++
                if (index < source.length && (source[index] == '+' || source[index] == '-')) index++
                require(index < source.length && source[index].isDigit()) { "invalid exponent" }
                while (index < source.length && source[index].isDigit()) index++
            }
            val token = source.substring(start, index)
            return if (decimal) token.toDouble() else token.toLong()
        }

        private fun <T> parseLiteral(text: String, value: T): T {
            require(source.startsWith(text, index)) { "expected $text at $index" }
            index += text.length
            return value
        }

        private fun takeIf(expected: Char): Boolean {
            if (index < source.length && source[index] == expected) {
                index++
                return true
            }
            return false
        }

        private fun expect(expected: Char) {
            require(index < source.length && source[index] == expected) {
                "expected '$expected' at $index"
            }
            index++
        }
    }
}

internal fun Map<String, Any?>.string(name: String, default: String = ""): String =
    when (val value = this[name]) {
        is String -> value
        is Number, is Boolean -> value.toString()
        else -> default
    }

internal fun Map<String, Any?>.nullableString(name: String): String? =
    if (containsKey(name) && this[name] != null) string(name) else null

internal fun Map<String, Any?>.long(name: String, default: Long = 0): Long =
    when (val value = this[name]) {
        is Number -> value.toLong()
        is String -> value.toLongOrNull() ?: default
        else -> default
    }

internal fun Map<String, Any?>.int(name: String, default: Int = 0): Int =
    long(name, default.toLong()).toInt()

internal fun Map<String, Any?>.nullableInt(name: String): Int? =
    if (!containsKey(name) || this[name] == null) null else int(name)

internal fun Map<String, Any?>.boolean(name: String, default: Boolean = false): Boolean =
    when (val value = this[name]) {
        is Boolean -> value
        is String -> value.equals("true", ignoreCase = true)
        is Number -> value.toInt() != 0
        else -> default
    }

internal fun Map<String, Any?>.objects(name: String): List<Map<String, Any?>> {
    val values = this[name] as? List<*> ?: return emptyList()
    return values.mapNotNull { value ->
        @Suppress("UNCHECKED_CAST")
        value as? Map<String, Any?>
    }
}

internal fun Map<String, Any?>.objectValue(name: String): Map<String, Any?>? {
    @Suppress("UNCHECKED_CAST")
    return this[name] as? Map<String, Any?>
}
