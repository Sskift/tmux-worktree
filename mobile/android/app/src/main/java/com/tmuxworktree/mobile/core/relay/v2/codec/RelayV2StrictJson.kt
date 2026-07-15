package com.tmuxworktree.mobile.core.relay.v2.codec

import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.regex.Pattern

internal data class RelayV2JsonLimits(
    val maxDepth: Int,
    val maxDirectKeys: Int,
    val maxTotalKeys: Int,
    val maxNodes: Int,
)

internal data class RelayV2JsonInspection(
    val rootIsObject: Boolean,
    val rootType: String?,
    val totalKeys: Int,
    val totalNodes: Int,
)

internal class RelayV2JsonException(
    val failureClass: String,
) : IllegalArgumentException("Relay v2 JSON is invalid")

internal object RelayV2StrictJson {
    fun decodeUtf8(bytes: ByteArray): String = try {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        throw RelayV2JsonException("invalid-utf8")
    }

    fun inspect(source: String, limits: RelayV2JsonLimits): RelayV2JsonInspection =
        Parser(source, limits, build = false).inspect()

    fun parseObject(source: String, limits: RelayV2JsonLimits): LinkedHashMap<String, Any?> =
        Parser(source, limits, build = true).parseObject()

    fun stringify(value: Any?): String = buildString {
        appendJson(value)
    }

    private fun StringBuilder.appendJson(value: Any?) {
        when (value) {
            null -> append("null")
            is Boolean -> append(if (value) "true" else "false")
            is Byte, is Short, is Int, is Long -> append((value as Number).toLong())
            is Float, is Double -> {
                val number = (value as Number).toDouble()
                require(number.isFinite()) { "JSON number must be finite" }
                append(number)
            }
            is String -> appendJsonString(value)
            is List<*> -> {
                append('[')
                value.forEachIndexed { index, item ->
                    if (index > 0) append(',')
                    appendJson(item)
                }
                append(']')
            }
            is Map<*, *> -> {
                append('{')
                var first = true
                value.forEach { (key, item) ->
                    require(key is String) { "JSON object keys must be strings" }
                    if (!first) append(',')
                    first = false
                    appendJsonString(key)
                    append(':')
                    appendJson(item)
                }
                append('}')
            }
            else -> error("Unsupported JSON value")
        }
    }

    private fun StringBuilder.appendJsonString(value: String) {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) {
                    append("\\u")
                    append(character.code.toString(16).padStart(4, '0'))
                } else {
                    append(character)
                }
            }
        }
        append('"')
    }

    private class Parser(
        private val source: String,
        private val limits: RelayV2JsonLimits,
        private val build: Boolean,
    ) {
        private var offset = 0
        private var totalKeys = 0
        private var totalNodes = 0
        private var rootType: String? = null
        private var rootIsObject = false

        fun inspect(): RelayV2JsonInspection {
            parseDocument()
            return RelayV2JsonInspection(rootIsObject, rootType, totalKeys, totalNodes)
        }

        fun parseObject(): LinkedHashMap<String, Any?> {
            val value = parseDocument()
            if (!rootIsObject || value !is LinkedHashMap<*, *>) fail("non-object-root")
            @Suppress("UNCHECKED_CAST")
            return value as LinkedHashMap<String, Any?>
        }

        private fun parseDocument(): Any? {
            skipWhitespace()
            if (offset >= source.length) fail("malformed-json")
            val value = parseValue(depth = 0, root = true)
            skipWhitespace()
            if (offset != source.length) fail("trailing-json")
            return value
        }

        private fun parseValue(depth: Int, root: Boolean = false): Any? {
            totalNodes += 1
            if (totalNodes > limits.maxNodes) fail("json-node-limit")
            if (offset >= source.length) fail("malformed-json")
            return when (source[offset]) {
                '{' -> {
                    if (depth + 1 > limits.maxDepth) fail("json-depth-limit")
                    if (root) rootIsObject = true
                    parseMap(depth + 1)
                }
                '[' -> {
                    if (depth + 1 > limits.maxDepth) fail("json-depth-limit")
                    parseList(depth + 1)
                }
                '"' -> parseString()
                't' -> parseLiteral("true", true)
                'f' -> parseLiteral("false", false)
                'n' -> parseLiteral("null", null)
                else -> parseNumber()
            }
        }

        private fun parseMap(depth: Int): Any? {
            offset += 1
            skipWhitespace()
            val result = if (build) linkedMapOf<String, Any?>() else null
            val seen = hashSetOf<String>()
            var directKeys = 0
            if (peek() == '}') {
                offset += 1
                return result
            }
            while (offset < source.length) {
                if (peek() != '"') fail("malformed-json")
                val key = parseString()
                if (!seen.add(key)) fail("duplicate-key")
                directKeys += 1
                if (directKeys > limits.maxDirectKeys) fail("json-direct-key-limit")
                totalKeys += 1
                if (totalKeys > limits.maxTotalKeys) fail("json-total-key-limit")
                skipWhitespace()
                if (peek() != ':') fail("malformed-json")
                offset += 1
                skipWhitespace()
                val value = parseValue(depth)
                if (depth == 1 && key == "type" && value is String) rootType = value
                result?.put(key, value)
                skipWhitespace()
                when (peek()) {
                    '}' -> {
                        offset += 1
                        return result
                    }
                    ',' -> {
                        offset += 1
                        skipWhitespace()
                    }
                    else -> fail("malformed-json")
                }
            }
            fail("malformed-json")
        }

        private fun parseList(depth: Int): Any? {
            offset += 1
            skipWhitespace()
            val result = if (build) mutableListOf<Any?>() else null
            if (peek() == ']') {
                offset += 1
                return result
            }
            while (offset < source.length) {
                result?.add(parseValue(depth)) ?: parseValue(depth)
                skipWhitespace()
                when (peek()) {
                    ']' -> {
                        offset += 1
                        return result
                    }
                    ',' -> {
                        offset += 1
                        skipWhitespace()
                    }
                    else -> fail("malformed-json")
                }
            }
            fail("malformed-json")
        }

        private fun parseString(): String {
            if (peek() != '"') fail("malformed-json")
            offset += 1
            val result = StringBuilder()
            while (offset < source.length) {
                val character = source[offset++]
                when {
                    character == '"' -> return result.toString()
                    character.code < 0x20 -> fail("malformed-json")
                    character != '\\' -> result.append(character)
                    offset >= source.length -> fail("malformed-json")
                    else -> {
                        when (val escape = source[offset++]) {
                            '"' -> result.append('"')
                            '\\' -> result.append('\\')
                            '/' -> result.append('/')
                            'b' -> result.append('\b')
                            'f' -> result.append('\u000C')
                            'n' -> result.append('\n')
                            'r' -> result.append('\r')
                            't' -> result.append('\t')
                            'u' -> {
                                if (offset + 4 > source.length) fail("malformed-json")
                                val digits = source.substring(offset, offset + 4)
                                val code = digits.toIntOrNull(16) ?: fail("malformed-json")
                                result.append(code.toChar())
                                offset += 4
                            }
                            else -> {
                                @Suppress("UNUSED_VARIABLE")
                                val ignored = escape
                                fail("malformed-json")
                            }
                        }
                    }
                }
            }
            fail("malformed-json")
        }

        private fun parseNumber(): Number {
            val matcher = NUMBER_PATTERN.matcher(source)
            matcher.region(offset, source.length)
            if (!matcher.lookingAt()) fail("malformed-json")
            val token = matcher.group()
            offset += token.length
            if (token.none { it == '.' || it == 'e' || it == 'E' }) {
                val integer = try {
                    BigInteger(token)
                } catch (_: NumberFormatException) {
                    fail("malformed-json")
                }
                if (integer > MAX_SAFE_INTEGER || integer < MIN_SAFE_INTEGER) {
                    fail("safe-integer-limit")
                }
                return integer.toLong()
            }
            val number = token.toDoubleOrNull() ?: fail("malformed-json")
            if (!number.isFinite()) fail("malformed-json")
            return number
        }

        private fun <T> parseLiteral(text: String, value: T): T {
            if (!source.startsWith(text, offset)) fail("malformed-json")
            offset += text.length
            return value
        }

        private fun skipWhitespace() {
            while (offset < source.length && source[offset] in JSON_WHITESPACE) offset += 1
        }

        private fun peek(): Char? = source.getOrNull(offset)

        private fun fail(failureClass: String): Nothing {
            throw RelayV2JsonException(failureClass)
        }
    }

    private val JSON_WHITESPACE = setOf(' ', '\t', '\r', '\n')
    private val NUMBER_PATTERN = Pattern.compile("-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")
    private val MAX_SAFE_INTEGER = BigInteger.valueOf(9_007_199_254_740_991L)
    private val MIN_SAFE_INTEGER = MAX_SAFE_INTEGER.negate()
}
