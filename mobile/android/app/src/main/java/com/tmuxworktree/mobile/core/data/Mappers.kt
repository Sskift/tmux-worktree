package com.tmuxworktree.mobile.core.data

import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.OutboxMessage
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.model.TimelineEvent

internal fun HostEntity.toDomain() = RelayHost(
    hostId = hostId,
    displayName = displayName,
    clients = clients,
    status = enumValueOrDefault(status, ConnectionStatus.UNKNOWN),
    lastSeenAtMillis = lastSeenAtMillis,
)

internal fun RelayHost.toEntity() = HostEntity(
    hostId = hostId,
    displayName = displayName,
    clients = clients,
    status = status.name,
    lastSeenAtMillis = lastSeenAtMillis,
)

internal fun ScopeEntity.toDomain() = RelayScope(
    hostId = hostId,
    scopeId = scopeId,
    label = label,
    kind = kind,
    reachable = reachable,
    sessionCount = sessionCount,
    error = error,
)

internal fun RelayScope.toEntity() = ScopeEntity(
    hostId = hostId,
    scopeId = scopeId,
    label = label,
    kind = kind,
    reachable = reachable,
    sessionCount = sessionCount,
    error = error,
)

internal fun SessionEntity.toDomain() = RelaySession(
    hostId = hostId,
    hostName = hostName,
    name = name,
    rawName = rawName,
    scopeId = scopeId,
    scopeLabel = scopeLabel,
    kind = kind,
    project = project,
    label = label,
    cwd = cwd,
    attached = attached,
    windows = windows,
    createdAtSeconds = createdAtSeconds,
    activityAtSeconds = activityAtSeconds,
    agentState = enumValueOrDefault(agentState, AgentState.UNKNOWN),
    summary = summary,
    branch = branch,
)

internal fun RelaySession.toEntity(cachedAtMillis: Long) = SessionEntity(
    hostId = hostId,
    hostName = hostName,
    name = name,
    rawName = rawName,
    scopeId = scopeId,
    scopeLabel = scopeLabel,
    kind = kind,
    project = project,
    label = label,
    cwd = cwd,
    attached = attached,
    windows = windows,
    createdAtSeconds = createdAtSeconds,
    activityAtSeconds = activityAtSeconds,
    agentState = agentState.name,
    summary = summary,
    branch = branch,
    cachedAtMillis = cachedAtMillis,
)

internal fun OutboxEntity.toDomain() = OutboxMessage(
    commandId = commandId,
    requestId = requestId,
    hostId = hostId,
    sessionName = sessionName,
    body = body,
    createdAtMillis = createdAtMillis,
    expiresAtMillis = expiresAtMillis,
    state = enumValueOrDefault(state, DeliveryState.AMBIGUOUS),
    attemptCount = attemptCount,
    lastError = lastError,
)

internal fun OutboxMessage.toEntity() = OutboxEntity(
    commandId = commandId,
    requestId = requestId,
    hostId = hostId,
    sessionName = sessionName,
    body = body,
    createdAtMillis = createdAtMillis,
    expiresAtMillis = expiresAtMillis,
    state = state.name,
    attemptCount = attemptCount,
    lastError = lastError,
)

internal fun TimelineEntity.toDomain() = TimelineEvent(
    eventId = eventId,
    sessionId = sessionId,
    actor = enumValueOrDefault(actor, TimelineActor.SYSTEM),
    body = body,
    createdAtMillis = createdAtMillis,
    code = code,
    deliveryState = deliveryState?.let { enumValueOrDefault(it, DeliveryState.AMBIGUOUS) },
)

internal fun TimelineEvent.toEntity() = TimelineEntity(
    eventId = eventId,
    sessionId = sessionId,
    actor = actor.name,
    body = body,
    createdAtMillis = createdAtMillis,
    code = code,
    deliveryState = deliveryState?.name,
)

private inline fun <reified T : Enum<T>> enumValueOrDefault(value: String, fallback: T): T =
    enumValues<T>().firstOrNull { it.name == value } ?: fallback
