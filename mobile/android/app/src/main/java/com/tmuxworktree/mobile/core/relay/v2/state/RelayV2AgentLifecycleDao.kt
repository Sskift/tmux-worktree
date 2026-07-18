package com.tmuxworktree.mobile.core.relay.v2.state

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

private const val CURRENT_WITNESS_FROM =
    "FROM relay_v2_agent_lifecycle_current AS l " +
        "INNER JOIN relay_v2_agent_lifecycle_event_witnesses AS w ON " +
        "w.profileId = l.profileId " +
        "AND w.profileActivationGeneration = l.profileActivationGeneration " +
        "AND w.principalId = l.principalId AND w.clientInstanceId = l.clientInstanceId " +
        "AND w.hostId = l.hostId AND w.hostEpoch = l.hostEpoch AND w.scopeId = l.scopeId " +
        "AND w.sessionId = l.sessionId AND w.timelineEpoch = l.timelineEpoch " +
        "AND w.eventId = l.lifecycleEventId AND w.agentEventSeq = l.agentEventSeq " +
        "AND w.agentEventSeqOrder = l.agentEventSeqOrder "

private const val CURRENT_WITNESS_SELECT = "SELECT w.* " + CURRENT_WITNESS_FROM

private const val NOTIFICATION_WITNESS_FROM =
    "FROM relay_v2_agent_notification_ledger AS n " +
        "INNER JOIN relay_v2_agent_lifecycle_event_witnesses AS w ON " +
        "w.profileId = n.profileId " +
        "AND w.profileActivationGeneration = n.profileActivationGeneration " +
        "AND w.principalId = n.principalId AND w.clientInstanceId = n.clientInstanceId " +
        "AND w.hostId = n.hostId AND w.hostEpoch = n.hostEpoch AND w.scopeId = n.scopeId " +
        "AND w.sessionId = n.sessionId AND w.timelineEpoch = n.timelineEpoch " +
        "AND w.eventId = n.lifecycleEventId AND w.agentEventSeq = n.agentEventSeq " +
        "AND w.agentEventSeqOrder = n.agentEventSeqOrder " +
        "AND w.lifecycleState = n.lifecycleState "

internal data class RelayV2AgentLifecycleSqlAudit(
    val itemCount: Long,
    val declaredCanonicalBytes: Long,
    val actualCanonicalBytes: Long,
)

internal data class RelayV2AgentLifecycleDigestAuditRow(
    val eventId: String,
    val agentEventSeq: String,
    val agentEventSeqOrder: String,
    val lifecycleScope: String,
    val runId: String,
    val turnIdKey: String,
    val declaredCanonicalBytes: Int,
    val actualCanonicalBytes: Long,
    val canonicalSha256: String,
    val stateTieBreak: String,
)

internal data class RelayV2AgentLifecycleGlobalAuditRow(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
    val eventId: String,
    val agentEventSeq: String,
    val agentEventSeqOrder: String,
    val lifecycleScope: String,
    val runId: String,
    val turnIdKey: String,
    val declaredCanonicalBytes: Int,
    val actualCanonicalBytes: Long,
    val canonicalSha256: String,
    val stateTieBreak: String,
)

internal data class RelayV2AgentLifecycleCurrentGlobalAuditRow(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
    val lifecycleScope: String,
    val runId: String,
    val turnIdKey: String,
    val lifecycleEventId: String,
    val agentEventSeq: String,
    val agentEventSeqOrder: String,
)

/**
 * Row-oriented storage primitives for the optional Agent lifecycle consumer.
 *
 * Callers own the surrounding Room transaction and keep each call within their local record/byte
 * budget. This DAO does not reduce transitions, choose retention, or prune permanent witnesses.
 */
@Dao
internal interface RelayV2AgentLifecycleDao {
    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_current WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleScope = :lifecycleScope AND runId = :runId " +
            "AND turnIdKey = :turnIdKey LIMIT 1",
    )
    fun currentByIdentity(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleScope: String,
        runId: String,
        turnIdKey: String,
    ): RelayV2AgentLifecycleCurrentEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_current WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleEventId = :eventId LIMIT 1",
    )
    fun currentByEventId(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        eventId: String,
    ): RelayV2AgentLifecycleCurrentEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_current WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND agentEventSeq = :agentEventSeq LIMIT 1",
    )
    fun currentByAgentEventSeq(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        agentEventSeq: String,
    ): RelayV2AgentLifecycleCurrentEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_current WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(agentEventSeqOrder = :afterAgentEventSeqOrder AND lifecycleEventId > :afterEventId)) " +
            "ORDER BY agentEventSeqOrder, lifecycleEventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun currentPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleCurrentEntity>

    @Query(
        CURRENT_WITNESS_SELECT +
            "WHERE l.profileId = :profileId " +
            "AND l.profileActivationGeneration = :profileActivationGeneration " +
            "AND l.principalId = :principalId AND l.clientInstanceId = :clientInstanceId " +
            "AND l.hostId = :hostId AND l.hostEpoch = :hostEpoch AND l.scopeId = :scopeId " +
            "AND l.sessionId = :sessionId AND l.timelineEpoch = :timelineEpoch " +
            "AND l.lifecycleScope = 'RUN' AND l.runId = :runId AND l.turnIdKey = '' LIMIT 1",
    )
    fun currentRun(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        runId: String,
    ): RelayV2AgentLifecycleEventWitnessEntity?

    @Query(
        CURRENT_WITNESS_SELECT +
            "WHERE l.profileId = :profileId " +
            "AND l.profileActivationGeneration = :profileActivationGeneration " +
            "AND l.principalId = :principalId AND l.clientInstanceId = :clientInstanceId " +
            "AND l.hostId = :hostId AND l.hostEpoch = :hostEpoch AND l.scopeId = :scopeId " +
            "AND l.sessionId = :sessionId AND l.timelineEpoch = :timelineEpoch " +
            "AND l.lifecycleScope = 'TURN' AND l.runId = :runId " +
            "AND w.lifecycleState IN ('RUNNING', 'WAITING_FOR_USER') " +
            "ORDER BY w.agentEventSeqOrder, w.eventId LIMIT 2",
    )
    fun currentNonterminalTurnsForRun(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        runId: String,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>

    @Query(
        CURRENT_WITNESS_SELECT +
            "WHERE l.profileId = :profileId " +
            "AND l.profileActivationGeneration = :profileActivationGeneration " +
            "AND l.principalId = :principalId AND l.clientInstanceId = :clientInstanceId " +
            "AND l.hostId = :hostId AND l.hostEpoch = :hostEpoch AND l.scopeId = :scopeId " +
            "AND l.sessionId = :sessionId AND l.timelineEpoch = :timelineEpoch " +
            "AND w.sourceEpoch = :sourceEpoch AND " +
            "(w.agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(w.agentEventSeqOrder = :afterAgentEventSeqOrder AND " +
            "w.eventId > :afterEventId)) ORDER BY w.agentEventSeqOrder, w.eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun currentSourcePageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        sourceEpoch: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>

    @Query(
        CURRENT_WITNESS_SELECT +
            "WHERE l.profileId = :profileId " +
            "AND l.profileActivationGeneration = :profileActivationGeneration " +
            "AND l.principalId = :principalId AND l.clientInstanceId = :clientInstanceId " +
            "AND l.hostId = :hostId AND l.hostEpoch = :hostEpoch AND l.scopeId = :scopeId " +
            "AND l.sessionId = :sessionId AND l.timelineEpoch = :timelineEpoch " +
            "AND w.lifecycleState IN ('FAILED', 'COMPLETED') AND " +
            "(w.agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(w.agentEventSeqOrder = :afterAgentEventSeqOrder AND " +
            "w.eventId > :afterEventId)) ORDER BY w.agentEventSeqOrder, w.eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun currentTerminalPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>

    @Query(
        "SELECT DISTINCT w.sourceEpoch " + CURRENT_WITNESS_FROM +
            "WHERE l.profileId = :profileId " +
            "AND l.profileActivationGeneration = :profileActivationGeneration " +
            "AND l.principalId = :principalId AND l.clientInstanceId = :clientInstanceId " +
            "AND l.hostId = :hostId AND l.hostEpoch = :hostEpoch AND l.scopeId = :scopeId " +
            "AND l.sessionId = :sessionId AND l.timelineEpoch = :timelineEpoch " +
            "AND l.runId = :runId ORDER BY w.sourceEpoch LIMIT 2",
    )
    fun currentRunSourceEpochs(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        runId: String,
    ): List<String>

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_event_witnesses WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleScope = 'RUN' AND runId = :runId " +
            "AND turnIdKey = '' " +
            "AND lifecycleState IN ('FAILED', 'COMPLETED') " +
            "ORDER BY agentEventSeqOrder DESC, eventId DESC LIMIT 2",
    )
    fun terminalRunEvidence(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        runId: String,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>

    @Query(
        "SELECT COUNT(*) AS itemCount, 0 AS byteCount " +
            "FROM relay_v2_agent_lifecycle_current " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun currentStats(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): RelayV2SqlStats

    @Query(
        "SELECT COUNT(*) AS itemCount, 0 AS byteCount " +
            "FROM relay_v2_agent_lifecycle_current",
    )
    fun currentGlobalStats(): RelayV2SqlStats

    @Query(
        "SELECT profileId, profileActivationGeneration, principalId, clientInstanceId, " +
            "hostId, hostEpoch, scopeId, sessionId, timelineEpoch, lifecycleScope, runId, " +
            "turnIdKey, lifecycleEventId, agentEventSeq, agentEventSeqOrder " +
            "FROM relay_v2_agent_lifecycle_current WHERE (profileId, " +
            "profileActivationGeneration, principalId, clientInstanceId, hostId, hostEpoch, " +
            "scopeId, sessionId, timelineEpoch, lifecycleScope, runId, turnIdKey) > " +
            "(:afterProfileId, " +
            ":afterProfileActivationGeneration, :afterPrincipalId, :afterClientInstanceId, " +
            ":afterHostId, :afterHostEpoch, :afterScopeId, :afterSessionId, :afterTimelineEpoch, " +
            ":afterLifecycleScope, :afterRunId, :afterTurnIdKey) ORDER BY profileId, " +
            "profileActivationGeneration, principalId, clientInstanceId, hostId, hostEpoch, " +
            "scopeId, sessionId, timelineEpoch, lifecycleScope, runId, turnIdKey " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun currentGlobalAuditPageAfter(
        afterProfileId: String,
        afterProfileActivationGeneration: Long,
        afterPrincipalId: String,
        afterClientInstanceId: String,
        afterHostId: String,
        afterHostEpoch: String,
        afterScopeId: String,
        afterSessionId: String,
        afterTimelineEpoch: String,
        afterLifecycleScope: String,
        afterRunId: String,
        afterTurnIdKey: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleCurrentGlobalAuditRow>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertCurrent(records: List<RelayV2AgentLifecycleCurrentEntity>)

    @Query(
        "UPDATE relay_v2_agent_lifecycle_current SET lifecycleEventId = :newEventId, " +
            "agentEventSeq = :newAgentEventSeq, agentEventSeqOrder = :newAgentEventSeqOrder " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleScope = :lifecycleScope AND runId = :runId AND turnIdKey = :turnIdKey " +
            "AND lifecycleEventId = :expectedEventId AND agentEventSeq = :expectedAgentEventSeq " +
            "AND agentEventSeqOrder = :expectedAgentEventSeqOrder",
    )
    fun updateCurrentExact(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleScope: String,
        runId: String,
        turnIdKey: String,
        expectedEventId: String,
        expectedAgentEventSeq: String,
        expectedAgentEventSeqOrder: String,
        newEventId: String,
        newAgentEventSeq: String,
        newAgentEventSeqOrder: String,
    ): Int

    @Query(
        "DELETE FROM relay_v2_agent_lifecycle_current WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleScope = :lifecycleScope AND runId = :runId AND turnIdKey = :turnIdKey " +
            "AND lifecycleEventId = :expectedEventId AND agentEventSeq = :expectedAgentEventSeq " +
            "AND agentEventSeqOrder = :expectedAgentEventSeqOrder",
    )
    fun deleteCurrentExact(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleScope: String,
        runId: String,
        turnIdKey: String,
        expectedEventId: String,
        expectedAgentEventSeq: String,
        expectedAgentEventSeqOrder: String,
    ): Int

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_event_witnesses WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND eventId = :eventId LIMIT 1",
    )
    fun witnessByEventId(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        eventId: String,
    ): RelayV2AgentLifecycleEventWitnessEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_event_witnesses WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND agentEventSeq = :agentEventSeq LIMIT 1",
    )
    fun witnessByAgentEventSeq(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        agentEventSeq: String,
    ): RelayV2AgentLifecycleEventWitnessEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_event_witnesses WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(agentEventSeqOrder = :afterAgentEventSeqOrder AND eventId > :afterEventId)) " +
            "ORDER BY agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun witnessPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_event_witnesses WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleScope = :lifecycleScope AND runId = :runId " +
            "AND turnIdKey = :turnIdKey ORDER BY agentEventSeqOrder DESC, eventId DESC LIMIT 1",
    )
    fun highestWitnessForIdentity(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleScope: String,
        runId: String,
        turnIdKey: String,
    ): RelayV2AgentLifecycleEventWitnessEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_event_witnesses WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleScope = :lifecycleScope AND runId = :runId " +
            "AND turnIdKey = :turnIdKey AND " +
            "(agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(agentEventSeqOrder = :afterAgentEventSeqOrder AND eventId > :afterEventId)) " +
            "ORDER BY agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun witnessIdentityPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleScope: String,
        runId: String,
        turnIdKey: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>

    /** Namespace-local permanent-chain audit order; callers retain only the prior identity row. */
    @Query(
        "SELECT * FROM relay_v2_agent_lifecycle_event_witnesses " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(lifecycleScope, runId, turnIdKey, agentEventSeqOrder, eventId) > " +
            "(:afterLifecycleScope, :afterRunId, :afterTurnIdKey, " +
            ":afterAgentEventSeqOrder, :afterEventId) " +
            "ORDER BY lifecycleScope, runId, turnIdKey, agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun witnessIdentityAuditRowsAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterLifecycleScope: String,
        afterRunId: String,
        afterTurnIdKey: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>

    @Query(
        "SELECT EXISTS(SELECT 1 FROM relay_v2_agent_lifecycle_event_witnesses " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleScope = 'TURN' AND runId = :runId LIMIT 1)",
    )
    fun hasPermanentTurnEvidence(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        runId: String,
    ): Boolean

    @Query(
        "SELECT COUNT(*) AS itemCount, " +
            "COALESCE(SUM(witnessCanonicalUtf8Bytes), 0) AS declaredCanonicalBytes, " +
            "COALESCE(SUM(length(CAST(witnessCanonicalJson AS BLOB))), 0) " +
            "AS actualCanonicalBytes FROM relay_v2_agent_lifecycle_event_witnesses " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun witnessAudit(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): RelayV2AgentLifecycleSqlAudit

    @Query(
        "SELECT eventId, agentEventSeq, agentEventSeqOrder, lifecycleScope, runId, turnIdKey, " +
            "witnessCanonicalUtf8Bytes AS declaredCanonicalBytes, " +
            "length(CAST(witnessCanonicalJson AS BLOB)) AS actualCanonicalBytes, " +
            "witnessSha256 AS canonicalSha256, lifecycleState AS stateTieBreak " +
            "FROM relay_v2_agent_lifecycle_event_witnesses WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(lifecycleScope, runId, turnIdKey, agentEventSeqOrder, eventId) > " +
            "(:afterLifecycleScope, :afterRunId, :afterTurnIdKey, " +
            ":afterAgentEventSeqOrder, :afterEventId) " +
            "ORDER BY lifecycleScope, runId, turnIdKey, agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun witnessIdentityAuditPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterLifecycleScope: String,
        afterRunId: String,
        afterTurnIdKey: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleDigestAuditRow>

    @Query(
        "SELECT COUNT(*) AS itemCount, " +
            "COALESCE(SUM(witnessCanonicalUtf8Bytes), 0) AS declaredCanonicalBytes, " +
            "COALESCE(SUM(length(CAST(witnessCanonicalJson AS BLOB))), 0) " +
            "AS actualCanonicalBytes FROM relay_v2_agent_lifecycle_event_witnesses",
    )
    fun witnessGlobalStats(): RelayV2AgentLifecycleSqlAudit

    @Query(
        "SELECT profileId, profileActivationGeneration, principalId, " +
            "clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch, eventId, " +
            "agentEventSeq, agentEventSeqOrder, lifecycleScope, runId, turnIdKey, " +
            "witnessCanonicalUtf8Bytes AS declaredCanonicalBytes, " +
            "length(CAST(witnessCanonicalJson AS BLOB)) AS actualCanonicalBytes, " +
            "witnessSha256 AS canonicalSha256, lifecycleState AS stateTieBreak " +
            "FROM relay_v2_agent_lifecycle_event_witnesses WHERE (profileId, " +
            "profileActivationGeneration, principalId, clientInstanceId, hostId, hostEpoch, " +
            "scopeId, sessionId, timelineEpoch, lifecycleScope, runId, turnIdKey, " +
            "agentEventSeqOrder, eventId) > " +
            "(:afterProfileId, :afterProfileActivationGeneration, :afterPrincipalId, " +
            ":afterClientInstanceId, :afterHostId, :afterHostEpoch, :afterScopeId, " +
            ":afterSessionId, :afterTimelineEpoch, :afterLifecycleScope, :afterRunId, " +
            ":afterTurnIdKey, :afterAgentEventSeqOrder, :afterEventId) " +
            "ORDER BY profileId, profileActivationGeneration, principalId, clientInstanceId, " +
            "hostId, hostEpoch, scopeId, sessionId, timelineEpoch, lifecycleScope, runId, " +
            "turnIdKey, agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun witnessGlobalAuditPageAfter(
        afterProfileId: String,
        afterProfileActivationGeneration: Long,
        afterPrincipalId: String,
        afterClientInstanceId: String,
        afterHostId: String,
        afterHostEpoch: String,
        afterScopeId: String,
        afterSessionId: String,
        afterTimelineEpoch: String,
        afterLifecycleScope: String,
        afterRunId: String,
        afterTurnIdKey: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleGlobalAuditRow>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertWitnesses(witnesses: List<RelayV2AgentLifecycleEventWitnessEntity>)

    @Query(
        "SELECT * FROM relay_v2_agent_recent_event_evidence WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND eventId = :eventId LIMIT 1",
    )
    fun recentEvidenceByEventId(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        eventId: String,
    ): RelayV2AgentRecentEventEvidenceEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_recent_event_evidence WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND agentEventSeq = :agentEventSeq LIMIT 1",
    )
    fun recentEvidenceByAgentEventSeq(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        agentEventSeq: String,
    ): RelayV2AgentRecentEventEvidenceEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_recent_event_evidence WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(agentEventSeqOrder = :afterAgentEventSeqOrder AND eventId > :afterEventId)) " +
            "ORDER BY agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun recentEvidencePageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentRecentEventEvidenceEntity>

    @Query(
        "SELECT COUNT(*) AS itemCount, " +
            "COALESCE(SUM(evidenceCanonicalUtf8Bytes), 0) AS declaredCanonicalBytes, " +
            "COALESCE(SUM(length(CAST(evidenceCanonicalJson AS BLOB))), 0) " +
            "AS actualCanonicalBytes FROM relay_v2_agent_recent_event_evidence " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun recentEvidenceAudit(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): RelayV2AgentLifecycleSqlAudit

    @Query(
        "SELECT eventId, agentEventSeq, agentEventSeqOrder, '' AS lifecycleScope, " +
            "'' AS runId, '' AS turnIdKey, " +
            "evidenceCanonicalUtf8Bytes AS declaredCanonicalBytes, " +
            "length(CAST(evidenceCanonicalJson AS BLOB)) AS actualCanonicalBytes, " +
            "evidenceSha256 AS canonicalSha256, '' AS stateTieBreak " +
            "FROM relay_v2_agent_recent_event_evidence " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(agentEventSeqOrder = :afterAgentEventSeqOrder AND eventId > :afterEventId)) " +
            "ORDER BY agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun recentEvidenceDigestAuditPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleDigestAuditRow>

    @Query(
        "SELECT COUNT(*) AS itemCount, " +
            "COALESCE(SUM(evidenceCanonicalUtf8Bytes), 0) AS declaredCanonicalBytes, " +
            "COALESCE(SUM(length(CAST(evidenceCanonicalJson AS BLOB))), 0) " +
            "AS actualCanonicalBytes FROM relay_v2_agent_recent_event_evidence",
    )
    fun recentEvidenceGlobalStats(): RelayV2AgentLifecycleSqlAudit

    @Query(
        "SELECT profileId, profileActivationGeneration, principalId, " +
            "clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch, eventId, " +
            "agentEventSeq, agentEventSeqOrder, '' AS lifecycleScope, '' AS runId, " +
            "'' AS turnIdKey, " +
            "evidenceCanonicalUtf8Bytes AS declaredCanonicalBytes, " +
            "length(CAST(evidenceCanonicalJson AS BLOB)) AS actualCanonicalBytes, " +
            "evidenceSha256 AS canonicalSha256, '' AS stateTieBreak " +
            "FROM relay_v2_agent_recent_event_evidence WHERE (profileId, " +
            "profileActivationGeneration, principalId, clientInstanceId, hostId, hostEpoch, " +
            "scopeId, sessionId, timelineEpoch, agentEventSeqOrder, eventId) > " +
            "(:afterProfileId, :afterProfileActivationGeneration, :afterPrincipalId, " +
            ":afterClientInstanceId, :afterHostId, :afterHostEpoch, :afterScopeId, " +
            ":afterSessionId, :afterTimelineEpoch, :afterAgentEventSeqOrder, :afterEventId) " +
            "ORDER BY profileId, profileActivationGeneration, principalId, clientInstanceId, " +
            "hostId, hostEpoch, scopeId, sessionId, timelineEpoch, agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun recentEvidenceGlobalAuditPageAfter(
        afterProfileId: String,
        afterProfileActivationGeneration: Long,
        afterPrincipalId: String,
        afterClientInstanceId: String,
        afterHostId: String,
        afterHostEpoch: String,
        afterScopeId: String,
        afterSessionId: String,
        afterTimelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleGlobalAuditRow>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertRecentEvidence(evidence: List<RelayV2AgentRecentEventEvidenceEntity>)

    @Query(
        "DELETE FROM relay_v2_agent_recent_event_evidence WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND agentEventSeq = :agentEventSeq " +
            "AND agentEventSeqOrder = :expectedAgentEventSeqOrder " +
            "AND eventId = :expectedEventId AND closedEventDigest = :expectedClosedEventDigest " +
            "AND evidenceCanonicalJson = :expectedCanonicalJson " +
            "AND evidenceCanonicalUtf8Bytes = :expectedCanonicalUtf8Bytes " +
            "AND evidenceSha256 = :expectedSha256",
    )
    fun deleteRecentEvidenceExact(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        agentEventSeq: String,
        expectedAgentEventSeqOrder: String,
        expectedEventId: String,
        expectedClosedEventDigest: String,
        expectedCanonicalJson: String,
        expectedCanonicalUtf8Bytes: Int,
        expectedSha256: String,
    ): Int

    /** Compaction helper only; ordinary E removal uses [deleteRecentEvidenceExact]. */
    @Query(
        "DELETE FROM relay_v2_agent_recent_event_evidence WHERE rowid IN " +
            "(SELECT rowid FROM relay_v2_agent_recent_event_evidence " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND agentEventSeqOrder <= :throughAgentEventSeqOrder " +
            "ORDER BY agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END)",
    )
    fun deleteRecentEvidenceThroughBatch(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        throughAgentEventSeqOrder: String,
        limit: Int,
    ): Int

    @Query(
        "SELECT * FROM relay_v2_agent_notification_ledger WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleEventId = :lifecycleEventId " +
            "AND lifecycleState = :lifecycleState LIMIT 1",
    )
    fun notificationByDedupeKey(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleEventId: String,
        lifecycleState: String,
    ): RelayV2AgentNotificationLedgerEntity?

    @Query(
        "SELECT w.* " + NOTIFICATION_WITNESS_FROM + "WHERE n.profileId = :profileId " +
            "AND n.profileActivationGeneration = :profileActivationGeneration " +
            "AND n.principalId = :principalId AND n.clientInstanceId = :clientInstanceId " +
            "AND n.hostId = :hostId AND n.hostEpoch = :hostEpoch AND n.scopeId = :scopeId " +
            "AND n.sessionId = :sessionId AND n.timelineEpoch = :timelineEpoch " +
            "AND n.lifecycleEventId = :lifecycleEventId " +
            "AND n.lifecycleState = :lifecycleState LIMIT 1",
    )
    fun notificationWitnessByDedupeKey(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleEventId: String,
        lifecycleState: String,
    ): RelayV2AgentLifecycleEventWitnessEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_notification_ledger WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleEventId = :lifecycleEventId LIMIT 1",
    )
    fun notificationByLifecycleEventId(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleEventId: String,
    ): RelayV2AgentNotificationLedgerEntity?

    @Query(
        "SELECT * FROM relay_v2_agent_notification_ledger WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(agentEventSeqOrder = :afterAgentEventSeqOrder AND " +
            "(lifecycleEventId > :afterLifecycleEventId OR " +
            "(lifecycleEventId = :afterLifecycleEventId AND " +
            "lifecycleState > :afterLifecycleState)))) " +
            "ORDER BY agentEventSeqOrder, lifecycleEventId, lifecycleState " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun notificationPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterLifecycleEventId: String,
        afterLifecycleState: String,
        limit: Int,
    ): List<RelayV2AgentNotificationLedgerEntity>

    @Query(
        "SELECT n.* FROM relay_v2_agent_notification_ledger AS n " +
            "WHERE n.profileId = :profileId " +
            "AND n.profileActivationGeneration = :profileActivationGeneration " +
            "AND n.principalId = :principalId AND n.clientInstanceId = :clientInstanceId " +
            "AND n.hostId = :hostId AND n.hostEpoch = :hostEpoch AND n.scopeId = :scopeId " +
            "AND n.sessionId = :sessionId AND n.timelineEpoch = :timelineEpoch " +
            "AND n.disposition = 'SHOWN' AND " +
            "(n.agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(n.agentEventSeqOrder = :afterAgentEventSeqOrder AND " +
            "(n.lifecycleEventId > :afterLifecycleEventId OR " +
            "(n.lifecycleEventId = :afterLifecycleEventId AND " +
            "n.lifecycleState > :afterLifecycleState)))) AND NOT EXISTS (" +
            "SELECT 1 FROM relay_v2_agent_transcript_lifecycle_notification_claims AS c " +
            "WHERE c.profileId = n.profileId " +
            "AND c.profileActivationGeneration = n.profileActivationGeneration " +
            "AND c.principalId = n.principalId " +
            "AND c.clientInstanceId = n.clientInstanceId AND c.hostId = n.hostId " +
            "AND c.hostEpoch = n.hostEpoch AND c.scopeId = n.scopeId " +
            "AND c.sessionId = n.sessionId AND c.timelineEpoch = n.timelineEpoch " +
            "AND c.lifecycleEventId = n.lifecycleEventId " +
            "AND c.lifecycleState = n.lifecycleState) " +
            "ORDER BY n.agentEventSeqOrder, n.lifecycleEventId, n.lifecycleState " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 64 THEN 64 ELSE :limit END",
    )
    fun pendingNotificationPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterLifecycleEventId: String,
        afterLifecycleState: String,
        limit: Int,
    ): List<RelayV2AgentNotificationLedgerEntity>

    @Query(
        "SELECT COUNT(*) AS itemCount, " +
            "COALESCE(SUM(ledgerCanonicalUtf8Bytes), 0) AS declaredCanonicalBytes, " +
            "COALESCE(SUM(length(CAST(ledgerCanonicalJson AS BLOB))), 0) " +
            "AS actualCanonicalBytes FROM relay_v2_agent_notification_ledger " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun notificationAudit(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): RelayV2AgentLifecycleSqlAudit

    @Query(
        "SELECT n.lifecycleEventId AS eventId, n.agentEventSeq, n.agentEventSeqOrder, " +
            "w.lifecycleScope, w.runId, w.turnIdKey, " +
            "n.ledgerCanonicalUtf8Bytes AS declaredCanonicalBytes, " +
            "length(CAST(n.ledgerCanonicalJson AS BLOB)) AS actualCanonicalBytes, " +
            "n.ledgerSha256 AS canonicalSha256, n.lifecycleState AS stateTieBreak " +
            NOTIFICATION_WITNESS_FROM + "WHERE n.profileId = :profileId " +
            "AND n.profileActivationGeneration = :profileActivationGeneration " +
            "AND n.principalId = :principalId AND n.clientInstanceId = :clientInstanceId " +
            "AND n.hostId = :hostId AND n.hostEpoch = :hostEpoch AND n.scopeId = :scopeId " +
            "AND n.sessionId = :sessionId AND n.timelineEpoch = :timelineEpoch AND " +
            "(n.agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(n.agentEventSeqOrder = :afterAgentEventSeqOrder AND " +
            "(n.lifecycleEventId > :afterLifecycleEventId OR " +
            "(n.lifecycleEventId = :afterLifecycleEventId AND " +
            "n.lifecycleState > :afterLifecycleState)))) " +
            "ORDER BY n.agentEventSeqOrder, n.lifecycleEventId, n.lifecycleState " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun notificationDigestAuditPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterLifecycleEventId: String,
        afterLifecycleState: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleDigestAuditRow>

    @Query(
        "SELECT COUNT(*) AS itemCount, " +
            "COALESCE(SUM(ledgerCanonicalUtf8Bytes), 0) AS declaredCanonicalBytes, " +
            "COALESCE(SUM(length(CAST(ledgerCanonicalJson AS BLOB))), 0) " +
            "AS actualCanonicalBytes FROM relay_v2_agent_notification_ledger",
    )
    fun notificationGlobalStats(): RelayV2AgentLifecycleSqlAudit

    @Query(
        "SELECT n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId, " +
            "n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, " +
            "n.lifecycleEventId AS eventId, n.agentEventSeq, n.agentEventSeqOrder, " +
            "w.lifecycleScope, w.runId, w.turnIdKey, " +
            "n.ledgerCanonicalUtf8Bytes AS declaredCanonicalBytes, " +
            "length(CAST(n.ledgerCanonicalJson AS BLOB)) AS actualCanonicalBytes, " +
            "n.ledgerSha256 AS canonicalSha256, n.lifecycleState AS stateTieBreak " +
            NOTIFICATION_WITNESS_FROM + "WHERE (n.profileId, n.profileActivationGeneration, " +
            "n.principalId, n.clientInstanceId, n.hostId, n.hostEpoch, n.scopeId, n.sessionId, " +
            "n.timelineEpoch, n.agentEventSeqOrder, n.lifecycleEventId, n.lifecycleState) > " +
            "(:afterProfileId, :afterProfileActivationGeneration, :afterPrincipalId, " +
            ":afterClientInstanceId, :afterHostId, :afterHostEpoch, :afterScopeId, " +
            ":afterSessionId, :afterTimelineEpoch, :afterAgentEventSeqOrder, " +
            ":afterLifecycleEventId, :afterLifecycleState) ORDER BY n.profileId, " +
            "n.profileActivationGeneration, n.principalId, n.clientInstanceId, n.hostId, " +
            "n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, n.agentEventSeqOrder, " +
            "n.lifecycleEventId, n.lifecycleState " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun notificationGlobalAuditPageAfter(
        afterProfileId: String,
        afterProfileActivationGeneration: Long,
        afterPrincipalId: String,
        afterClientInstanceId: String,
        afterHostId: String,
        afterHostEpoch: String,
        afterScopeId: String,
        afterSessionId: String,
        afterTimelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterLifecycleEventId: String,
        afterLifecycleState: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleGlobalAuditRow>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertNotifications(notifications: List<RelayV2AgentNotificationLedgerEntity>)

    /**
     * Exact destructive-cut primitive. A caller streams at most one local batch, then invokes this
     * CAS for each selected row inside its single Room transaction and verifies every result is 1.
     */
    @Query(
        "DELETE FROM relay_v2_agent_notification_ledger WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleEventId = :lifecycleEventId " +
            "AND lifecycleState = :lifecycleState AND agentEventSeq = :agentEventSeq " +
            "AND agentEventSeqOrder = :agentEventSeqOrder " +
            "AND disposition = :disposition AND localGeneration = :localGeneration " +
            "AND ledgerCanonicalJson = :ledgerCanonicalJson " +
            "AND ledgerCanonicalUtf8Bytes = :ledgerCanonicalUtf8Bytes " +
            "AND ledgerSha256 = :ledgerSha256",
    )
    fun deleteNotificationExact(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleEventId: String,
        lifecycleState: String,
        agentEventSeq: String,
        agentEventSeqOrder: String,
        disposition: String,
        localGeneration: String,
        ledgerCanonicalJson: String,
        ledgerCanonicalUtf8Bytes: Int,
        ledgerSha256: String,
    ): Int

    /**
     * Same-timeline parent advance. The future adapter must require an affected-row count of 1;
     * unlike delete/insert, this preserves every FK-owned L/W/E/N row.
     */
    @Query(
        "UPDATE relay_v2_agent_transcript_lifecycle_states SET " +
            "codecVersion = :newCodecVersion, payloadUtf8Bytes = :newPayloadUtf8Bytes, " +
            "payloadCanonicalJson = :newPayloadCanonicalJson, payloadSha256 = :newPayloadSha256 " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpochKey = :timelineEpoch " +
            "AND codecVersion = :expectedCodecVersion " +
            "AND payloadUtf8Bytes = :expectedPayloadUtf8Bytes " +
            "AND payloadCanonicalJson = :expectedPayloadCanonicalJson " +
            "AND payloadSha256 = :expectedPayloadSha256",
    )
    fun updateConsumerAuthorityExact(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        expectedCodecVersion: Int,
        expectedPayloadUtf8Bytes: Int,
        expectedPayloadCanonicalJson: String,
        expectedPayloadSha256: String,
        newCodecVersion: Int,
        newPayloadUtf8Bytes: Int,
        newPayloadCanonicalJson: String,
        newPayloadSha256: String,
    ): Int

    /** Reserved for an explicit timeline rotation/retire destructive cut. */
    @Query(
        "DELETE FROM relay_v2_agent_transcript_lifecycle_states " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpochKey = :timelineEpoch",
    )
    fun deleteConsumerAuthorityForTimelineRotation(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): Int
}
