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
