package com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2

data class AgentChatTurnView(
    val turnId: String,
    val session: String,
    val userMessage: String,
    val status: String,
    val content: List<AgentChatContentPart> = emptyList(),
    val progress: List<AgentChatProgressStep> = emptyList(),
    val error: String? = null,
    val sentAt: String,
    val completedAt: String? = null,
    val steeredMessages: List<AgentChatSteeredMessage> = emptyList(),
)

sealed interface AgentChatContentPart

data class AgentChatMarkdownPart(
    val text: String,
) : AgentChatContentPart

data class AgentChatProgressStep(
    val stepId: String,
    val kind: String,
    val title: String,
    val status: String,
)

data class AgentChatImagePart(
    val imageId: String,
    val mimeType: String,
    val altText: String,
    val byteLength: Int,
    val sha256: String,
) : AgentChatContentPart

data class AgentChatSteeredMessage(
    val message: String,
    val sentAt: String,
)

/** Runtime overrides applied when Codex starts the next, idle turn. */
data class AgentChatRuntimeSettings(
    val model: String? = null,
    val reasoningEffort: String? = null,
    val mode: String = "default",
)

/** Exact Host observation for whether one Session can apply Codex runtime overrides. */
data class AgentChatRuntimeSettingsStatus(
    val available: Boolean,
    val provider: String?,
    val reason: String,
)

fun AgentChatRuntimeSettingsStatus?.runtimeSettingsUnavailableMessage(): String = when (this?.reason) {
    "agent_unsupported" -> "This Session is not running a supported Agent."
    "provider_unsupported" ->
        "Model, effort and mode controls are available only for Codex Sessions."
    "target_update_required" ->
        "Update TW on the computer that owns this Session, then reconnect."
    "temporarily_unavailable" ->
        "The Host could not verify runtime controls for this Session. Reconnect and try again."
    else -> "The Host has not verified runtime controls for this Session yet."
}
