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
}

private fun Map<String, Any?>.stringValue(name: String): String =
    this[name] as? String ?: error("Fixture field must be a string: " + name)

private fun Map<String, Any?>.stringList(name: String): List<String> =
    (this[name] as? List<*>)?.map {
        it as? String ?: error("Fixture list item must be a string: " + name)
    } ?: error("Fixture field must be an array: " + name)
