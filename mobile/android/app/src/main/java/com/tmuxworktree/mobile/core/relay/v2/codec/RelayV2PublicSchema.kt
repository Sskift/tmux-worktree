package com.tmuxworktree.mobile.core.relay.v2.codec

internal fun validateRelayV2PublicFrame(
    frame: RelayV2JsonObject,
): RelayV2NormalizedPublicFrame {
    val type = jsonString(required(frame, "type"), maxBytes = 128)
    when (type) {
        "relay.welcome" -> validateRelayWelcomeFrame(frame)
        "relay.unavailable" -> validateRelayUnavailableFrame(frame)
        "client.hello" -> validateClientHelloFrame(frame)
        "host.welcome" -> validateHostWelcomeFrame(frame)
        "error" -> validatePublicErrorFrame(frame)
        "auth.expiring" -> validateAuthExpiringFrame(frame)
        "host.presence" -> validateHostPresenceFrame(frame)
        "hosts.snapshot.get" -> validateHostsSnapshotGetFrame(frame)
        "hosts.snapshot" -> validateHostsSnapshotFrame(frame)
        "command.execute" -> validateCommandExecuteFrame(frame)
        "command.status" -> validateCommandStatusFrame(frame)
        "command.result" -> validateCommandResultFrame(frame)
        "command.query" -> validateCommandQueryFrame(frame)
        "command.statuses" -> validateCommandStatusesFrame(frame)
        "scopes.snapshot.get" -> validateScopesSnapshotGetFrame(frame)
        "scopes.snapshot" -> validateScopesSnapshotFrame(frame)
        "sessions.snapshot.get" -> validateSessionsSnapshotGetFrame(frame)
        "sessions.snapshot" -> validateSessionsSnapshotFrame(frame)
        "state.snapshot.get" -> validateStateSnapshotGetFrame(frame)
        "state.snapshot.chunk" -> validateStateSnapshotChunkFrame(frame)
        "state.snapshot.release" -> validateStateSnapshotReleaseFrame(frame)
        "state.snapshot.released" -> validateStateSnapshotReleasedFrame(frame)
        "scopes.changed", "sessions.changed" -> validateStateChangedFrame(frame, type)
        "terminal.open" -> validateTerminalOpenFrame(frame)
        "terminal.opened" -> validateTerminalOpenedFrame(frame)
        "terminal.output" -> validateTerminalOutputFrame(frame)
        "terminal.output_ack" -> validateTerminalOutputAckFrame(frame)
        "terminal.replay_request" -> validateTerminalReplayRequestFrame(frame)
        "terminal.replay_started" -> validateTerminalReplayStartedFrame(frame)
        "terminal.reset_required" -> validateTerminalResetRequiredFrame(frame)
        "terminal.input" -> validateTerminalInputFrame(frame)
        "terminal.input_ack" -> validateTerminalInputAckFrame(frame)
        "terminal.input_error" -> validateTerminalInputErrorFrame(frame)
        "terminal.resize" -> validateTerminalResizeFrame(frame)
        "terminal.resize_ack" -> validateTerminalResizeAckFrame(frame)
        "terminal.resize_error" -> validateTerminalResizeErrorFrame(frame)
        "terminal.close" -> validateTerminalCloseFrame(frame)
        "terminal.closed" -> validateTerminalClosedFrame(frame)
        else -> schemaFailure("unknown-message-type")
    }
    return RelayV2NormalizedPublicFrame(
        version = 2,
        kind = frame["kind"] as String,
        type = type,
        requestId = frame["requestId"] as? String,
    )
}

private fun publicRoot(
    frame: RelayV2JsonObject,
    kind: String,
    type: String,
    requiredFields: List<String>,
    optionalFields: List<String> = emptyList(),
) {
    exactKeys(
        frame,
        listOf("protocolVersion", "kind", "type") + requiredFields,
        optionalFields,
    )
    jsonLiteral(required(frame, "protocolVersion"), 2L)
    jsonLiteral(required(frame, "kind"), kind)
    jsonLiteral(required(frame, "type"), type)
    validateTopLevelIdentifiers(frame)
}

private fun validateRelayWelcomeFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "relay.welcome", listOf("payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "selectedVersion",
            "connectionId",
            "brokerEpoch",
            "principalId",
            "capabilities",
            "limits",
        ),
    )
    jsonLiteral(required(payload, "selectedVersion"), 2L)
    jsonId(required(payload, "connectionId"))
    jsonId(required(payload, "brokerEpoch"))
    jsonId(required(payload, "principalId"))
    jsonCapabilities(required(payload, "capabilities"))
    val limits = jsonObject(required(payload, "limits"))
    exactKeys(
        limits,
        listOf(
            "maxFrameBytes",
            "maxCarrierFrameBytes",
            "brokerRouteBufferedBytesPerDirection",
            "brokerRouteLowWaterBytesPerDirection",
            "brokerCarrierBufferedBytes",
            "brokerCarrierLowWaterBytes",
            "maxQueuedRouteFrames",
            "maxInFlightRequestsPerRoute",
        ),
    )
    limits.values.forEach { jsonInteger(it) }
}

private fun validateRelayUnavailableFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "relay.unavailable", listOf("hostId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("error"))
    validateStructuredError(required(payload, "error"))
}

private fun validateClientHelloFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "client.hello",
        listOf("requestId", "hostId", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf("clientInstanceId", "capabilities", "requiredCapabilities", "resume"),
    )
    jsonId(required(payload, "clientInstanceId"))
    jsonCapabilities(required(payload, "capabilities"))
    jsonCapabilities(required(payload, "requiredCapabilities"))
    if (payload["resume"] != null) {
        val resume = jsonObject(payload["resume"])
        exactKeys(resume, listOf("hostEpoch", "lastEventSeq"))
        jsonId(required(resume, "hostEpoch"))
        jsonCounter(required(resume, "lastEventSeq"))
    }
}

private fun validateHostWelcomeFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "host.welcome",
        listOf(
            "requestId",
            "hostId",
            "hostEpoch",
            "hostInstanceId",
            "payload",
        ),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "selectedVersion",
            "capabilities",
            "eventSeq",
            "resumeDisposition",
            "resumeReason",
            "commandDedupeWindow",
            "limits",
        ),
    )
    jsonLiteral(required(payload, "selectedVersion"), 2L)
    jsonCapabilities(required(payload, "capabilities"))
    jsonCounter(required(payload, "eventSeq"))
    val disposition = jsonOneOf(
        required(payload, "resumeDisposition"),
        setOf("caught_up", "snapshot_required"),
    )
    val reason = jsonOneOf(
        required(payload, "resumeReason"),
        setOf("matched", "fresh", "host_epoch_changed", "cursor_behind"),
    )
    if (
        (disposition == "caught_up" && reason != "matched") ||
        (disposition == "snapshot_required" && reason == "matched")
    ) {
        schemaFailure("schema-mismatch")
    }
    val window = jsonObject(required(payload, "commandDedupeWindow"))
    exactKeys(window, listOf("windowId", "windowSeq", "acceptUntilMs", "queryUntilMs"))
    jsonId(required(window, "windowId"))
    jsonCounter(required(window, "windowSeq"))
    jsonInteger(required(window, "acceptUntilMs"))
    jsonInteger(required(window, "queryUntilMs"))
    val limits = jsonObject(required(payload, "limits"))
    exactKeys(
        limits,
        listOf(
            "commandResultRetentionMs",
            "commandDedupeRetentionMs",
            "maxCommandQueryIds",
            "stateSnapshotChunkBytes",
            "stateSnapshotChunkRecords",
            "stateSnapshotMaxBytes",
            "stateSnapshotMaxRecords",
            "stateSnapshotIdleLeaseMs",
            "stateSnapshotMaxLifetimeMs",
            "stateSnapshotMaxPinnedPerPrincipal",
            "stateSnapshotMaxPinnedPerHost",
            "stateSnapshotPinnedBytesPerHost",
            "stateSnapshotPinnedMetadataBytesPerHost",
            "stateSnapshotChunkMaxJsonKeys",
            "stateSnapshotChunkMaxJsonNodes",
            "terminalReplayBytesPerStream",
            "terminalReplayBytesPerHost",
            "terminalDetachedLeaseMs",
            "terminalControlDedupeRetentionMs",
            "terminalMaxUnackedBytes",
            "terminalMaxFrameBytes",
            "terminalInputDedupeEntriesPerStream",
            "terminalResizeDedupeEntriesPerStream",
            "terminalMaxStreamsPerHost",
            "terminalControlRecordsPerHost",
            "brokerRouteBufferedBytesPerDirection",
            "brokerRouteLowWaterBytesPerDirection",
        ),
    )
    limits.values.forEach { jsonInteger(it) }
}

private fun validatePublicErrorFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "error",
        listOf("requestId", "payload", "error"),
        listOf("commandId", "hostId", "hostEpoch", "scopeId", "sessionId", "streamId"),
    )
    jsonNull(required(frame, "payload"))
    validateStructuredError(required(frame, "error"))
}

private fun validateAuthExpiringFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "auth.expiring", listOf("payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("grantId", "expiresAtMs", "refreshRecommendedAtMs"))
    jsonId(required(payload, "grantId"))
    jsonInteger(required(payload, "expiresAtMs"))
    jsonInteger(required(payload, "refreshRecommendedAtMs"))
}

private fun validateHostPresenceFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "host.presence", listOf("hostId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "brokerEpoch",
            "revision",
            "state",
            "reason",
            "hostEpoch",
            "hostInstanceId",
            "previousHostInstanceId",
            "observedAtMs",
        ),
    )
    jsonId(required(payload, "brokerEpoch"))
    jsonCounter(required(payload, "revision"))
    jsonOneOf(required(payload, "state"), setOf("online", "offline"))
    jsonOneOf(
        required(payload, "reason"),
        setOf("connected", "reconnected", "superseded", "disconnected"),
    )
    jsonNullable(payload["hostEpoch"]) { jsonId(it) }
    jsonNullable(payload["hostInstanceId"]) { jsonId(it) }
    jsonNullable(payload["previousHostInstanceId"]) { jsonId(it) }
    jsonInteger(required(payload, "observedAtMs"))
}

private fun validateHostsSnapshotGetFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "request", "hosts.snapshot.get", listOf("requestId", "payload"))
    exactKeys(jsonObject(required(frame, "payload")), emptyList())
}

private fun validateHostsSnapshotFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "response", "hosts.snapshot", listOf("requestId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("brokerEpoch", "revision", "items"))
    jsonId(required(payload, "brokerEpoch"))
    jsonCounter(required(payload, "revision"))
    jsonArray(required(payload, "items"), maximum = 256) { entry ->
        val item = jsonObject(entry)
        exactKeys(
            item,
            listOf(
                "hostId",
                "state",
                "hostEpoch",
                "hostInstanceId",
                "clientDialects",
                "capabilities",
                "observedAtMs",
            ),
        )
        jsonId(required(item, "hostId"))
        jsonOneOf(required(item, "state"), setOf("online", "offline"))
        jsonNullable(item["hostEpoch"]) { jsonId(it) }
        jsonNullable(item["hostInstanceId"]) { jsonId(it) }
        jsonArray(required(item, "clientDialects"), maximum = 2) {
            jsonOneOf(it, setOf("tw-relay.v1", "tw-relay.v2"))
        }
        jsonCapabilities(required(item, "capabilities"))
        jsonInteger(required(item, "observedAtMs"))
    }
}

private fun validateCommandExecuteFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "command.execute",
        listOf(
            "requestId",
            "commandId",
            "hostId",
            "expectedHostEpoch",
            "scopeId",
            "payload",
        ),
        listOf("sessionId"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("dedupeWindowId", "operation", "arguments"))
    jsonId(required(payload, "dedupeWindowId"))
    val operation = jsonOneOf(
        required(payload, "operation"),
        setOf("create_worktree", "create_terminal", "send_agent_message", "kill_session"),
    )
    val needsSession = operation == "send_agent_message" || operation == "kill_session"
    if (needsSession != frame.containsKey("sessionId")) schemaFailure("schema-mismatch")
    validateCommandArguments(operation, required(payload, "arguments"))
}

private fun validateCommandArguments(operation: String, value: Any?) {
    val arguments = jsonObject(value)
    when (operation) {
        "create_worktree" -> {
            exactKeys(
                arguments,
                listOf("aiCommand"),
                listOf("project", "path", "name", "branch"),
            )
            if (!arguments.containsKey("project") && !arguments.containsKey("path")) {
                schemaFailure("invalid-argument")
            }
            if (arguments.containsKey("project")) {
                jsonString(arguments["project"], maxBytes = 128)
            }
            if (arguments.containsKey("path")) {
                jsonString(
                    arguments["path"],
                    allowOuterWhitespace = true,
                    maxBytes = 4_096,
                )
            }
            if (arguments.containsKey("name")) {
                jsonString(arguments["name"], maxBytes = 128, maxCharacters = 20)
            }
            if (arguments.containsKey("branch")) {
                jsonString(arguments["branch"], maxBytes = 255)
            }
            jsonString(
                required(arguments, "aiCommand"),
                allowOuterWhitespace = true,
                maxBytes = 4_096,
            )
        }
        "create_terminal" -> {
            exactKeys(arguments, listOf("cwd"), listOf("label"))
            jsonString(
                required(arguments, "cwd"),
                allowOuterWhitespace = true,
                maxBytes = 4_096,
            )
            if (arguments.containsKey("label")) {
                jsonString(
                    arguments["label"],
                    allowOuterWhitespace = true,
                    maxBytes = 128,
                )
            }
        }
        "send_agent_message" -> {
            exactKeys(arguments, listOf("pane", "message", "submit"))
            jsonInteger(required(arguments, "pane"), maximum = 65_535)
            val message = jsonString(
                required(arguments, "message"),
                allowEmpty = true,
                allowOuterWhitespace = true,
                maxBytes = 65_536,
            )
            val submit = jsonBoolean(required(arguments, "submit"))
            if (message.isEmpty() && !submit) schemaFailure("invalid-argument")
        }
        "kill_session" -> exactKeys(arguments, emptyList())
        else -> schemaFailure("schema-mismatch")
    }
}

private fun validateCommandResultValue(value: Any?) {
    val result = jsonObject(value)
    when {
        result.containsKey("session") -> {
            exactKeys(result, listOf("session"))
            validateSession(required(result, "session"))
        }
        result.containsKey("messageUtf8Bytes") -> {
            exactKeys(result, listOf("pane", "submit", "messageUtf8Bytes"))
            jsonInteger(required(result, "pane"), maximum = 65_535)
            jsonBoolean(required(result, "submit"))
            jsonInteger(required(result, "messageUtf8Bytes"), maximum = 65_536)
        }
        result.containsKey("terminated") -> {
            exactKeys(result, listOf("sessionId", "terminated"))
            jsonId(required(result, "sessionId"))
            jsonLiteral(required(result, "terminated"), true)
        }
        else -> schemaFailure("schema-mismatch")
    }
}

private fun validateCommandStatusFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "command.status",
        listOf(
            "requestId",
            "commandId",
            "hostId",
            "hostEpoch",
            "scopeId",
            "payload",
            "error",
        ),
        listOf("sessionId"),
    )
    validateCommandStatusPayload(required(frame, "payload"), required(frame, "error"))
}

private fun validateCommandStatusPayload(value: Any?, topLevelError: Any?) {
    val payload = jsonObject(value)
    exactKeys(
        payload,
        listOf(
            "dedupeWindowId",
            "state",
            "deduplicated",
            "updatedAtMs",
            "dedupeUntilMs",
            "result",
        ),
    )
    jsonId(required(payload, "dedupeWindowId"))
    val state = jsonOneOf(
        required(payload, "state"),
        setOf("accepted", "running", "succeeded", "failed", "in_doubt"),
    )
    jsonBoolean(required(payload, "deduplicated"))
    jsonInteger(required(payload, "updatedAtMs"))
    jsonNullable(payload["dedupeUntilMs"]) { jsonInteger(it) }
    when (state) {
        "accepted", "running" -> {
            jsonNull(required(payload, "result"))
            if (topLevelError != null) schemaFailure("schema-mismatch")
        }
        "succeeded" -> {
            validateCommandResultValue(required(payload, "result"))
            if (topLevelError != null) schemaFailure("schema-mismatch")
        }
        else -> {
            jsonNull(required(payload, "result"))
            if (topLevelError == null) schemaFailure("schema-mismatch")
            validateStructuredError(topLevelError)
            val error = jsonObject(topLevelError)
            if (
                state == "in_doubt" &&
                (
                    error["code"] != "COMMAND_IN_DOUBT" ||
                    error["commandDisposition"] != "in_doubt"
                )
            ) {
                schemaFailure("schema-mismatch")
            }
            if (
                state == "failed" &&
                (
                    error["retryable"] != false ||
                    error["commandDisposition"] != "completed"
                )
            ) {
                schemaFailure("schema-mismatch")
            }
        }
    }
}

private fun validateCommandResultFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "event",
        "command.result",
        listOf("commandId", "hostId", "hostEpoch", "scopeId", "payload", "error"),
        listOf("sessionId"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("dedupeWindowId", "state", "updatedAtMs", "result"))
    jsonId(required(payload, "dedupeWindowId"))
    val state = jsonOneOf(
        required(payload, "state"),
        setOf("succeeded", "failed", "in_doubt"),
    )
    jsonInteger(required(payload, "updatedAtMs"))
    val error = required(frame, "error")
    if (state == "succeeded") {
        validateCommandResultValue(required(payload, "result"))
        if (error != null) schemaFailure("schema-mismatch")
    } else {
        jsonNull(required(payload, "result"))
        if (error == null) schemaFailure("schema-mismatch")
        validateStructuredError(error)
        val structured = jsonObject(error)
        if (
            state == "in_doubt" &&
            (
                structured["code"] != "COMMAND_IN_DOUBT" ||
                structured["commandDisposition"] != "in_doubt"
            )
        ) {
            schemaFailure("schema-mismatch")
        }
        if (
            state == "failed" &&
            (
                structured["retryable"] != false ||
                structured["commandDisposition"] != "completed"
            )
        ) {
            schemaFailure("schema-mismatch")
        }
    }
}

private fun validateCommandQueryFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "command.query",
        listOf("requestId", "hostId", "expectedHostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("items"))
    jsonArray(required(payload, "items"), maximum = 32, minimum = 1) { value ->
        val item = jsonObject(value)
        exactKeys(item, listOf("commandId", "dedupeWindowId"))
        jsonId(required(item, "commandId"))
        jsonId(required(item, "dedupeWindowId"))
    }
}

private fun validateCommandStatusesFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "command.statuses",
        listOf("requestId", "hostId", "hostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("dedupeWatermark", "items"))
    val watermark = jsonObject(required(payload, "dedupeWatermark"))
    exactKeys(
        watermark,
        listOf("oldestQueryableWindowSeq", "newestIssuedWindowSeq", "observedAtMs"),
    )
    jsonCounter(required(watermark, "oldestQueryableWindowSeq"))
    jsonCounter(required(watermark, "newestIssuedWindowSeq"))
    jsonInteger(required(watermark, "observedAtMs"))
    jsonArray(required(payload, "items"), maximum = 32) {
        validateCommandStatusesItem(it)
    }
}

private fun validateCommandStatusesItem(value: Any?) {
    val item = jsonObject(value)
    exactKeys(
        item,
        listOf(
            "commandId",
            "dedupeWindowId",
            "state",
            "updatedAtMs",
            "dedupeUntilMs",
            "retryable",
            "retryAfterMs",
            "reissueRequired",
            "result",
            "error",
        ),
    )
    jsonId(required(item, "commandId"))
    jsonId(required(item, "dedupeWindowId"))
    val state = jsonOneOf(
        required(item, "state"),
        setOf(
            "not_accepted",
            "accepted",
            "running",
            "succeeded",
            "failed",
            "in_doubt",
            "expired",
            "unknown",
        ),
    )
    jsonInteger(required(item, "updatedAtMs"))
    val dedupeUntil = item["dedupeUntilMs"]?.also { jsonInteger(it) }
    val retryable = jsonBoolean(required(item, "retryable"))
    val retryAfter = item["retryAfterMs"]?.also { jsonInteger(it) }
    val reissueRequired = jsonBoolean(required(item, "reissueRequired"))
    val result = required(item, "result")
    val error = required(item, "error")
    when (state) {
        "accepted", "running" -> {
            if (
                dedupeUntil != null ||
                retryable ||
                retryAfter != null ||
                reissueRequired ||
                result != null ||
                error != null
            ) {
                schemaFailure("schema-mismatch")
            }
        }
        "succeeded" -> {
            if (
                dedupeUntil == null ||
                retryable ||
                retryAfter != null ||
                reissueRequired ||
                error != null
            ) {
                schemaFailure("schema-mismatch")
            }
            validateCommandResultValue(result)
        }
        else -> validateCommandStatusesFailureState(
            state,
            dedupeUntil,
            retryable,
            retryAfter,
            reissueRequired,
            result,
            error,
        )
    }
}

private fun validateCommandStatusesFailureState(
    state: String,
    dedupeUntil: Any?,
    retryable: Boolean,
    retryAfter: Any?,
    reissueRequired: Boolean,
    result: Any?,
    errorValue: Any?,
) {
    if (result != null || errorValue == null) schemaFailure("schema-mismatch")
    validateStructuredError(errorValue)
    val error = jsonObject(errorValue)
    val code = error["code"]
    val disposition = error["commandDisposition"]
    when (state) {
        "not_accepted" -> if (
            dedupeUntil != null ||
            code != (if (reissueRequired) "COMMAND_WINDOW_EXPIRED" else "COMMAND_NOT_ACCEPTED") ||
            disposition != "not_accepted" ||
            retryable == reissueRequired ||
            (retryable && retryAfter == null) ||
            (!retryable && retryAfter != null)
        ) {
            schemaFailure("schema-mismatch")
        }
        "failed" -> if (
            dedupeUntil == null ||
            retryable ||
            retryAfter != null ||
            reissueRequired ||
            disposition != "completed"
        ) {
            schemaFailure("schema-mismatch")
        }
        "in_doubt" -> if (
            dedupeUntil == null ||
            retryable ||
            retryAfter != null ||
            reissueRequired ||
            code != "COMMAND_IN_DOUBT" ||
            disposition != "in_doubt"
        ) {
            schemaFailure("schema-mismatch")
        }
        "expired" -> if (
            dedupeUntil == null ||
            retryable ||
            retryAfter != null ||
            reissueRequired ||
            code != "COMMAND_RESULT_EXPIRED"
        ) {
            schemaFailure("schema-mismatch")
        }
        "unknown" -> if (
            dedupeUntil != null ||
            retryable ||
            retryAfter != null ||
            reissueRequired ||
            code != "COMMAND_STATUS_UNKNOWN" ||
            disposition != "in_doubt"
        ) {
            schemaFailure("schema-mismatch")
        }
    }
}

private fun validateScopesSnapshotGetFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "scopes.snapshot.get",
        listOf("requestId", "hostId", "expectedHostEpoch", "payload"),
    )
    exactKeys(jsonObject(required(frame, "payload")), emptyList())
}

private fun validateScopesSnapshotFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "scopes.snapshot",
        listOf("requestId", "hostId", "hostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf("coverageComplete", "revision", "throughEventSeq", "items"),
    )
    jsonBoolean(required(payload, "coverageComplete"))
    jsonCounter(required(payload, "revision"))
    jsonNull(required(payload, "throughEventSeq"))
    jsonArray(required(payload, "items"), maximum = 256) { validateScope(it) }
}

private fun validateSessionsSnapshotGetFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "sessions.snapshot.get",
        listOf("requestId", "hostId", "expectedHostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("scopeIds"))
    if (payload["scopeIds"] != null) {
        jsonArray(payload["scopeIds"], maximum = 100, minimum = 1) { jsonId(it) }
    }
}

private fun validateSessionsSnapshotFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "sessions.snapshot",
        listOf("requestId", "hostId", "hostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("coverageComplete", "throughEventSeq", "scopes"))
    jsonBoolean(required(payload, "coverageComplete"))
    jsonNull(required(payload, "throughEventSeq"))
    jsonArray(required(payload, "scopes"), maximum = 100) {
        validateSessionsSnapshotScope(it)
    }
}

private fun validateSessionsSnapshotScope(value: Any?) {
    val scope = jsonObject(value)
    exactKeys(scope, listOf("scopeId", "revision", "completeness", "items", "error"))
    jsonId(required(scope, "scopeId"))
    jsonCounter(required(scope, "revision"))
    val completeness = jsonOneOf(
        required(scope, "completeness"),
        setOf("complete", "partial"),
    )
    jsonArray(required(scope, "items"), maximum = 256) { validateSession(it) }
    if (completeness == "complete") {
        jsonNull(required(scope, "error"))
    } else {
        validateStructuredError(required(scope, "error"))
    }
}

private fun validateStateSnapshotGetFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "state.snapshot.get",
        listOf("requestId", "hostId", "expectedHostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf("snapshotRequestId", "snapshotId", "cursor", "nextChunkIndex"),
    )
    jsonId(required(payload, "snapshotRequestId"))
    jsonNullable(payload["snapshotId"]) { jsonId(it) }
    jsonNullable(payload["cursor"]) { jsonCursor(it) }
    val nextChunkIndex = jsonInteger(required(payload, "nextChunkIndex"))
    val first = payload["snapshotId"] == null && payload["cursor"] == null
    if (first != (nextChunkIndex == 0L)) schemaFailure("schema-mismatch")
    if ((payload["snapshotId"] == null) != (payload["cursor"] == null)) {
        schemaFailure("schema-mismatch")
    }
}

private fun validateStateSnapshotChunkFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "state.snapshot.chunk",
        listOf("requestId", "hostId", "hostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "coverageComplete",
            "snapshotRequestId",
            "snapshotId",
            "snapshotCreatedAtMs",
            "snapshotLeaseExpiresAtMs",
            "snapshotAbsoluteExpiresAtMs",
            "chunkIndex",
            "isLast",
            "nextCursor",
            "throughEventSeq",
            "scopesRevision",
            "totalRecords",
            "totalCanonicalBytes",
            "cutDigest",
            "records",
        ),
    )
    jsonLiteral(required(payload, "coverageComplete"), true)
    jsonId(required(payload, "snapshotRequestId"))
    jsonId(required(payload, "snapshotId"))
    jsonInteger(required(payload, "snapshotCreatedAtMs"))
    jsonInteger(required(payload, "snapshotLeaseExpiresAtMs"))
    jsonInteger(required(payload, "snapshotAbsoluteExpiresAtMs"))
    jsonInteger(required(payload, "chunkIndex"))
    val isLast = jsonBoolean(required(payload, "isLast"))
    jsonNullable(payload["nextCursor"]) { jsonCursor(it) }
    if (isLast == (payload["nextCursor"] != null)) schemaFailure("schema-mismatch")
    jsonCounter(required(payload, "throughEventSeq"))
    jsonCounter(required(payload, "scopesRevision"))
    jsonInteger(required(payload, "totalRecords"), maximum = 100_000)
    jsonInteger(required(payload, "totalCanonicalBytes"), maximum = 268_435_456)
    jsonCanonicalBase64Url(required(payload, "cutDigest"), decodedBytes = 32)
    jsonArray(required(payload, "records"), maximum = 256) {
        validateStateSnapshotRecord(it)
    }
}

private fun validateStateSnapshotRecord(value: Any?) {
    val record = jsonObject(value)
    when (
        val recordType = jsonOneOf(
            required(record, "recordType"),
            setOf("scope", "sessions_scope", "session"),
        )
    ) {
        "scope" -> {
            exactKeys(record, listOf("recordType", "item"))
            validateScope(required(record, "item"))
        }
        "sessions_scope" -> {
            exactKeys(
                record,
                listOf("recordType", "scopeId", "revision", "completeness"),
            )
            jsonId(required(record, "scopeId"))
            jsonCounter(required(record, "revision"))
            jsonLiteral(required(record, "completeness"), "complete")
        }
        "session" -> {
            exactKeys(record, listOf("recordType", "scopeId", "item"))
            jsonId(required(record, "scopeId"))
            validateSession(required(record, "item"))
        }
        else -> error("unreachable record type " + recordType)
    }
}

private fun validateStateSnapshotReleaseFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "state.snapshot.release",
        listOf("requestId", "hostId", "expectedHostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("snapshotRequestId", "snapshotId", "reason"))
    jsonId(required(payload, "snapshotRequestId"))
    jsonId(required(payload, "snapshotId"))
    jsonOneOf(required(payload, "reason"), setOf("completed", "abandoned"))
}

private fun validateStateSnapshotReleasedFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "state.snapshot.released",
        listOf("requestId", "hostId", "hostEpoch", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "snapshotRequestId",
            "snapshotId",
            "released",
            "alreadyReleased",
            "releasedAtMs",
        ),
    )
    jsonId(required(payload, "snapshotRequestId"))
    jsonId(required(payload, "snapshotId"))
    jsonBoolean(required(payload, "released"))
    jsonBoolean(required(payload, "alreadyReleased"))
    jsonInteger(required(payload, "releasedAtMs"))
}

private fun validateStateChangedFrame(frame: RelayV2JsonObject, type: String) {
    publicRoot(
        frame,
        "event",
        type,
        listOf("hostId", "hostEpoch", "scopeId", "eventSeq", "payload"),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("dimension", "resourceKey", "resultingRevision", "change"))
    jsonCounter(required(payload, "resultingRevision"))
    val change = jsonObject(required(payload, "change"))
    if (type == "scopes.changed") {
        jsonLiteral(required(payload, "dimension"), "scopes")
        jsonLiteral(required(payload, "resourceKey"), "scopes")
        when (jsonOneOf(required(change, "op"), setOf("upsert", "delete"))) {
            "upsert" -> {
                exactKeys(change, listOf("op", "item"))
                validateScope(required(change, "item"))
            }
            "delete" -> {
                exactKeys(change, listOf("op", "scopeId"))
                jsonId(required(change, "scopeId"))
            }
        }
    } else {
        jsonLiteral(required(payload, "dimension"), "sessions")
        jsonId(required(payload, "resourceKey"))
        when (jsonOneOf(required(change, "op"), setOf("upsert", "delete"))) {
            "upsert" -> {
                exactKeys(change, listOf("op", "item"))
                validateSession(required(change, "item"))
            }
            "delete" -> {
                exactKeys(change, listOf("op", "sessionId"))
                jsonId(required(change, "sessionId"))
            }
        }
    }
}

private fun validateTerminalOpenFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "terminal.open",
        listOf(
            "requestId",
            "hostId",
            "expectedHostEpoch",
            "scopeId",
            "sessionId",
            "streamId",
            "payload",
        ),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf("openId", "pane", "cols", "rows", "mode"),
        listOf("resume"),
    )
    jsonId(required(payload, "openId"))
    jsonInteger(required(payload, "pane"), maximum = 65_535)
    jsonInteger(required(payload, "cols"), minimum = 1, maximum = 1_000)
    jsonInteger(required(payload, "rows"), minimum = 1, maximum = 500)
    val mode = jsonOneOf(required(payload, "mode"), setOf("new", "resume", "reset"))
    val hasResume = payload.containsKey("resume")
    if (mode == "new" && hasResume) schemaFailure("schema-mismatch")
    if (mode == "resume" && !hasResume) schemaFailure("missing-field")
    if (hasResume) validateTerminalResume(payload["resume"])
}

private fun validateTerminalResume(value: Any?) {
    val resume = jsonObject(value)
    exactKeys(resume, listOf("generation", "nextOffset", "resumeToken"))
    jsonId(required(resume, "generation"))
    jsonCounter(required(resume, "nextOffset"))
    jsonString(required(resume, "resumeToken"), maxBytes = 4_096)
}

private fun validateTerminalOpenedFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "terminal.opened",
        listOf(
            "requestId",
            "hostId",
            "hostEpoch",
            "scopeId",
            "sessionId",
            "streamId",
            "hostInstanceId",
            "payload",
        ),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf(
            "openId",
            "deduplicated",
            "generation",
            "resumeToken",
            "disposition",
            "replayFromOffset",
            "bufferStartOffset",
            "tailOffset",
            "maxUnackedBytes",
            "resetReason",
        ),
    )
    jsonId(required(payload, "openId"))
    jsonBoolean(required(payload, "deduplicated"))
    jsonId(required(payload, "generation"))
    jsonString(required(payload, "resumeToken"), maxBytes = 4_096)
    jsonOneOf(required(payload, "disposition"), setOf("new", "resumed", "reset"))
    jsonCounter(required(payload, "replayFromOffset"))
    jsonCounter(required(payload, "bufferStartOffset"))
    jsonCounter(required(payload, "tailOffset"))
    jsonInteger(required(payload, "maxUnackedBytes"))
    jsonNullable(payload["resetReason"]) {
        jsonOneOf(
            it,
            setOf(
                "generation_stale",
                "offset_expired",
                "stream_lost",
                "slow_consumer",
                "host_buffer_pressure",
            ),
        )
    }
}

private fun validateTerminalOutputFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "terminal.output", listOf("streamId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("generation", "offset", "encoding", "data"))
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "offset"))
    jsonLiteral(required(payload, "encoding"), "base64")
    jsonCanonicalBase64(required(payload, "data"), maxDecodedBytes = 65_536)
}

private fun validateTerminalOutputAckFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "terminal.output_ack", listOf("streamId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("generation", "nextOffset"))
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "nextOffset"))
}

private fun validateTerminalReplayRequestFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "terminal.replay_request",
        listOf(
            "requestId",
            "hostId",
            "expectedHostEpoch",
            "scopeId",
            "sessionId",
            "streamId",
            "payload",
        ),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("generation", "fromOffset"))
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "fromOffset"))
}

private fun validateTerminalReplayStartedFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "response",
        "terminal.replay_started",
        listOf(
            "requestId",
            "hostId",
            "hostEpoch",
            "scopeId",
            "sessionId",
            "streamId",
            "payload",
        ),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("generation", "fromOffset", "tailOffsetAtStart"))
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "fromOffset"))
    jsonCounter(required(payload, "tailOffsetAtStart"))
}

private fun validateTerminalResetRequiredFrame(frame: RelayV2JsonObject) {
    when (frame["kind"]) {
        "response" -> {
            publicRoot(
                frame,
                "response",
                "terminal.reset_required",
                listOf(
                    "requestId",
                    "hostId",
                    "hostEpoch",
                    "scopeId",
                    "sessionId",
                    "streamId",
                    "payload",
                ),
            )
            validateTerminalResetPayload(required(frame, "payload"), correlated = true)
        }
        "event" -> {
            publicRoot(
                frame,
                "event",
                "terminal.reset_required",
                listOf("streamId", "payload"),
            )
            validateTerminalResetPayload(required(frame, "payload"), correlated = false)
        }
        else -> schemaFailure("schema-mismatch")
    }
}

private fun validateTerminalResetPayload(value: Any?, correlated: Boolean) {
    val payload = jsonObject(value)
    exactKeys(
        payload,
        (if (correlated) listOf("origin") else emptyList()) +
            listOf(
                "generation",
                "reason",
                "requestedOffset",
                "bufferStartOffset",
                "tailOffset",
            ),
    )
    if (correlated) jsonOneOf(required(payload, "origin"), setOf("open", "replay"))
    jsonNullable(payload["generation"]) { jsonId(it) }
    jsonOneOf(
        required(payload, "reason"),
        setOf(
            "generation_stale",
            "offset_expired",
            "stream_lost",
            "slow_consumer",
            "host_buffer_pressure",
        ),
    )
    jsonNullable(payload["requestedOffset"]) { jsonCounter(it) }
    jsonNullable(payload["bufferStartOffset"]) { jsonCounter(it) }
    jsonNullable(payload["tailOffset"]) { jsonCounter(it) }
}

private fun validateTerminalInputFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "terminal.input", listOf("streamId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("generation", "inputSeq", "encoding", "data"))
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "inputSeq"))
    jsonLiteral(required(payload, "encoding"), "base64")
    jsonCanonicalBase64(required(payload, "data"), maxDecodedBytes = 65_536)
}

private fun validateTerminalInputAckFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "terminal.input_ack", listOf("streamId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("generation", "ackedThroughInputSeq"))
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "ackedThroughInputSeq"))
}

private fun validateTerminalInputErrorFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "terminal.input_error", listOf("streamId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf("generation", "inputSeq", "ackedThroughInputSeq", "error"),
    )
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "inputSeq"))
    jsonCounter(required(payload, "ackedThroughInputSeq"))
    validateStructuredError(required(payload, "error"))
}

private fun validateTerminalResizeFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "terminal.resize", listOf("streamId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("generation", "resizeSeq", "cols", "rows"))
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "resizeSeq"))
    jsonInteger(required(payload, "cols"), minimum = 1, maximum = 1_000)
    jsonInteger(required(payload, "rows"), minimum = 1, maximum = 500)
}

private fun validateTerminalResizeAckFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "terminal.resize_ack", listOf("streamId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("generation", "ackedThroughResizeSeq"))
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "ackedThroughResizeSeq"))
}

private fun validateTerminalResizeErrorFrame(frame: RelayV2JsonObject) {
    publicRoot(frame, "event", "terminal.resize_error", listOf("streamId", "payload"))
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(
        payload,
        listOf("generation", "resizeSeq", "ackedThroughResizeSeq", "error"),
    )
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "resizeSeq"))
    jsonCounter(required(payload, "ackedThroughResizeSeq"))
    validateStructuredError(required(payload, "error"))
}

private fun validateTerminalCloseFrame(frame: RelayV2JsonObject) {
    publicRoot(
        frame,
        "request",
        "terminal.close",
        listOf(
            "requestId",
            "hostId",
            "expectedHostEpoch",
            "scopeId",
            "sessionId",
            "streamId",
            "payload",
        ),
    )
    val payload = jsonObject(required(frame, "payload"))
    exactKeys(payload, listOf("closeId", "generation", "resumeToken"))
    jsonId(required(payload, "closeId"))
    jsonId(required(payload, "generation"))
    jsonString(required(payload, "resumeToken"), maxBytes = 4_096)
}

private fun validateTerminalClosedFrame(frame: RelayV2JsonObject) {
    when (frame["kind"]) {
        "response" -> {
            publicRoot(
                frame,
                "response",
                "terminal.closed",
                listOf(
                    "requestId",
                    "hostId",
                    "hostEpoch",
                    "hostInstanceId",
                    "scopeId",
                    "sessionId",
                    "streamId",
                    "payload",
                ),
            )
            validateTerminalClosedPayload(required(frame, "payload"), correlated = true)
        }
        "event" -> {
            publicRoot(
                frame,
                "event",
                "terminal.closed",
                listOf("streamId", "payload"),
            )
            validateTerminalClosedPayload(required(frame, "payload"), correlated = false)
        }
        else -> schemaFailure("schema-mismatch")
    }
}

private fun validateTerminalClosedPayload(value: Any?, correlated: Boolean) {
    val payload = jsonObject(value)
    exactKeys(
        payload,
        (if (correlated) listOf("closeId") else emptyList()) +
            listOf(
                "generation",
                "finalOffset",
                "replayAvailable",
                "bufferStartOffset",
                "reason",
                "exitCode",
            ) +
            if (correlated) listOf("deduplicated") else emptyList(),
    )
    if (correlated) {
        jsonId(required(payload, "closeId"))
        jsonBoolean(required(payload, "deduplicated"))
    }
    jsonId(required(payload, "generation"))
    jsonCounter(required(payload, "finalOffset"))
    val replayAvailable = jsonBoolean(required(payload, "replayAvailable"))
    jsonNullable(payload["bufferStartOffset"]) { jsonCounter(it) }
    if (replayAvailable != (payload["bufferStartOffset"] != null)) {
        schemaFailure("schema-mismatch")
    }
    val reason = jsonOneOf(
        required(payload, "reason"),
        if (correlated) {
            setOf("client_closed", "backend_exit", "backend_error")
        } else {
            setOf("backend_exit", "backend_error")
        },
    )
    val exitCode = payload["exitCode"]?.let {
        jsonInteger(it, minimum = Int.MIN_VALUE.toLong(), maximum = Int.MAX_VALUE.toLong())
    }
    if (reason == "client_closed" && exitCode != null) schemaFailure("schema-mismatch")
    if (reason == "backend_exit" && exitCode == null) schemaFailure("schema-mismatch")
}
