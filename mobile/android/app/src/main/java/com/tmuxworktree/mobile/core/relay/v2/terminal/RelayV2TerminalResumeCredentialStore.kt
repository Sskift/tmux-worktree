package com.tmuxworktree.mobile.core.relay.v2.terminal

internal data class RelayV2TerminalResumeCredentialInstall(
    val fingerprint: String,
    val created: Boolean,
)

/** Exact non-secret activation owner for one encrypted terminal credential reference. */
internal data class RelayV2TerminalResumeCredentialOwner(
    val profileId: String,
    val profileActivationGeneration: Long,
) {
    init {
        require(profileId.isNotBlank())
        require(profileActivationGeneration > 0)
    }
}

internal data class RelayV2TerminalIndexedCredentialReferences(
    val owner: RelayV2TerminalResumeCredentialOwner,
    val indexKey: String,
    val references: Set<String>,
)

/** Pure grammar/retention owner for the non-sensitive encrypted-reference index. */
internal class RelayV2TerminalCredentialReferenceIndex(
    private val digest: (String) -> String,
    private val maxReferencesPerActivation: Int = 64,
    private val maxIndexesPerProfile: Int = 256,
) {
    fun key(owner: RelayV2TerminalResumeCredentialOwner): String =
        prefix(owner.profileId) + owner.profileActivationGeneration

    fun entryKey(owner: RelayV2TerminalResumeCredentialOwner, reference: String): String =
        "terminal_" + digest(
            listOf(
                owner.profileId,
                owner.profileActivationGeneration.toString(),
                reference,
            ).joinToString("\u0000"),
        )

    fun references(value: Any?): Set<String> {
        if (value == null) return emptySet()
        val raw = value as? Set<*> ?: error("Relay v2 terminal credential index is unreadable")
        check(raw.size <= maxReferencesPerActivation) {
            "Relay v2 terminal credential index is over limit"
        }
        return raw.mapTo(linkedSetOf()) { entry ->
            (entry as? String)?.takeIf { it.isNotBlank() && it.toByteArray().size <= 256 }
                ?: error("Relay v2 terminal credential index is unreadable")
        }
    }

    fun clearPlan(
        profileId: String,
        throughActivationGeneration: Long,
        values: Map<String, *>,
    ): List<RelayV2TerminalIndexedCredentialReferences> {
        require(profileId.isNotBlank() && throughActivationGeneration > 0)
        val prefix = prefix(profileId)
        val keys = values.keys.filter { it.startsWith(prefix) }
        check(keys.size <= maxIndexesPerProfile) {
            "Relay v2 terminal credential profile index is over limit"
        }
        return keys.mapNotNull { key ->
            val generation = key.removePrefix(prefix).toLongOrNull()
                ?: error("Relay v2 terminal credential index is unreadable")
            if (generation > throughActivationGeneration) null
            else RelayV2TerminalIndexedCredentialReferences(
                RelayV2TerminalResumeCredentialOwner(profileId, generation),
                key,
                references(values[key]),
            )
        }
    }

    private fun prefix(profileId: String): String = "terminal_index_${digest(profileId)}_"
}

/** Secret owner for host-issued terminal resume tokens; Room stores only reference + fingerprint. */
internal interface RelayV2TerminalResumeCredentialStore {
    fun installExact(
        owner: RelayV2TerminalResumeCredentialOwner,
        reference: String,
        resumeToken: String,
    ): RelayV2TerminalResumeCredentialInstall?

    fun read(owner: RelayV2TerminalResumeCredentialOwner, reference: String): String?

    fun clear(owner: RelayV2TerminalResumeCredentialOwner, reference: String)

    /** Atomically removes all indexed terminal tokens through the fenced activation. */
    fun clearProfile(profileId: String, throughActivationGeneration: Long)
}
