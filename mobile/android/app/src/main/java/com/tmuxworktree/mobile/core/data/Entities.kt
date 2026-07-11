package com.tmuxworktree.mobile.core.data

import androidx.room.Entity
import androidx.room.Index

@Entity(tableName = "hosts", primaryKeys = ["hostId"])
data class HostEntity(
    val hostId: String,
    val displayName: String,
    val clients: Int,
    val status: String,
    val lastSeenAtMillis: Long,
)

@Entity(
    tableName = "scopes",
    primaryKeys = ["hostId", "scopeId"],
    indices = [Index("hostId")],
)
data class ScopeEntity(
    val hostId: String,
    val scopeId: String,
    val label: String,
    val kind: String,
    val reachable: Boolean,
    val sessionCount: Int,
    val error: String,
)

@Entity(
    tableName = "sessions",
    primaryKeys = ["hostId", "name"],
    indices = [Index("hostId"), Index(value = ["hostId", "scopeId"]), Index("activityAtSeconds")],
)
data class SessionEntity(
    val hostId: String,
    val hostName: String,
    val name: String,
    val rawName: String,
    val scopeId: String,
    val scopeLabel: String,
    val kind: String,
    val project: String,
    val label: String,
    val cwd: String,
    val attached: Boolean,
    val windows: Int,
    val createdAtSeconds: Long,
    val activityAtSeconds: Long,
    val agentState: String,
    val summary: String,
    val branch: String,
    val cachedAtMillis: Long,
)

@Entity(
    tableName = "outbox",
    primaryKeys = ["commandId"],
    indices = [
        Index(value = ["requestId"], unique = true),
        Index(value = ["hostId", "sessionName"]),
        Index("state"),
        Index("createdAtMillis"),
    ],
)
data class OutboxEntity(
    val commandId: String,
    val requestId: String,
    val hostId: String,
    val sessionName: String,
    val body: String,
    val createdAtMillis: Long,
    val expiresAtMillis: Long,
    val state: String,
    val attemptCount: Int,
    val lastError: String,
)

@Entity(
    tableName = "timeline",
    primaryKeys = ["eventId"],
    indices = [Index("sessionId"), Index(value = ["sessionId", "createdAtMillis"])],
)
data class TimelineEntity(
    val eventId: String,
    val sessionId: String,
    val actor: String,
    val body: String,
    val createdAtMillis: Long,
    val code: String,
    val deliveryState: String?,
)

@Entity(
    tableName = "stream_checkpoints",
    primaryKeys = ["streamId"],
    indices = [Index("sessionId")],
)
data class StreamCheckpointEntity(
    val streamId: String,
    val sessionId: String,
    val generation: Long,
    val lastOutputSequence: Long,
    val lastInputAck: Long,
    val updatedAtMillis: Long,
)
