package com.tmuxworktree.mobile.core.relay.runtime

import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatImagePart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatRuntimeSettings
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatSteeredMessage
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatTurnView
import java.security.MessageDigest

/**
 * Per-session agent chat state.
 *
 * Turns are host-authoritative: [RelayChatMutation.HistoryResult] replaces the local turn list for a
 * session after reconnect reconciliation. Pending sends are tracked locally until the host confirms
 * them via [RelayChatMutation.Sent] (which assigns a [AgentChatTurnView.turnId]).
 */
data class RelayChatState(
    val turnsBySession: Map<String, List<AgentChatTurnView>> = emptyMap(),
    val pendingBySession: Map<String, List<PendingChatSend>> = emptyMap(),
    /** Host accepted the send, but its authoritative turn event has not arrived yet. */
    val awaitingTurnIdsBySession: Map<String, Set<String>> = emptyMap(),
    val imagesById: Map<String, RelayChatImageState> = emptyMap(),
) {
    fun turns(session: String): List<AgentChatTurnView> = turnsBySession[session].orEmpty()

    fun pending(session: String): List<PendingChatSend> = pendingBySession[session].orEmpty()

    fun awaitingTurn(session: String): Boolean = awaitingTurnIdsBySession[session].orEmpty().isNotEmpty()

    fun image(imageId: String): RelayChatImageState? = imagesById[imageId]
}

data class RelayChatImageState(
    val imageId: String,
    val mimeType: String,
    val byteLength: Int,
    val sha256: String,
    val bytes: ByteArray = byteArrayOf(),
    val complete: Boolean = false,
    val error: String? = null,
)

data class PendingChatSend(
    val requestId: String,
    val session: String,
    val message: String,
    val sentAtMillis: Long,
    val settings: AgentChatRuntimeSettings? = null,
    val failed: Boolean = false,
    val error: String? = null,
    val errorCode: String? = null,
    val retryable: Boolean = true,
)

sealed interface RelayChatMutation {
    data class SendPending(
        val requestId: String,
        val session: String,
        val message: String,
        val nowMillis: Long,
        val settings: AgentChatRuntimeSettings? = null,
    ) : RelayChatMutation

    data class Sent(
        val requestId: String,
        val session: String,
        val turnId: String,
        val nowMillis: Long,
    ) : RelayChatMutation

    data class TurnUpdated(
        val session: String,
        val turn: AgentChatTurnView,
    ) : RelayChatMutation

    data class HistoryResult(
        val session: String,
        val turns: List<AgentChatTurnView>,
    ) : RelayChatMutation

    data class SendFailed(
        val requestId: String,
        val session: String,
        val error: String,
        val errorCode: String? = null,
        val retryable: Boolean = true,
    ) : RelayChatMutation

    data class ImageChunk(
        val session: String,
        val imageId: String,
        val mimeType: String,
        val byteLength: Int,
        val sha256: String,
        val offset: Int,
        val data: ByteArray,
        val nextOffset: Int?,
    ) : RelayChatMutation

    data class ImageFailed(
        val imageId: String,
        val error: String,
    ) : RelayChatMutation

    /**
     * Starts a retry for one exact failed send. The replacement request ID is installed before
     * transport handoff so an immediate response cannot leave the old failed bubble orphaned.
     */
    data class RetryFailed(
        val requestId: String,
        val session: String,
        val replacementRequestId: String,
        val nowMillis: Long,
    ) : RelayChatMutation

    data class ClearSession(val session: String) : RelayChatMutation
}

object RelayChatReducer {
    fun reduce(state: RelayChatState, mutation: RelayChatMutation): RelayChatState = when (mutation) {
        is RelayChatMutation.SendPending -> addPending(state, mutation)
        is RelayChatMutation.Sent -> confirmSent(state, mutation)
        is RelayChatMutation.TurnUpdated -> upsertTurn(state, mutation)
        is RelayChatMutation.HistoryResult -> mergeHistory(state, mutation)
        is RelayChatMutation.SendFailed -> markFailed(state, mutation)
        is RelayChatMutation.ImageChunk -> appendImageChunk(state, mutation)
        is RelayChatMutation.ImageFailed -> markImageFailed(state, mutation)
        is RelayChatMutation.RetryFailed -> retryFailed(state, mutation)
        is RelayChatMutation.ClearSession -> clearSession(state, mutation)
    }

    private fun addPending(state: RelayChatState, mutation: RelayChatMutation.SendPending): RelayChatState {
        val pending = state.pending(mutation.session) + PendingChatSend(
            requestId = mutation.requestId,
            session = mutation.session,
            message = mutation.message,
            sentAtMillis = mutation.nowMillis,
            settings = mutation.settings,
        )
        return state.copy(
            pendingBySession = state.pendingBySession + (mutation.session to pending),
        )
    }

    private fun confirmSent(state: RelayChatState, mutation: RelayChatMutation.Sent): RelayChatState {
        val pending = state.pending(mutation.session)
            .filterNot { it.requestId == mutation.requestId }
        val pendingBySession = if (pending.isEmpty()) {
            state.pendingBySession - mutation.session
        } else {
            state.pendingBySession + (mutation.session to pending)
        }
        // Keep a non-visual fence until the host's authoritative turn arrives. Otherwise the
        // response/event reordering window briefly unlocks runtime settings for an active turn.
        val alreadyProjected = state.turns(mutation.session).any { it.turnId == mutation.turnId }
        val awaiting = if (alreadyProjected) {
            state.awaitingTurnIdsBySession
        } else {
            state.awaitingTurnIdsBySession + (
                mutation.session to (
                    state.awaitingTurnIdsBySession[mutation.session].orEmpty() + mutation.turnId
                )
            )
        }
        return state.copy(
            pendingBySession = pendingBySession,
            awaitingTurnIdsBySession = awaiting,
        )
    }

    private fun upsertTurn(state: RelayChatState, mutation: RelayChatMutation.TurnUpdated): RelayChatState {
        val turns = state.turns(mutation.session).toMutableList()
        val existingIndex = turns.indexOfFirst { it.turnId == mutation.turn.turnId }
        if (existingIndex >= 0) {
            turns[existingIndex] = mutation.turn
        } else {
            turns += mutation.turn
        }
        turns.sortBy { it.sentAt }
        val remainingAwaiting = state.awaitingTurnIdsBySession[mutation.session]
            .orEmpty()
            .minus(mutation.turn.turnId)
        val awaiting = if (remainingAwaiting.isEmpty()) {
            state.awaitingTurnIdsBySession - mutation.session
        } else {
            state.awaitingTurnIdsBySession + (mutation.session to remainingAwaiting)
        }
        return syncImages(state.copy(
            turnsBySession = state.turnsBySession + (mutation.session to turns),
            awaitingTurnIdsBySession = awaiting,
        ))
    }

    /**
     * Host-authoritative history merge. Replaces the local turn list for the session with the host's
     * view, deduplicated by [AgentChatTurnView.turnId]. Pending sends that have not been confirmed by
     * the host are retained so the user can see (and retry) them.
     */
    private fun mergeHistory(state: RelayChatState, mutation: RelayChatMutation.HistoryResult): RelayChatState {
        val deduped = mutation.turns
            .distinctBy { it.turnId }
            .sortedBy { it.sentAt }
        val projectedIds = deduped.mapTo(HashSet()) { it.turnId }
        val remainingAwaiting = state.awaitingTurnIdsBySession[mutation.session]
            .orEmpty()
            .minus(projectedIds)
        val awaiting = if (remainingAwaiting.isEmpty()) {
            state.awaitingTurnIdsBySession - mutation.session
        } else {
            state.awaitingTurnIdsBySession + (mutation.session to remainingAwaiting)
        }
        return syncImages(state.copy(
            turnsBySession = state.turnsBySession + (mutation.session to deduped),
            awaitingTurnIdsBySession = awaiting,
        ))
    }

    private fun markFailed(state: RelayChatState, mutation: RelayChatMutation.SendFailed): RelayChatState {
        val current = state.pending(mutation.session)
        if (current.none { it.requestId == mutation.requestId }) return state
        val pending = current.map { item ->
            if (item.requestId == mutation.requestId) {
                item.copy(
                    failed = true,
                    error = mutation.error,
                    errorCode = mutation.errorCode,
                    retryable = mutation.retryable,
                )
            } else {
                item
            }
        }
        return state.copy(
            pendingBySession = state.pendingBySession + (mutation.session to pending),
        )
    }

    private fun retryFailed(state: RelayChatState, mutation: RelayChatMutation.RetryFailed): RelayChatState {
        val current = state.pending(mutation.session)
        val target = current.singleOrNull {
            it.requestId == mutation.requestId && it.failed && it.retryable
        } ?: return state
        if (mutation.replacementRequestId != mutation.requestId &&
            current.any { it.requestId == mutation.replacementRequestId }
        ) {
            return state
        }
        val pending = current.map { item ->
            if (item === target) {
                item.copy(
                    requestId = mutation.replacementRequestId,
                    sentAtMillis = mutation.nowMillis,
                    failed = false,
                    error = null,
                    errorCode = null,
                    retryable = true,
                )
            } else {
                item
            }
        }
        return state.copy(
            pendingBySession = state.pendingBySession + (mutation.session to pending),
        )
    }

    private fun appendImageChunk(
        state: RelayChatState,
        mutation: RelayChatMutation.ImageChunk,
    ): RelayChatState {
        val current = state.imagesById[mutation.imageId] ?: return state
        val referenced = state.turns(mutation.session).any { turn ->
            turn.content.any { it is AgentChatImagePart && it.imageId == mutation.imageId }
        }
        if (!referenced || current.complete || current.error != null) return state
        if (current.mimeType != mutation.mimeType || current.byteLength != mutation.byteLength ||
            current.sha256 != mutation.sha256 || current.bytes.size != mutation.offset
        ) {
            return state.copy(
                imagesById = state.imagesById + (
                    mutation.imageId to current.copy(error = "Image transfer did not match metadata")
                ),
            )
        }
        val bytes = current.bytes + mutation.data
        val complete = mutation.nextOffset == null
        val validCompletion = !complete || (
            bytes.size == current.byteLength && bytes.sha256() == current.sha256
        )
        val updated = current.copy(
            bytes = bytes,
            complete = complete && validCompletion,
            error = if (validCompletion) null else "Image integrity check failed",
        )
        return state.copy(imagesById = state.imagesById + (mutation.imageId to updated))
    }

    private fun markImageFailed(
        state: RelayChatState,
        mutation: RelayChatMutation.ImageFailed,
    ): RelayChatState {
        val current = state.imagesById[mutation.imageId] ?: return state
        return state.copy(
            imagesById = state.imagesById + (
                mutation.imageId to current.copy(error = mutation.error)
            ),
        )
    }

    private fun syncImages(state: RelayChatState): RelayChatState {
        val metadata = state.turnsBySession.values
            .flatten()
            .flatMap { turn -> turn.content.filterIsInstance<AgentChatImagePart>() }
            .associateBy { it.imageId }
        val images = metadata.mapValues { (imageId, part) ->
            state.imagesById[imageId]
                ?.takeIf {
                    it.mimeType == part.mimeType && it.byteLength == part.byteLength &&
                        it.sha256 == part.sha256
                }
                ?: RelayChatImageState(
                    imageId = imageId,
                    mimeType = part.mimeType,
                    byteLength = part.byteLength,
                    sha256 = part.sha256,
                )
        }
        return state.copy(imagesById = images)
    }

    private fun clearSession(state: RelayChatState, mutation: RelayChatMutation.ClearSession): RelayChatState {
        return syncImages(state.copy(
            turnsBySession = state.turnsBySession - mutation.session,
            pendingBySession = state.pendingBySession - mutation.session,
            awaitingTurnIdsBySession = state.awaitingTurnIdsBySession - mutation.session,
        ))
    }

    private fun ByteArray.sha256(): String = MessageDigest.getInstance("SHA-256")
        .digest(this)
        .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
