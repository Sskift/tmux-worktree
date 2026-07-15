package com.tmuxworktree.mobile.core.relay.v2.codec

enum class RelayV2WebSocketChannel(val wireName: String) {
    PUBLIC("public"),
    CARRIER("carrier"),
}

data class RelayV2FrameMetadata(
    val opcode: String = "text",
    val compressed: Boolean = false,
)

enum class RelayV2HttpsSchema(val wireName: String) {
    ENROLLMENT_REDEEM_REQUEST("enrollment.redeem.request"),
    ENROLLMENT_REDEEM_RESPONSE("enrollment.redeem.response"),
    TOKEN_REFRESH_CLIENT_REQUEST("token.refresh.client.request"),
    TOKEN_REFRESH_CLIENT_RESPONSE("token.refresh.client.response"),
    GRANT_SELF_REVOKE_REQUEST("grant.self-revoke.request"),
    GRANT_SELF_REVOKE_RESPONSE("grant.self-revoke.response"),
    HOST_BOOTSTRAP_REQUEST("host.bootstrap.request"),
    HOST_BOOTSTRAP_RESPONSE("host.bootstrap.response"),
    TOKEN_REFRESH_HOST_REQUEST("token.refresh.host.request"),
    TOKEN_REFRESH_HOST_RESPONSE("token.refresh.host.response"),
    ERROR_RESPONSE("error.response"),
    ;

    companion object {
        fun fromWireName(value: String): RelayV2HttpsSchema =
            entries.firstOrNull { it.wireName == value }
                ?: throw IllegalArgumentException("Unknown Relay v2 HTTPS schema")
    }
}

sealed interface RelayV2NormalizedMessage {
    fun asFixtureMap(): Map<String, Any?>
}

data class RelayV2NormalizedPublicFrame(
    val version: Int,
    val kind: String,
    val type: String,
    val requestId: String?,
) : RelayV2NormalizedMessage {
    override fun asFixtureMap(): Map<String, Any?> = linkedMapOf(
        "channel" to "public",
        "version" to version.toLong(),
        "kind" to kind,
        "type" to type,
        "requestId" to requestId,
    )
}

data class RelayV2NormalizedCarrierFrame(
    val version: Int,
    val type: String,
    val requestId: String?,
) : RelayV2NormalizedMessage {
    override fun asFixtureMap(): Map<String, Any?> = linkedMapOf(
        "channel" to "carrier",
        "version" to version.toLong(),
        "type" to type,
        "requestId" to requestId,
    )
}

data class RelayV2NormalizedHttpsBody(
    val schema: RelayV2HttpsSchema,
) : RelayV2NormalizedMessage {
    override fun asFixtureMap(): Map<String, Any?> = linkedMapOf(
        "channel" to "https",
        "schema" to schema.wireName,
    )
}

data class RelayV2DecodedMessage(
    val frame: Map<String, Any?>,
    val normalized: RelayV2NormalizedMessage,
    val canonicalWire: String,
)

class RelayV2CodecException(
    val code: String,
    val failureClass: String,
) : IllegalArgumentException(
    if (code == "PROTOCOL_UNSUPPORTED") {
        "Relay v2 transport encoding is unsupported"
    } else {
        "Relay v2 frame is invalid"
    },
)

enum class RelayV2ClientDialect(val wireName: String) {
    V1("tw-relay.v1"),
    V2("tw-relay.v2"),
    ;

    companion object {
        fun fromWireName(value: String): RelayV2ClientDialect =
            entries.firstOrNull { it.wireName == value }
                ?: throw IllegalArgumentException("Unknown Relay dialect")
    }
}

sealed interface RelayV2DialectOutcome {
    fun asFixtureMap(): Map<String, Any?>
}

data class RelayV2DialectAccepted(
    val selectedDialect: RelayV2ClientDialect,
) : RelayV2DialectOutcome {
    override fun asFixtureMap(): Map<String, Any?> = linkedMapOf(
        "outcome" to "accept",
        "selectedDialect" to selectedDialect.wireName,
        "translation" to false,
        "fallback" to false,
    )
}

data class RelayV2DialectRejected(
    val errorCode: String,
) : RelayV2DialectOutcome {
    override fun asFixtureMap(): Map<String, Any?> = linkedMapOf(
        "outcome" to "reject",
        "errorCode" to errorCode,
        "fallback" to false,
    )
}
