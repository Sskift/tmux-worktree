package com.tmuxworktree.mobile.core.relay.v2.codec

internal fun validateRelayV2CarrierFrame(
    frame: RelayV2JsonObject,
): RelayV2NormalizedCarrierFrame {
    val type = jsonString(required(frame, "type"), maxBytes = 128)
    when (type) {
        "enrollment.create" -> validateEnrollmentCreate(frame)
        "enrollment.created" -> validateEnrollmentCreated(frame)
        "grant.revoke" -> validateGrantRevoke(frame)
        "grant.revoked" -> validateGrantRevoked(frame)
        "host.reauthenticate" -> validateHostReauthenticate(frame)
        "host.reauthenticated" -> validateHostReauthenticated(frame)
        "host.auth_expiring" -> validateHostAuthExpiring(frame)
        "host.superseded" -> validateHostSuperseded(frame)
        "carrier.error" -> validateCarrierError(frame)
        "host.hello" -> validateHostHello(frame)
        "host.registered" -> validateHostRegistered(frame)
        "route.open" -> validateRouteOpen(frame)
        "route.opened" -> validateRouteOpened(frame)
        "route.rejected" -> validateRouteRejected(frame)
        "route.data" -> validateRouteData(frame)
        "route.unbind" -> validateRouteUnbind(frame)
        "route.unbound" -> validateRouteUnbound(frame)
        "route.close" -> validateRouteClose(frame)
        else -> schemaFailure("unknown-message-type")
    }
    return RelayV2NormalizedCarrierFrame(
        version = 1,
        type = type,
        requestId = frame["requestId"] as? String,
    )
}

private fun carrierRoot(
    frame: RelayV2JsonObject,
    type: String,
    requiredFields: List<String>,
    optionalFields: List<String> = emptyList(),
) {
    exactKeys(
        frame,
        listOf("carrierVersion", "type") + requiredFields,
        optionalFields,
    )
    jsonLiteral(required(frame, "carrierVersion"), 1L)
    jsonLiteral(required(frame, "type"), type)
    listOf("requestId", "connectorId", "routeId", "routeFence").forEach { name ->
        if (frame.containsKey(name)) jsonId(frame[name])
    }
}

private fun validateEnrollmentCreate(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "enrollment.create",
        listOf("requestId", "connectorId", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("expiresInMs", "deviceLabel"))
    jsonInteger(required(payload, "expiresInMs"), minimum = 1, maximum = 300_000)
    jsonNullable(payload["deviceLabel"]) {
        jsonString(it, allowOuterWhitespace = true, maxBytes = 128)
    }
}

private fun validateEnrollmentCreated(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "enrollment.created",
        listOf("requestId", "connectorId", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "deduplicated",
            "enrollmentId",
            "enrollmentCode",
            "hostId",
            "issuerUrl",
            "relayUrl",
            "expiresAtMs",
        ),
    )
    jsonBoolean(required(payload, "deduplicated"))
    jsonId(required(payload, "enrollmentId"))
    jsonSecret(required(payload, "enrollmentCode"))
    jsonId(required(payload, "hostId"))
    jsonHttpsUrl(required(payload, "issuerUrl"))
    jsonWssUrl(required(payload, "relayUrl"))
    jsonInteger(required(payload, "expiresAtMs"))
}

private fun validateGrantRevoke(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "grant.revoke",
        listOf("requestId", "connectorId", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("grantId", "reason"))
    jsonId(required(payload, "grantId"))
    jsonLiteral(required(payload, "reason"), "user_revoked")
}

private fun validateGrantRevoked(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "grant.revoked",
        listOf("requestId", "connectorId", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("grantId", "revokedAtMs", "alreadyRevoked"))
    jsonId(required(payload, "grantId"))
    jsonInteger(required(payload, "revokedAtMs"))
    jsonBoolean(required(payload, "alreadyRevoked"))
}

private fun validateHostReauthenticate(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "host.reauthenticate",
        listOf("requestId", "connectorId", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("accessToken"))
    jsonSecret(required(payload, "accessToken"))
}

private fun validateHostReauthenticated(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "host.reauthenticated",
        listOf("requestId", "connectorId", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("grantId", "jti", "expiresAtMs", "deduplicated"))
    jsonId(required(payload, "grantId"))
    jsonId(required(payload, "jti"))
    jsonInteger(required(payload, "expiresAtMs"))
    jsonBoolean(required(payload, "deduplicated"))
}

private fun validateHostAuthExpiring(frame: RelayV2JsonObject) {
    carrierRoot(frame, "host.auth_expiring", listOf("connectorId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("grantId", "expiresAtMs", "refreshRecommendedAtMs"))
    jsonId(required(payload, "grantId"))
    jsonInteger(required(payload, "expiresAtMs"))
    jsonInteger(required(payload, "refreshRecommendedAtMs"))
}

private fun validateHostSuperseded(frame: RelayV2JsonObject) {
    carrierRoot(frame, "host.superseded", listOf("connectorId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "hostId",
            "losingConnectorId",
            "winningConnectorId",
            "losingHostInstanceId",
            "winningHostInstanceId",
            "reason",
        ),
    )
    listOf(
        "hostId",
        "losingConnectorId",
        "winningConnectorId",
        "losingHostInstanceId",
        "winningHostInstanceId",
    ).forEach { jsonId(required(payload, it)) }
    jsonLiteral(required(payload, "reason"), "new_authenticated_connector")
}

private fun validateCarrierError(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "carrier.error",
        listOf("connectorId", "payload", "error"),
        listOf("requestId", "routeId", "routeFence"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("failedType"))
    jsonString(required(payload, "failedType"), maxBytes = 128)
    validateStructuredError(required(frame, "error"))
}

private fun validateHostHello(frame: RelayV2JsonObject) {
    carrierRoot(frame, "host.hello", listOf("requestId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "hostId",
            "hostEpoch",
            "hostInstanceId",
            "clientDialects",
            "capabilities",
            "limits",
        ),
    )
    jsonId(required(payload, "hostId"))
    jsonId(required(payload, "hostEpoch"))
    jsonId(required(payload, "hostInstanceId"))
    val dialects = jsonArray(
        required(payload, "clientDialects"),
        maximum = 2,
        minimum = 1,
    ) {
        jsonOneOf(it, setOf("tw-relay.v1", "tw-relay.v2"))
    }.map { it as String }
    if (dialects.toSet().size != dialects.size) schemaFailure("schema-mismatch")
    jsonCapabilities(required(payload, "capabilities"))
    val limits = jsonObject(required(payload, "limits"))
    exactKeys(limits, listOf("maxFrameBytes", "terminalMaxFrameBytes"))
    jsonInteger(required(limits, "maxFrameBytes"))
    jsonInteger(required(limits, "terminalMaxFrameBytes"))
}

private fun validateHostRegistered(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "host.registered",
        listOf("requestId", "connectorId", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "brokerEpoch",
            "hostsRevision",
            "disposition",
            "supersededHostInstanceId",
            "limits",
        ),
    )
    jsonId(required(payload, "brokerEpoch"))
    jsonCounter(required(payload, "hostsRevision"))
    jsonOneOf(required(payload, "disposition"), setOf("connected", "replaced"))
    jsonNullable(payload["supersededHostInstanceId"]) { jsonId(it) }
    val limits = jsonObject(required(payload, "limits"))
    exactKeys(
        limits,
        listOf(
            "maxCarrierFrameBytes",
            "brokerCarrierBufferedBytes",
            "brokerCarrierLowWaterBytes",
        ),
    )
    limits.values.forEach { jsonInteger(it) }
}

private fun validateRouteOpen(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "route.open",
        listOf("requestId", "connectorId", "routeId", "routeFence", "payload"),
    )
    validateRouteIdentity(frame)
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("connectionId", "clientDialect", "authContext", "limits"))
    jsonId(required(payload, "connectionId"))
    jsonLiteral(required(payload, "clientDialect"), "tw-relay.v2")
    val auth = jsonObject(required(payload, "authContext"))
    exactKeys(
        auth,
        listOf(
            "scheme",
            "role",
            "hostId",
            "principalId",
            "grantId",
            "clientInstanceId",
            "jti",
            "kid",
            "expiresAtMs",
        ),
    )
    jsonLiteral(required(auth, "scheme"), "twcap2")
    jsonLiteral(required(auth, "role"), "client")
    listOf(
        "hostId",
        "principalId",
        "grantId",
        "clientInstanceId",
        "jti",
        "kid",
    ).forEach { jsonId(required(auth, it)) }
    jsonInteger(required(auth, "expiresAtMs"))
    val limits = jsonObject(required(payload, "limits"))
    exactKeys(limits, listOf("maxFrameBytes"))
    jsonInteger(required(limits, "maxFrameBytes"))
}

private fun validateRouteOpened(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "route.opened",
        listOf("requestId", "connectorId", "routeId", "routeFence", "payload"),
    )
    validateRouteIdentity(frame)
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("acceptedAtMs", "maxFrameBytes"))
    jsonInteger(required(payload, "acceptedAtMs"))
    jsonInteger(required(payload, "maxFrameBytes"))
}

private fun validateRouteRejected(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "route.rejected",
        listOf(
            "requestId",
            "connectorId",
            "routeId",
            "routeFence",
            "payload",
            "error",
        ),
    )
    validateRouteIdentity(frame)
    jsonNull(required(frame, "payload"))
    validateStructuredError(required(frame, "error"))
}

private fun validateRouteData(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "route.data",
        listOf(
            "connectorId",
            "routeId",
            "routeFence",
            "direction",
            "seq",
            "payload",
        ),
    )
    validateRouteIdentity(frame)
    jsonOneOf(required(frame, "direction"), setOf("client_to_host", "host_to_client"))
    jsonCounter(required(frame, "seq"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("opcode", "encoding", "data"))
    jsonLiteral(required(payload, "opcode"), "text")
    jsonLiteral(required(payload, "encoding"), "base64")
    jsonCanonicalBase64(required(payload, "data"), maxDecodedBytes = 1_048_576)
}

private fun validateRouteUnbind(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "route.unbind",
        listOf("connectorId", "routeId", "routeFence", "payload"),
    )
    validateRouteIdentity(frame)
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("reason", "lastClientToHostSeq"))
    validateRouteUnbindReason(required(payload, "reason"))
    jsonCounter(required(payload, "lastClientToHostSeq"))
}

private fun validateRouteUnbound(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "route.unbound",
        listOf("connectorId", "routeId", "routeFence", "payload"),
    )
    validateRouteIdentity(frame)
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("reason", "lastClientToHostSeq", "lastHostToClientSeq"))
    validateRouteUnbindReason(required(payload, "reason"))
    jsonCounter(required(payload, "lastClientToHostSeq"))
    jsonCounter(required(payload, "lastHostToClientSeq"))
}

private fun validateRouteClose(frame: RelayV2JsonObject) {
    carrierRoot(
        frame,
        "route.close",
        listOf("connectorId", "routeId", "routeFence", "payload"),
    )
    validateRouteIdentity(frame)
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("closeCode", "reason", "error"))
    jsonInteger(required(payload, "closeCode"), minimum = 1_000, maximum = 4_999)
    jsonOneOf(
        required(payload, "reason"),
        setOf("slow_consumer", "protocol_error", "host_shutdown"),
    )
    validateStructuredError(required(payload, "error"))
}

private fun validateRouteIdentity(frame: RelayV2JsonObject) {
    jsonId(required(frame, "connectorId"))
    jsonId(required(frame, "routeId"))
    jsonId(required(frame, "routeFence"))
}

private fun validateRouteUnbindReason(value: Any?) {
    jsonOneOf(
        value,
        setOf(
            "client_closed",
            "client_replaced",
            "auth_expired",
            "auth_revoked",
            "slow_consumer",
            "protocol_error",
            "broker_shutdown",
        ),
    )
}
