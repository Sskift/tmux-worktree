package com.tmuxworktree.mobile.core.relay.v2.codec

class RelayV2Codec {
    fun decodeWebSocketFrame(
        channel: RelayV2WebSocketChannel,
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata = RelayV2FrameMetadata(),
    ): RelayV2DecodedMessage = mapCodecFailures {
        val frame = parseWebSocketObject(channel, bytes, metadata)
        val normalized = when (channel) {
            RelayV2WebSocketChannel.PUBLIC -> validateRelayV2PublicFrame(frame)
            RelayV2WebSocketChannel.CARRIER -> validateRelayV2CarrierFrame(frame)
        }
        RelayV2DecodedMessage(
            frame = frame,
            normalized = normalized,
            canonicalWire = RelayV2StrictJson.stringify(frame),
        )
    }

    fun decodeHttpsBody(
        schema: RelayV2HttpsSchema,
        bytes: ByteArray,
        contentEncoding: String? = null,
    ): RelayV2DecodedMessage = mapCodecFailures {
        val frame = parseHttpsObject(bytes, contentEncoding)
        RelayV2DecodedMessage(
            frame = frame,
            normalized = validateRelayV2HttpsBody(schema, frame),
            canonicalWire = RelayV2StrictJson.stringify(frame),
        )
    }

    fun encodeWebSocketFrame(
        channel: RelayV2WebSocketChannel,
        frame: Map<String, Any?>,
    ): ByteArray = mapCodecFailures {
        when (channel) {
            RelayV2WebSocketChannel.PUBLIC -> validateRelayV2PublicFrame(frame)
            RelayV2WebSocketChannel.CARRIER -> validateRelayV2CarrierFrame(frame)
        }
        encodeBounded(
            frame,
            if (channel == RelayV2WebSocketChannel.PUBLIC) {
                PUBLIC_FRAME_BYTES
            } else {
                CARRIER_FRAME_BYTES
            },
        )
    }

    fun encodeHttpsBody(
        schema: RelayV2HttpsSchema,
        body: Map<String, Any?>,
    ): ByteArray = mapCodecFailures {
        validateRelayV2HttpsBody(schema, body)
        encodeBounded(body, HTTPS_BODY_BYTES)
    }

    fun resolveRouteDialect(
        clientDialect: RelayV2ClientDialect,
        hostDialects: Collection<RelayV2ClientDialect>,
        requiredCapabilities: Collection<String> = emptyList(),
        hostCapabilities: Collection<String> = emptyList(),
    ): RelayV2DialectOutcome {
        if (clientDialect !in hostDialects) {
            return RelayV2DialectRejected("HOST_DIALECT_UNAVAILABLE")
        }
        if (
            clientDialect == RelayV2ClientDialect.V2 &&
            !hostCapabilities.containsAll(requiredCapabilities)
        ) {
            return RelayV2DialectRejected("CAPABILITY_UNAVAILABLE")
        }
        return RelayV2DialectAccepted(clientDialect)
    }

    private fun parseWebSocketObject(
        channel: RelayV2WebSocketChannel,
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata,
    ): LinkedHashMap<String, Any?> {
        if (metadata.opcode != "text") {
            throw RelayV2CodecException("INVALID_ENVELOPE", "binary-frame")
        }
        if (metadata.compressed) {
            throw RelayV2CodecException(
                "PROTOCOL_UNSUPPORTED",
                "compression-not-allowed",
            )
        }
        val frameLimit = if (channel == RelayV2WebSocketChannel.PUBLIC) {
            PUBLIC_FRAME_BYTES
        } else {
            CARRIER_FRAME_BYTES
        }
        if (bytes.size > frameLimit) {
            throw RelayV2CodecException("INVALID_ENVELOPE", "frame-limit")
        }
        val source = RelayV2StrictJson.decodeUtf8(bytes)
        val inspection = RelayV2StrictJson.inspect(
            source,
            if (channel == RelayV2WebSocketChannel.PUBLIC) {
                SNAPSHOT_JSON_LIMITS
            } else {
                STANDARD_JSON_LIMITS
            },
        )
        val limits = if (
            channel == RelayV2WebSocketChannel.PUBLIC &&
            inspection.rootIsObject &&
            inspection.rootType == "state.snapshot.chunk"
        ) {
            SNAPSHOT_JSON_LIMITS
        } else {
            STANDARD_JSON_LIMITS
        }
        if (inspection.totalKeys > limits.maxTotalKeys) {
            throw RelayV2CodecException("INVALID_ENVELOPE", "json-total-key-limit")
        }
        if (inspection.totalNodes > limits.maxNodes) {
            throw RelayV2CodecException("INVALID_ENVELOPE", "json-node-limit")
        }
        return RelayV2StrictJson.parseObject(source, limits)
    }

    private fun parseHttpsObject(
        bytes: ByteArray,
        contentEncoding: String?,
    ): LinkedHashMap<String, Any?> {
        if (
            !contentEncoding.isNullOrEmpty() &&
            !contentEncoding.equals("identity", ignoreCase = true)
        ) {
            throw RelayV2CodecException(
                "PROTOCOL_UNSUPPORTED",
                "compression-not-allowed",
            )
        }
        if (bytes.size > HTTPS_BODY_BYTES) {
            throw RelayV2CodecException("INVALID_ENVELOPE", "frame-limit")
        }
        return RelayV2StrictJson.parseObject(
            RelayV2StrictJson.decodeUtf8(bytes),
            HTTP_JSON_LIMITS,
        )
    }

    private fun encodeBounded(frame: Map<String, Any?>, limit: Int): ByteArray {
        val bytes = RelayV2StrictJson.stringify(frame).toByteArray(Charsets.UTF_8)
        if (bytes.size > limit) {
            throw RelayV2CodecException("INVALID_ENVELOPE", "frame-limit")
        }
        return bytes
    }

    private inline fun <T> mapCodecFailures(block: () -> T): T = try {
        block()
    } catch (error: RelayV2CodecException) {
        throw error
    } catch (error: RelayV2JsonException) {
        throw RelayV2CodecException("INVALID_ENVELOPE", error.failureClass)
    } catch (error: RelayV2SchemaException) {
        throw RelayV2CodecException("INVALID_ENVELOPE", error.failureClass)
    }

    companion object {
        const val PUBLIC_FRAME_BYTES = 1_048_576
        const val CARRIER_FRAME_BYTES = 1_500_000
        const val HTTPS_BODY_BYTES = 16_384

        private val STANDARD_JSON_LIMITS = RelayV2JsonLimits(
            maxDepth = 16,
            maxDirectKeys = 256,
            maxTotalKeys = 1_024,
            maxNodes = 4_096,
        )
        private val SNAPSHOT_JSON_LIMITS = RelayV2JsonLimits(
            maxDepth = 16,
            maxDirectKeys = 256,
            maxTotalKeys = 8_192,
            maxNodes = 16_384,
        )
        private val HTTP_JSON_LIMITS = RelayV2JsonLimits(
            maxDepth = 8,
            maxDirectKeys = 32,
            maxTotalKeys = 32,
            maxNodes = 128,
        )
    }
}
