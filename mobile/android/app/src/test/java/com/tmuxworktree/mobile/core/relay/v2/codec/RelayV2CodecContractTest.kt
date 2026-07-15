package com.tmuxworktree.mobile.core.relay.v2.codec

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RelayV2CodecContractTest {
    private val codec = RelayV2Codec()
    private val fixtures = RelayV2ContractFixtures()

    @Test
    fun androidCodecConsumesEverySharedGoldenFixture() {
        fixtures.golden.forEach { fixture ->
            val wire = RelayV2StrictJson.stringify(fixture.frame)
            val bytes = wire.toByteArray(StandardCharsets.UTF_8)
            val decoded = when (fixture.channel) {
                "public" -> codec.decodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    bytes,
                )
                "carrier" -> codec.decodeWebSocketFrame(
                    RelayV2WebSocketChannel.CARRIER,
                    bytes,
                )
                "https" -> codec.decodeHttpsBody(
                    RelayV2HttpsSchema.fromWireName(requireNotNull(fixture.schema)),
                    bytes,
                )
                else -> error("Unsupported fixture channel " + fixture.channel)
            }
            assertEquals(
                fixture.name,
                fixture.normalized,
                decoded.normalized.asFixtureMap(),
            )
            assertEquals(fixture.name, wire, decoded.canonicalWire)
            val encoded = when (fixture.channel) {
                "public" -> codec.encodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    decoded.frame,
                )
                "carrier" -> codec.encodeWebSocketFrame(
                    RelayV2WebSocketChannel.CARRIER,
                    decoded.frame,
                )
                "https" -> codec.encodeHttpsBody(
                    RelayV2HttpsSchema.fromWireName(requireNotNull(fixture.schema)),
                    decoded.frame,
                )
                else -> error("Unsupported fixture channel " + fixture.channel)
            }
            assertArrayEquals(fixture.name, bytes, encoded)
        }
    }

    @Test
    fun androidCodecRejectsEverySharedInvalidVector() {
        fixtures.invalidCases().forEach { vector ->
            val error = assertThrows(vector.name, RelayV2CodecException::class.java) {
                when (vector.channel) {
                    "public" -> codec.decodeWebSocketFrame(
                        RelayV2WebSocketChannel.PUBLIC,
                        vector.bytes,
                        RelayV2FrameMetadata(
                            opcode = vector.opcode ?: "text",
                            compressed = vector.compressed ?: false,
                        ),
                    )
                    "carrier" -> codec.decodeWebSocketFrame(
                        RelayV2WebSocketChannel.CARRIER,
                        vector.bytes,
                        RelayV2FrameMetadata(
                            opcode = vector.opcode ?: "text",
                            compressed = vector.compressed ?: false,
                        ),
                    )
                    "https" -> codec.decodeHttpsBody(
                        RelayV2HttpsSchema.fromWireName(requireNotNull(vector.schema)),
                        vector.bytes,
                        vector.contentEncoding,
                    )
                    else -> error("Unsupported fixture channel " + vector.channel)
                }
            }
            assertEquals(vector.name, vector.expectedCode, error.code)
            assertEquals(vector.name, vector.expectedFailureClass, error.failureClass)
        }
    }

    @Test
    fun androidCommandSchemaRejectsOuterWhitespaceExceptInMessage() {
        val strictFields = listOf(
            Triple("command-execute-create-worktree", "project", " demo"),
            Triple("command-execute-create-worktree", "path", "/repo/demo "),
            Triple("command-execute-create-worktree", "name", " fix-auth"),
            Triple("command-execute-create-worktree", "branch", "main "),
            Triple("command-execute-create-worktree", "aiCommand", " codex"),
            Triple("command-execute-create-terminal", "cwd", " /repo/demo"),
            Triple("command-execute-create-terminal", "label", "demo shell "),
        )
        strictFields.forEach { (fixtureName, field, value) ->
            val frame = fixture(fixtureName)
            frame.commandArguments()[field] = value
            val error = assertThrows(field, RelayV2CodecException::class.java) {
                codec.decodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    RelayV2StrictJson.stringify(frame).toByteArray(StandardCharsets.UTF_8),
                )
            }
            assertEquals(field, "INVALID_ENVELOPE", error.code)
            assertEquals(field, "invalid-argument", error.failureClass)
        }

        val messageFrame = fixture("command-execute-send-agent-message")
        messageFrame.commandArguments()["message"] = " continue "
        val decoded = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            RelayV2StrictJson.stringify(messageFrame).toByteArray(StandardCharsets.UTF_8),
        )
        assertEquals("command.execute", decoded.frame["type"])
    }

    @Test
    fun androidTerminalSequenceStartsAtOneWhileAckBaselineAllowsZero() {
        val sequenceFields = listOf(
            "terminal-input" to "inputSeq",
            "terminal-input-error" to "inputSeq",
            "terminal-resize" to "resizeSeq",
            "terminal-resize-error" to "resizeSeq",
        )
        sequenceFields.forEach { (fixtureName, field) ->
            val frame = fixture(fixtureName)
            frame.payload()[field] = "0"
            val error = assertThrows(fixtureName, RelayV2CodecException::class.java) {
                decodePublic(frame)
            }
            assertEquals(fixtureName, "INVALID_ENVELOPE", error.code)
            assertEquals(fixtureName, "invalid-argument", error.failureClass)
        }

        val ackBaselines = listOf(
            "terminal-input-ack" to "ackedThroughInputSeq",
            "terminal-input-error" to "ackedThroughInputSeq",
            "terminal-resize-ack" to "ackedThroughResizeSeq",
            "terminal-resize-error" to "ackedThroughResizeSeq",
        )
        ackBaselines.forEach { (fixtureName, field) ->
            val frame = fixture(fixtureName)
            frame.payload()[field] = "0"
            assertEquals(fixtureName, frame["type"], decodePublic(frame).frame["type"])
        }
    }

    @Test
    fun androidDialectResolutionMatchesSharedNoFallbackMatrix() {
        fixtures.dialect.forEach { fixture ->
            val clientDialect = RelayV2ClientDialect.fromWireName(
                fixture.input.stringValue("clientDialect"),
            )
            val hostDialects = fixture.input.stringList("hostDialects")
                .map(RelayV2ClientDialect::fromWireName)
            val outcome = codec.resolveRouteDialect(
                clientDialect = clientDialect,
                hostDialects = hostDialects,
                requiredCapabilities = fixture.input.stringList("requiredCapabilities"),
                hostCapabilities = fixture.input.stringList("hostCapabilities"),
            )
            assertEquals(fixture.name, fixture.expected, outcome.asFixtureMap())
        }
    }

    private fun fixture(name: String): MutableMap<String, Any?> = deepClone(
        fixtures.golden.single { it.name == name }.frame,
    )

    private fun decodePublic(frame: Map<String, Any?>): RelayV2DecodedMessage =
        codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            RelayV2StrictJson.stringify(frame).toByteArray(StandardCharsets.UTF_8),
        )
}

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.commandArguments(): MutableMap<String, Any?> =
    payload()
        .getValue("arguments") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.payload(): MutableMap<String, Any?> =
    getValue("payload") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun deepClone(source: Map<String, Any?>): MutableMap<String, Any?> =
    linkedMapOf<String, Any?>().apply {
        source.forEach { (key, value) ->
            put(
                key,
                when (value) {
                    is Map<*, *> -> deepClone(value as Map<String, Any?>)
                    is List<*> -> value.map { item ->
                        if (item is Map<*, *>) deepClone(item as Map<String, Any?>) else item
                    }.toMutableList()
                    else -> value
                },
            )
        }
    }

private fun Map<String, Any?>.stringValue(name: String): String =
    this[name] as? String ?: error("Fixture field must be a string: " + name)

private fun Map<String, Any?>.stringList(name: String): List<String> =
    (this[name] as? List<*>)?.map {
        it as? String ?: error("Fixture list item must be a string: " + name)
    } ?: error("Fixture field must be an array: " + name)
