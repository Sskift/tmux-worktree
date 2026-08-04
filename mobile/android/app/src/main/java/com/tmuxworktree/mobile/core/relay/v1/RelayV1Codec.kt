package com.tmuxworktree.mobile.core.relay.v1

class RelayV1Codec {
    fun encode(command: RelayV1Command): String {
        val payload = linkedMapOf<String, Any?>("type" to command.type)
        when (command) {
            is RelayV1Command.ListHosts -> payload.putOptional("requestId", command.requestId)
            is RelayV1Command.ListSessions -> {
                payload.putOptional("hostId", command.hostId)
                payload.putOptional("requestId", command.requestId)
            }
            is RelayV1Command.ListScopeStatuses -> {
                payload.putOptional("hostId", command.hostId)
                payload.putOptional("requestId", command.requestId)
            }
            is RelayV1Command.CreateWorktree -> {
                payload.putOptional("hostId", command.hostId)
                payload.putOptional("requestId", command.requestId)
                payload.putOptional("scopeId", command.scopeId)
                payload.putOptional("project", command.project)
                payload.putOptional("path", command.path)
                payload.putOptional("name", command.name)
                payload.putOptional("branch", command.branch)
                payload.putOptional("aiCommand", command.aiCommand)
                payload.putOptional("aiCmd", command.aiCmd)
            }
            is RelayV1Command.CreateTerminal -> {
                payload.putOptional("hostId", command.hostId)
                payload.putOptional("requestId", command.requestId)
                payload.putOptional("scopeId", command.scopeId)
                payload["cwd"] = command.cwd
                payload.putOptional("label", command.label)
            }
            is RelayV1Command.OpenTerminal -> {
                payload.putOptional("hostId", command.hostId)
                payload["streamId"] = command.streamId
                payload["session"] = command.session
                payload.putPane(command.pane)
            }
            is RelayV1Command.SendAgentMessage -> {
                payload.putOptional("hostId", command.hostId)
                payload.putOptional("requestId", command.requestId)
                payload["session"] = command.session
                payload.putPane(command.pane)
                payload["message"] = command.message
                payload.putOptional("submit", command.submit)
            }
            is RelayV1Command.KillSession -> {
                payload.putOptional("hostId", command.hostId)
                payload.putOptional("requestId", command.requestId)
                payload["session"] = command.session
            }
            is RelayV1Command.TerminalInput -> {
                payload["streamId"] = command.streamId
                payload["data"] = command.data
            }
            is RelayV1Command.Resize -> {
                payload["streamId"] = command.streamId
                payload["cols"] = command.cols
                payload["rows"] = command.rows
            }
            is RelayV1Command.CloseTerminal -> payload["streamId"] = command.streamId
        }
        return TinyJson.stringify(payload)
    }

    fun decode(raw: String): RelayV1DecodeResult {
        return try {
            val payload = TinyJson.parseObject(raw)
            when (val type = payload.string("type")) {
                "ready" -> RelayV1DecodeResult.Message(
                    RelayV1Event.Ready(
                        clientId = payload.string("clientId"),
                        hostId = payload.nullableString("hostId"),
                    ),
                )
                "hosts" -> RelayV1DecodeResult.Message(
                    RelayV1Event.Hosts(
                        requestId = payload.nullableString("requestId"),
                        hosts = payload.objects("hosts").map(::decodeHost),
                    ),
                )
                "sessions" -> RelayV1DecodeResult.Message(
                    RelayV1Event.Sessions(
                        requestId = payload.nullableString("requestId"),
                        sessions = payload.objects("sessions").map(::decodeSession),
                    ),
                )
                "scope_statuses" -> RelayV1DecodeResult.Message(
                    RelayV1Event.ScopeStatuses(
                        requestId = payload.nullableString("requestId"),
                        scopes = payload.objects("scopes").map(::decodeScope),
                    ),
                )
                "worktree_created" -> RelayV1DecodeResult.Message(
                    RelayV1Event.WorktreeCreated(
                        requestId = payload.nullableString("requestId"),
                        session = decodeSession(requireNotNull(payload.objectValue("session")) { "session is required" }),
                    ),
                )
                "terminal_created" -> RelayV1DecodeResult.Message(
                    RelayV1Event.TerminalCreated(
                        requestId = payload.nullableString("requestId"),
                        session = decodeSession(requireNotNull(payload.objectValue("session")) { "session is required" }),
                    ),
                )
                "agent_message_sent" -> RelayV1DecodeResult.Message(
                    RelayV1Event.AgentMessageSent(
                        requestId = payload.nullableString("requestId"),
                        session = payload.string("session"),
                        pane = payload.relayPane("pane"),
                    ),
                )
                "session_killed" -> RelayV1DecodeResult.Message(
                    RelayV1Event.SessionKilled(
                        requestId = payload.nullableString("requestId"),
                        session = payload.string("session"),
                    ),
                )
                "terminal_data" -> RelayV1DecodeResult.Message(
                    RelayV1Event.TerminalData(
                        streamId = payload.nullableString("streamId"),
                        data = payload.string("data"),
                    ),
                )
                "terminal_exit" -> RelayV1DecodeResult.Message(
                    RelayV1Event.TerminalExit(
                        streamId = payload.nullableString("streamId"),
                        code = payload.nullableInt("code"),
                    ),
                )
                "error" -> RelayV1DecodeResult.Message(
                    RelayV1Event.Error(
                        requestId = payload.nullableString("requestId"),
                        streamId = payload.nullableString("streamId"),
                        message = payload.string("message", "unknown error"),
                    ),
                )
                else -> RelayV1DecodeResult.Unknown(type = type, raw = raw)
            }
        } catch (error: Throwable) {
            RelayV1DecodeResult.Malformed(error.message ?: error::class.java.simpleName, raw)
        }
    }

    private fun decodeHost(payload: Map<String, Any?>): RelayV1Host = RelayV1Host(
        hostId = payload.string("hostId"),
        displayName = payload.string("displayName"),
        connectedAt = payload.long("connectedAt"),
        clients = payload.int("clients"),
    )

    private fun decodeSession(payload: Map<String, Any?>): RelayV1Session = RelayV1Session(
        name = payload.string("name"),
        rawName = payload.string("rawName"),
        scopeId = payload.string("scopeId"),
        scopeLabel = payload.string("scopeLabel"),
        kind = payload.string("kind", "session").ifBlank { "session" },
        project = payload.string("project"),
        label = payload.string("label"),
        cwd = payload.string("cwd"),
        attached = payload.boolean("attached"),
        windows = payload.int("windows"),
        created = payload.long("created"),
        activity = payload.long("activity"),
    )

    private fun decodeScope(payload: Map<String, Any?>): RelayV1ScopeStatus = RelayV1ScopeStatus(
        scopeId = payload.string("scopeId"),
        scopeLabel = payload.string("scopeLabel"),
        kind = payload.string("kind"),
        reachable = payload.boolean("reachable"),
        sessionCount = payload.int("sessionCount"),
        error = payload.string("error"),
    )
}

private fun MutableMap<String, Any?>.putOptional(name: String, value: Any?) {
    if (value != null) this[name] = value
}

private fun MutableMap<String, Any?>.putPane(pane: RelayV1Pane?) {
    when (pane) {
        null -> Unit
        is RelayV1Pane.Number -> this["pane"] = pane.value
        is RelayV1Pane.Text -> this["pane"] = pane.value
    }
}

private fun Map<String, Any?>.relayPane(name: String): RelayV1Pane? = when (val value = this[name]) {
    null -> null
    is Byte, is Short, is Int, is Long -> RelayV1Pane.Number((value as Number).toInt())
    is Number -> RelayV1Pane.Text(value.toString())
    is String -> RelayV1Pane.Text(value)
    else -> null
}
