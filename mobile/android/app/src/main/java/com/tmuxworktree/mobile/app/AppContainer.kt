package com.tmuxworktree.mobile.app

import android.content.Context
import com.tmuxworktree.mobile.core.data.AndroidKeystoreCredentialStore
import com.tmuxworktree.mobile.core.data.AndroidKeystoreRelayV2CredentialStore
import com.tmuxworktree.mobile.core.data.AndroidKeystoreRelayV2TerminalResumeCredentialStore
import com.tmuxworktree.mobile.core.data.LegacyIdentityImporter
import com.tmuxworktree.mobile.core.data.PreferencesStore
import com.tmuxworktree.mobile.core.data.TwDatabase
import com.tmuxworktree.mobile.core.data.TwRepository
import com.tmuxworktree.mobile.core.network.NetworkMonitor
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableRepository
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecyclePostedNotificationCancellationCoordinator
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AndroidAgentTranscriptLifecycleNotificationPlatform
import com.tmuxworktree.mobile.core.relay.v2.profile.OkHttpRelayV2CredentialExchange
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectBarrier
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshCoordinator
import com.tmuxworktree.mobile.core.relay.v2.runtime.BoundedRelayV2TransportFactory
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ActivationOutboxReadPort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeComposition
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CredentialRolloverPort
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateDatabase
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateRepository
import com.tmuxworktree.mobile.core.relay.v2.state.RoomRelayV2TerminalPostCommitJournalStore
import kotlinx.coroutines.CoroutineScope

/** Process-lifetime profile owners shared by every AppContainer and Activity instance. */
private object AndroidProcessProfileOwners {
    val mutationCoordinator = ProfileMutationCoordinator()
    val refreshCoordinator = RelayV2RefreshCoordinator()
}

class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    val database: TwDatabase by lazy { TwDatabase.get(appContext) }
    val repository: TwRepository by lazy { TwRepository(database) }
    val preferences: PreferencesStore by lazy { PreferencesStore(appContext) }
    val credentials: AndroidKeystoreCredentialStore by lazy {
        AndroidKeystoreCredentialStore(appContext)
    }
    private val relayV2Credentials: AndroidKeystoreRelayV2CredentialStore by lazy {
        AndroidKeystoreRelayV2CredentialStore(appContext)
    }
    private val relayV2StateDatabase: RelayV2StateDatabase by lazy {
        RelayV2StateDatabase.build(appContext)
    }
    private val relayV2StateRepository: RelayV2StateRepository by lazy {
        RelayV2StateRepository(relayV2StateDatabase)
    }
    private val relayV2TerminalJournal by lazy {
        RoomRelayV2TerminalPostCommitJournalStore(relayV2StateDatabase)
    }
    private val relayV2TerminalCredentials by lazy {
        AndroidKeystoreRelayV2TerminalResumeCredentialStore(appContext)
    }
    private val relayV2CredentialExchange by lazy {
        OkHttpRelayV2CredentialExchange()
    }
    private val agentTranscriptLifecycleRepository by lazy {
        AgentTranscriptLifecycleDurableRepository(relayV2StateDatabase)
    }
    private val agentTranscriptLifecycleNotificationPlatform by lazy {
        AndroidAgentTranscriptLifecycleNotificationPlatform(appContext)
    }
    private val agentTranscriptLifecycleNotificationCancellation by lazy {
        AgentTranscriptLifecyclePostedNotificationCancellationCoordinator(
            agentTranscriptLifecycleRepository,
            agentTranscriptLifecycleNotificationPlatform,
        )
    }
    val legacyIdentityImporter: LegacyIdentityImporter by lazy {
        LegacyIdentityImporter(
            context = appContext,
            preferencesStore = preferences,
            credentialStore = credentials,
        )
    }
    val networkMonitor: NetworkMonitor by lazy { NetworkMonitor(appContext) }
    internal val profileMutationCoordinator: ProfileMutationCoordinator
        get() = AndroidProcessProfileOwners.mutationCoordinator

    internal suspend fun createRelayV2ProfileRuntime(
        disconnectBarrier: RelayProfileDisconnectBarrier,
        clearEphemeralAfterDisconnect: suspend (RelayProfileDisconnectReceipt) -> Unit,
    ): RelayV2ProfileRuntimeAdapter = RelayV2ProfileRuntimeAdapter(
        preferencesStore = preferences,
        legacyRepository = repository,
        legacyCredentialStore = credentials,
        relayV2CredentialStore = relayV2Credentials,
        relayV2StateRepository = { relayV2StateRepository },
        terminalResumeCredentialStore = relayV2TerminalCredentials,
        clientInstanceId = preferences.getOrCreateRelayV2ClientInstanceId(),
        credentialExchange = relayV2CredentialExchange,
        selfRevokeExchange = relayV2CredentialExchange,
        refreshCoordinator = AndroidProcessProfileOwners.refreshCoordinator,
        profileMutationCoordinator = AndroidProcessProfileOwners.mutationCoordinator,
        disconnectBarrier = disconnectBarrier,
        cancelAgentNotificationsAfterDisconnect = { profile ->
            agentTranscriptLifecycleNotificationCancellation.cancelAfterDisconnect(
                profile.profileId,
                profile.activationGeneration,
            )
        },
        clearEphemeralAfterDisconnect = clearEphemeralAfterDisconnect,
    )

    internal fun createRelayV2BaseRuntimeComposition(
        parentScope: CoroutineScope,
        profile: RelayV2Profile,
        credentialRollover: RelayV2CredentialRolloverPort,
    ): RelayV2BaseRuntimeComposition = RelayV2BaseRuntimeComposition(
        parentScope = parentScope,
        profile = profile,
        credentialStore = relayV2Credentials,
        credentialRollover = credentialRollover,
        stateSyncAuthority = relayV2StateRepository,
        terminalRuntimeAuthority = relayV2StateRepository,
        terminalPostCommitJournal = relayV2TerminalJournal,
        terminalResumeCredentials = relayV2TerminalCredentials,
        materializedSessions = relayV2StateRepository,
        activationOutbox = RelayV2ActivationOutboxReadPort(
            relayV2StateRepository::readActivationOutbox,
        ),
        outboxAuthority = relayV2StateRepository,
        outboxEnqueueAuthority = relayV2StateRepository,
        agentDurableRepository = agentTranscriptLifecycleRepository,
        agentNotificationPlatform = agentTranscriptLifecycleNotificationPlatform,
        agentOptionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
        transportFactory = BoundedRelayV2TransportFactory(),
    )
}
