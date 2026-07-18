package com.tmuxworktree.mobile.core.relay.v2.profile

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import com.tmuxworktree.mobile.core.data.PreferencesRelayV2ProfileStore
import com.tmuxworktree.mobile.core.data.PreferencesStore
import com.tmuxworktree.mobile.core.data.RelayProfilePreferencesCodec
import com.tmuxworktree.mobile.core.data.RelayV2CredentialBlobCodec
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2ProfileRepositoryTest {
    @Test
    fun `profile preferences persist stable tags and v1 owner cannot replace active v2`() {
        val empty = mutablePreferencesOf()
        assertTrue(
            runCatching {
                RelayProfilePreferencesCodec.saveRelayV1Profile(
                    preferences = empty,
                    relayUrl = "  ",
                    hostId = "legacy-host",
                    autoConnect = true,
                )
            }.isFailure,
        )
        assertTrue(empty.asMap().isEmpty())

        val preferences = mutablePreferencesOf()
        preferences[stringPreferencesKey("relay_url")] = "wss://legacy.example.com/client"

        assertEquals(
            RelayProfileDialect.V1,
            RelayProfilePreferencesCodec.activeProfileIdentity(preferences)?.dialect,
        )
        assertEquals(null, RelayProfilePreferencesCodec.toRelayV2Profile(preferences))

        RelayProfilePreferencesCodec.saveRelayV1Profile(
            preferences = preferences,
            relayUrl = "wss://legacy.example.com/client/",
            hostId = "legacy-host",
            autoConnect = true,
        )
        assertEquals(
            "tw-relay.v1",
            preferences.valueNamed("relay_active_profile_dialect"),
        )
        assertEquals(
            "legacy_shared_secret",
            preferences.valueNamed("relay_active_credential_kind"),
        )

        val v2Profile = relayV2Profile()
        RelayProfilePreferencesCodec.activateRelayV2Profile(preferences, v2Profile)
        assertEquals(
            "tw-relay.v2",
            preferences.valueNamed("relay_active_profile_dialect"),
        )
        assertEquals(
            "twcap2_grant",
            preferences.valueNamed("relay_active_credential_kind"),
        )
        assertEquals(
            v2Profile.identity,
            RelayProfilePreferencesCodec.activeProfileIdentity(preferences),
        )
        assertEquals(v2Profile, RelayProfilePreferencesCodec.toRelayV2Profile(preferences))

        val activeV2Snapshot = preferences.namedValues()
        assertTrue(
            runCatching {
                RelayProfilePreferencesCodec.saveRelayV1Profile(
                    preferences,
                    "wss://replacement.example.com/client",
                    "replacement-host",
                    false,
                )
            }.isFailure,
        )
        assertTrue(
            runCatching { RelayProfilePreferencesCodec.clearRelayV1Profile(preferences) }.isFailure,
        )
        assertEquals(activeV2Snapshot, preferences.namedValues())

        preferences[stringPreferencesKey("relay_active_profile_dialect")] = "tw-relay.future"
        assertTrue(
            runCatching {
                RelayProfilePreferencesCodec.activeProfileIdentity(preferences)
            }.isFailure,
        )
        assertTrue(
            runCatching { RelayProfilePreferencesCodec.toRelayV2Profile(preferences) }.isFailure,
        )
        preferences[stringPreferencesKey("relay_active_profile_dialect")] = "tw-relay.v2"
        preferences[stringPreferencesKey("relay_active_credential_kind")] = "credential.future"
        assertTrue(
            runCatching { RelayProfilePreferencesCodec.toRelayV2Profile(preferences) }.isFailure,
        )
    }

    @Test
    fun `credential blob codec uses frozen pending tags and rejects unknown tag`() {
        val exchangeBlob = RelayV2CredentialBlob(
            credentialVersion = 0,
            issuerUrl = "https://relay.example.com",
            relayUrl = "wss://relay.example.com/client",
            hostId = "mac-admin",
            clientInstanceId = "android-install-1",
            pendingAttempt = RelayV2PendingCredentialAttempt(
                kind = RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE,
                attemptId = "exchange-1",
                oldCredentialVersion = 0,
                secretReference = "enrollment-secret-1",
                secret = ENROLLMENT_CODE,
                enrollmentId = "enrollment-1",
            ),
        )
        val refreshBlob = RelayV2CredentialBlob(
            credentialVersion = 1,
            issuerUrl = "https://relay.example.com",
            relayUrl = "wss://relay.example.com/client",
            hostId = "mac-admin",
            clientInstanceId = "android-install-1",
            principalId = "principal-1",
            grantId = "grant-1",
            accessToken = ACCESS_TOKEN_1,
            accessExpiresAtMs = 2_000,
            refreshToken = REFRESH_TOKEN_1,
            refreshExpiresAtMs = 3_000,
            pendingAttempt = RelayV2PendingCredentialAttempt(
                kind = RelayV2CredentialAttemptKind.REFRESH,
                attemptId = "refresh-1",
                oldCredentialVersion = 1,
                secretReference = "refresh-secret-1",
                secret = REFRESH_TOKEN_1,
            ),
            completedAttemptId = "exchange-completed-1",
            completedSecretReference = "enrollment-secret-completed-1",
        )

        val exchangeBytes = RelayV2CredentialBlobCodec.encode(exchangeBlob)
        val refreshBytes = RelayV2CredentialBlobCodec.encode(refreshBlob)
        assertEquals(1, readPendingKindTag(exchangeBytes))
        assertEquals(2, readPendingKindTag(refreshBytes))
        assertEquals(
            RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE,
            RelayV2CredentialBlobCodec.decode(exchangeBytes).pendingAttempt?.kind,
        )
        assertEquals(
            RelayV2CredentialAttemptKind.REFRESH,
            RelayV2CredentialBlobCodec.decode(refreshBytes).pendingAttempt?.kind,
        )
        assertEquals(refreshBlob, RelayV2CredentialBlobCodec.decode(refreshBytes))
        val reopenedCredential = Files.createTempFile("relay-v2-credential", ".blob")
        try {
            Files.write(reopenedCredential, refreshBytes)
            assertEquals(
                refreshBlob,
                RelayV2CredentialBlobCodec.decode(Files.readAllBytes(reopenedCredential)),
            )
        } finally {
            Files.deleteIfExists(reopenedCredential)
        }
        val legacyBlob = exchangeBlob.copy(
            schemaVersion = RelayV2CredentialBlob.LEGACY_SCHEMA_VERSION,
        )
        assertEquals(
            legacyBlob,
            RelayV2CredentialBlobCodec.decode(RelayV2CredentialBlobCodec.encode(legacyBlob)),
        )
        val legacyCompletedBlob = refreshBlob.copy(
            schemaVersion = RelayV2CredentialBlob.LEGACY_SCHEMA_VERSION,
            pendingAttempt = null,
            completedAttemptId = null,
            completedSecretReference = null,
        )
        assertEquals(
            legacyCompletedBlob,
            RelayV2CredentialBlobCodec.decode(
                RelayV2CredentialBlobCodec.encode(legacyCompletedBlob),
            ),
        )

        val unknownTag = exchangeBytes.copyOf()
        ByteBuffer.wrap(unknownTag).putInt(pendingKindOffset(unknownTag), 99)
        assertTrue(runCatching { RelayV2CredentialBlobCodec.decode(unknownTag) }.isFailure)
    }

    @Test
    fun `activation journal codec reopens exact proof and authoritative IO fails closed`() =
        runBlocking {
            val directory = Files.createTempDirectory("relay-v2-activation-journal")
            val file = directory.resolve("preferences.preferences_pb").toFile()
            val target = relayV2Profile()
            lateinit var prepared: RelayV2ProfileActivationJournal
            withPreferencesStore(file) { preferences ->
                val store = PreferencesRelayV2ProfileStore(preferences)
                assertEquals(
                    null,
                    store.prepareRelayV2Activation(
                        expectedActiveProfile = RelayActiveProfileIdentity(
                            profileId = "vanished-before-prepare",
                            dialect = RelayProfileDialect.V1,
                            activationGeneration = 3,
                        ),
                        operationId = "activation-active-cas-race",
                        profile = target,
                        targetBindingDigest = "binding-active-cas-race",
                        targetCredentialAttemptId = "attempt-active-cas-race",
                        targetCredentialSecretReference = "secret-active-cas-race",
                        barrierId = "barrier-active-cas-race",
                        previousCredentialReference = null,
                    ),
                )
                assertEquals(null, store.pendingRelayV2Activation())
                preferences.saveProfile(
                    relayUrl = "wss://legacy.example.com/client",
                    hostId = "legacy-host",
                    autoConnect = true,
                )
                val previous = requireNotNull(store.activeProfileIdentity())
                prepared = requireNotNull(
                    store.prepareRelayV2Activation(
                        expectedActiveProfile = previous,
                        operationId = "activation-reopen-1",
                        profile = target,
                        targetBindingDigest = "binding-digest-1",
                        targetCredentialAttemptId = "attempt-reopen-1",
                        targetCredentialSecretReference = "secret-reference-reopen-1",
                        barrierId = "barrier-reopen-1",
                        previousCredentialReference = null,
                    ),
                )
                assertEquals(previous, store.activeProfileIdentity())
            }

            lateinit var ready: RelayV2ProfileActivationJournal
            withPreferencesStore(file) { preferences ->
                val store = PreferencesRelayV2ProfileStore(preferences)
                assertEquals(prepared, store.pendingRelayV2Activation())
                assertEquals(prepared.previousProfile, store.activeProfileIdentity())
                assertEquals(
                    prepared,
                    store.prepareRelayV2Activation(
                        expectedActiveProfile = prepared.previousProfile,
                        operationId = prepared.operationId,
                        profile = target,
                        targetBindingDigest = prepared.targetBindingDigest,
                        targetCredentialAttemptId = prepared.targetCredentialAttemptId,
                        targetCredentialSecretReference =
                            prepared.targetCredentialSecretReference,
                        barrierId = prepared.barrierId,
                        previousCredentialReference = prepared.previousCredentialReference,
                    ),
                )
                assertEquals(
                    null,
                    store.prepareRelayV2Activation(
                        expectedActiveProfile = prepared.previousProfile,
                        operationId = "activation-overwrite-rejected",
                        profile = target.copy(profileId = "different-target-profile"),
                        targetBindingDigest = "different-binding",
                        targetCredentialAttemptId = "different-attempt",
                        targetCredentialSecretReference = "different-secret-reference",
                        barrierId = "different-barrier",
                        previousCredentialReference = null,
                    ),
                )
                assertEquals(prepared, store.pendingRelayV2Activation())
                val connectionWatcher = async { preferences.values.take(2).toList() }
                yield()
                assertV1ProfileMutationsRejected(preferences)
                assertEquals(
                    "wss://legacy.example.com/client",
                    preferences.values.first().relayUrl,
                )
                assertEquals("legacy-host", preferences.values.first().preferredHostId)
                assertTrue(preferences.values.first().autoConnect)
                val proof = RelayV2CompletedCredentialProof(
                    credentialReference = target.credentialReference,
                    credentialVersion = target.credentialVersion + 1,
                    bindingDigest = prepared.targetBindingDigest,
                    completedAttemptId = prepared.targetCredentialAttemptId,
                    completedSecretReference = prepared.targetCredentialSecretReference,
                )
                listOf(
                    proof.copy(credentialReference = RelayV2CredentialReference("wrong-reference")),
                    proof.copy(credentialVersion = target.credentialVersion - 1),
                    proof.copy(bindingDigest = "wrong-binding"),
                    proof.copy(completedAttemptId = "wrong-attempt"),
                    proof.copy(completedSecretReference = "wrong-secret-reference"),
                ).forEach { mismatched ->
                    assertEquals(
                        null,
                        store.markRelayV2CredentialReady(prepared.operationId, mismatched),
                    )
                    assertEquals(prepared, store.pendingRelayV2Activation())
                }
                ready = requireNotNull(
                    store.markRelayV2CredentialReady(prepared.operationId, proof),
                )
                val observed = withTimeout(1_000) { connectionWatcher.await() }
                assertEquals("wss://legacy.example.com/client", observed.first().relayUrl)
                assertEquals("legacy-host", observed.first().preferredHostId)
                assertTrue(observed.first().autoConnect)
                assertEquals("", observed.last().relayUrl)
                assertEquals("", observed.last().preferredHostId)
                assertEquals("local", observed.last().preferredScopeId)
                assertFalse(observed.last().autoConnect)
                assertEquals(RelayV2ProfileActivationPhase.CREDENTIAL_READY, ready.phase)
                assertEquals(null, store.activeProfileIdentity())
                assertEquals("", preferences.profile.first().relayUrl)
                assertV1ProfileMutationsRejected(preferences)
            }

            withPreferencesStore(file) { preferences ->
                val store = PreferencesRelayV2ProfileStore(preferences)
                assertEquals(ready, store.pendingRelayV2Activation())
                assertEquals(null, store.activeRelayV2Profile())
                val activated = requireNotNull(
                    store.activateRelayV2Profile(
                        ready,
                        target.copy(credentialVersion = ready.targetCredentialVersion),
                    ),
                )
                assertEquals(ready.targetCredentialSecretReference, "secret-reference-reopen-1")
                assertEquals(activated, store.activeRelayV2Profile())
            }
            withPreferencesStore(file) { preferences ->
                val store = PreferencesRelayV2ProfileStore(preferences)
                assertEquals(null, store.pendingRelayV2Activation())
                assertEquals(target.profileId, store.activeRelayV2Profile()?.profileId)
            }

            val ioFailure = IOException("authoritative DataStore is unreadable")
            val failingPreferences = PreferencesStore(object : DataStore<Preferences> {
                override val data: Flow<Preferences> = flow { throw ioFailure }
                override suspend fun updateData(
                    transform: suspend (t: Preferences) -> Preferences,
                ): Preferences = throw ioFailure
            })
            assertSame(
                ioFailure,
                runCatching { failingPreferences.pendingRelayV2Activation() }.exceptionOrNull(),
            )
            assertSame(
                ioFailure,
                runCatching { failingPreferences.activeProfileIdentity() }.exceptionOrNull(),
            )
            assertSame(
                ioFailure,
                runCatching { failingPreferences.values.first() }.exceptionOrNull(),
            )
            directory.toFile().deleteRecursively()
            Unit
        }

    @Test
    fun `legacy completed credential requires safe reenrollment without deleting active blob`() =
        runBlocking {
            val harness = Harness()
            val gate = harness.exchange.deferEnrollment("enrollment-legacy-completed")
            val confirmed = enrollmentDraft(
                "enrollment-legacy-completed",
                "twenroll2.code-legacy-completed",
            ).confirm(deviceLabel = "Legacy Pixel")
            val first = async { harness.repository.confirmEnrollment(confirmed) }
            val request = gate.request.await()
            assertTrue(harness.repository.cancelPendingEnrollment(confirmed))
            val response = enrollmentResponse(request, "legacy-completed")
            gate.response.complete(response)
            assertTrue(first.await() is RelayV2EnrollmentResult.Superseded)

            val (reference, pending) = harness.credentials.entries().entries.single()
            val legacyCompleted = pending.copy(
                schemaVersion = RelayV2CredentialBlob.LEGACY_SCHEMA_VERSION,
                credentialVersion = 1,
                principalId = response.principalId,
                grantId = response.grantId,
                accessToken = response.accessToken,
                accessExpiresAtMs = response.accessExpiresAtMs,
                refreshToken = response.refreshToken,
                refreshExpiresAtMs = response.refreshExpiresAtMs,
                pendingAttempt = null,
                completedAttemptId = null,
                completedSecretReference = null,
            )
            assertEquals(
                RelayV2CredentialCasResult.Updated(1),
                harness.credentials.compareAndSet(
                    reference,
                    pending.expectation(),
                    legacyCompleted,
                ),
            )
            val activeLegacy = RelayV2Profile(
                profileId = "legacy-completed-active",
                issuerUrl = legacyCompleted.issuerUrl,
                relayUrl = legacyCompleted.relayUrl,
                hostId = legacyCompleted.hostId,
                principalId = requireNotNull(legacyCompleted.principalId),
                grantId = requireNotNull(legacyCompleted.grantId),
                clientInstanceId = legacyCompleted.clientInstanceId,
                credentialReference = reference,
                credentialVersion = legacyCompleted.credentialVersion,
                activationGeneration = 7,
            )
            assertEquals(
                activeLegacy,
                harness.profiles.forceActivateRelayV2Profile(
                    expectedActiveProfile = harness.profiles.activeIdentity,
                    profile = activeLegacy,
                ),
            )
            val activationCount = harness.profiles.activationCount
            val redeemCalls = harness.exchange.redeemCalls
            harness.restartRepository()

            assertEquals(
                RelayV2EnrollmentResult.RecoveryRequired(
                    reference,
                    RelayV2CredentialRecoveryReason
                        .INCOMPATIBLE_LEGACY_COMPLETED_CREDENTIAL,
                ),
                harness.repository.confirmEnrollment(confirmed),
            )
            assertEquals(legacyCompleted, harness.credentials.read(reference))
            assertEquals(activeLegacy, harness.profiles.activeV2)
            assertEquals(activationCount, harness.profiles.activationCount)
            assertEquals(redeemCalls, harness.exchange.redeemCalls)
            assertEquals(null, harness.profiles.journal)
        }

    @Test
    fun `enrollment is review only until confirmation and activation waits for disconnect barrier`() =
        runBlocking {
            val harness = Harness(blockDisconnect = true)
            val draft = enrollmentDraft()

            assertEquals(0, harness.exchange.redeemCalls)
            assertEquals(RelayProfileDialect.V1, harness.profiles.activeIdentity?.dialect)
            assertTrue(harness.credentials.isEmpty())

            val activation = async {
                harness.repository.confirmEnrollment(draft.confirm(deviceLabel = "Pixel"))
            }
            harness.barrier.started.await()

            assertEquals(1, harness.exchange.redeemCalls)
            assertEquals(RelayProfileDialect.V1, harness.profiles.activeIdentity?.dialect)
            assertEquals(0, harness.profiles.activationCount)
            assertFalse(harness.credentials.values().single().hasCredentialMaterial)

            harness.barrier.release.complete(Unit)
            val result = activation.await() as RelayV2EnrollmentResult.Activated
            val profile = result.profile

            assertEquals(RelayV2CredentialKind.TW_CAP2_GRANT, profile.credentialKind)
            assertEquals(RelayV2Profile.RELAY_V2_SUBPROTOCOL, profile.offeredSubprotocol)
            assertFalse(profile.autoConnect)
            assertEquals(
                listOf(
                    "exchange",
                    "disconnect:start",
                    "disconnect:end",
                    "credential:ready",
                    "clear",
                    "activate",
                ),
                harness.events,
            )
            assertSame(harness.barrier.returnedReceipt, harness.isolationReceipts.single())

            val nonSensitivePersistence = harness.profiles.persistedValues.values.joinToString("|")
            assertFalse(nonSensitivePersistence.contains(ENROLLMENT_CODE))
            assertFalse(nonSensitivePersistence.contains(ACCESS_TOKEN_1))
            assertFalse(nonSensitivePersistence.contains(REFRESH_TOKEN_1))
            val secureBlob = harness.credentials.read(profile.credentialReference)
            assertEquals(ACCESS_TOKEN_1, secureBlob?.accessToken)
            assertEquals(REFRESH_TOKEN_1, secureBlob?.refreshToken)
        }

    @Test
    fun `startup admission recovers a completed journal then reconciles the exact winner`() =
        runBlocking {
            val harness = Harness()
            val confirmed = enrollmentDraft(
                "enrollment-startup-completed",
                "twenroll2.code-startup-completed",
            ).confirm(deviceLabel = "Pixel")
            harness.profiles.failNextCredentialReadyBeforeWrite = true

            assertTrue(runCatching { harness.repository.confirmEnrollment(confirmed) }.isFailure)
            val journal = requireNotNull(harness.profiles.journal)
            assertEquals(RelayV2ProfileActivationPhase.PREPARED, journal.phase)
            assertTrue(
                requireNotNull(harness.credentials.read(journal.targetCredentialReference))
                    .hasCredentialMaterial,
            )
            val redeemCalls = harness.exchange.redeemCalls
            harness.restartRepository()

            val ready = harness.repository.admitStartup()
                as RelayV2StartupAdmissionResult.Ready

            assertEquals(journal.targetCredentialReference, ready.profile.credentialReference)
            assertEquals(journal.targetActivationGeneration, ready.profile.activationGeneration)
            assertEquals(journal.targetCredentialVersion, ready.profile.credentialVersion)
            assertEquals(ready.profile, harness.profiles.activeV2)
            assertEquals(null, harness.profiles.journal)
            assertEquals(redeemCalls, harness.exchange.redeemCalls)
        }

    @Test
    fun `startup admission closes pending and incompatible recovery without exchange`() =
        runBlocking {
            val pending = Harness()
            val pendingConfirmation = enrollmentDraft(
                "enrollment-startup-pending",
                "twenroll2.code-startup-pending",
            ).confirm(deviceLabel = "Pending Pixel")
            pending.credentials.failNextCasBeforeWriteCount = 2
            assertTrue(
                runCatching {
                    pending.repository.confirmEnrollment(pendingConfirmation)
                }.isFailure,
            )
            val pendingJournal = requireNotNull(pending.profiles.journal)
            val pendingRedeemCalls = pending.exchange.redeemCalls
            pending.restartRepository()

            assertEquals(
                RelayV2StartupAdmissionResult.ReenrollmentRequired(
                    pendingJournal.targetCredentialReference,
                ),
                pending.repository.admitStartup(),
            )
            assertEquals(null, pending.profiles.journal)
            assertEquals(pendingRedeemCalls, pending.exchange.redeemCalls)

            val incompatibleCases = listOf(
                RelayV2CredentialRecoveryReason.INCOMPATIBLE_LEGACY_COMPLETED_CREDENTIAL to
                    { blob: RelayV2CredentialBlob ->
                        blob.copy(
                            schemaVersion = RelayV2CredentialBlob.LEGACY_SCHEMA_VERSION,
                            completedAttemptId = null,
                            completedSecretReference = null,
                        )
                    },
                RelayV2CredentialRecoveryReason.COMPLETION_PROOF_MISSING_OR_MISMATCHED to
                    { blob: RelayV2CredentialBlob ->
                        blob.copy(
                            completedAttemptId = null,
                            completedSecretReference = null,
                        )
                    },
            )
            incompatibleCases.forEachIndexed { index, (reason, corrupt) ->
                val harness = Harness()
                val confirmed = enrollmentDraft(
                    "enrollment-startup-incompatible-$index",
                    "twenroll2.code-startup-incompatible-$index",
                ).confirm(deviceLabel = "Incompatible Pixel $index")
                harness.profiles.failNextCredentialReadyBeforeWrite = true
                assertTrue(
                    runCatching { harness.repository.confirmEnrollment(confirmed) }.isFailure,
                )
                val journal = requireNotNull(harness.profiles.journal)
                val completed = requireNotNull(
                    harness.credentials.read(journal.targetCredentialReference),
                )
                assertEquals(
                    RelayV2CredentialCasResult.Updated(completed.credentialVersion),
                    harness.credentials.compareAndSet(
                        journal.targetCredentialReference,
                        completed.expectation(),
                        corrupt(completed),
                    ),
                )
                val redeemCalls = harness.exchange.redeemCalls
                harness.restartRepository()

                assertEquals(
                    RelayV2StartupAdmissionResult.RecoveryRequired(
                        credentialReference = journal.targetCredentialReference,
                        reason = reason,
                    ),
                    harness.repository.admitStartup(),
                )
                assertEquals(journal, harness.profiles.journal)
                assertEquals(redeemCalls, harness.exchange.redeemCalls)
            }
        }

    @Test
    fun `startup admission repairs only monotonic credential state and types unavailability`() =
        runBlocking {
            val inactive = Harness()
            assertEquals(
                RelayV2StartupAdmissionResult.NoActiveProfile,
                inactive.repository.admitStartup(),
            )
            assertEquals(0, inactive.exchange.redeemCalls)

            val ahead = Harness()
            val aheadActivation = ahead.repository.confirmEnrollment(
                enrollmentDraft(
                    "enrollment-startup-ahead",
                    "twenroll2.code-startup-ahead",
                ).confirm(deviceLabel = "Ahead Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val versionOne = requireNotNull(
                ahead.credentials.read(aheadActivation.profile.credentialReference),
            )
            assertEquals(
                RelayV2CredentialCasResult.Updated(2),
                ahead.credentials.compareAndSet(
                    aheadActivation.profile.credentialReference,
                    versionOne.expectation(),
                    versionOne.copy(credentialVersion = 2),
                ),
            )
            val aheadRedeemCalls = ahead.exchange.redeemCalls
            val repaired = aheadActivation.profile.copy(credentialVersion = 2)
            assertEquals(
                RelayV2StartupAdmissionResult.Ready(repaired),
                ahead.repository.admitStartup(),
            )
            assertEquals(repaired, ahead.profiles.activeV2)
            assertEquals(aheadRedeemCalls, ahead.exchange.redeemCalls)

            StartupUnavailableCase.entries.forEach { unavailableCase ->
                val harness = Harness()
                val activated = harness.repository.confirmEnrollment(
                    enrollmentDraft(
                        "enrollment-startup-${unavailableCase.name.lowercase()}",
                        "twenroll2.code-startup-${unavailableCase.name.lowercase()}",
                    ).confirm(deviceLabel = "Unavailable Pixel"),
                ) as RelayV2EnrollmentResult.Activated
                val reference = activated.profile.credentialReference
                val blob = requireNotNull(harness.credentials.read(reference))
                val expectedReason = when (unavailableCase) {
                    StartupUnavailableCase.MISSING -> {
                        harness.credentials.clear(reference)
                        RelayV2StartupCredentialUnavailableReason.CREDENTIAL_MISSING
                    }
                    StartupUnavailableCase.BINDING_MISMATCH -> {
                        assertEquals(
                            RelayV2CredentialCasResult.Updated(blob.credentialVersion),
                            harness.credentials.compareAndSet(
                                reference,
                                blob.expectation(),
                                blob.copy(hostId = "different-host"),
                            ),
                        )
                        RelayV2StartupCredentialUnavailableReason.BINDING_MISMATCH
                    }
                    StartupUnavailableCase.BLOB_BEHIND -> {
                        assertTrue(
                            harness.profiles.updateRelayV2CredentialVersion(
                                profileId = activated.profile.profileId,
                                credentialReference = reference,
                                expectedActivationGeneration =
                                    activated.profile.activationGeneration,
                                expectedVersion = activated.profile.credentialVersion,
                                newVersion = activated.profile.credentialVersion + 1,
                            ),
                        )
                        RelayV2StartupCredentialUnavailableReason
                            .CREDENTIAL_BLOB_BEHIND_PROFILE
                    }
                    StartupUnavailableCase.REPAIR_CONFLICT -> {
                        assertEquals(
                            RelayV2CredentialCasResult.Updated(blob.credentialVersion + 1),
                            harness.credentials.compareAndSet(
                                reference,
                                blob.expectation(),
                                blob.copy(credentialVersion = blob.credentialVersion + 1),
                            ),
                        )
                        harness.profiles.failNextCredentialVersionUpdate = true
                        RelayV2StartupCredentialUnavailableReason.REPAIR_CONFLICT
                    }
                }
                val durableWinner = requireNotNull(harness.profiles.activeV2)
                val redeemCalls = harness.exchange.redeemCalls

                assertEquals(
                    RelayV2StartupAdmissionResult.CredentialUnavailable(
                        profile = durableWinner,
                        reason = expectedReason,
                    ),
                    harness.repository.admitStartup(),
                )
                assertEquals(redeemCalls, harness.exchange.redeemCalls)
            }
        }

    @Test
    fun `startup admission waits for a live switch and exposes only its durable winner`() =
        runBlocking {
            val harness = Harness(blockDisconnect = true)
            val confirmed = enrollmentDraft(
                "enrollment-live-recovery",
                "twenroll2.code-live-recovery",
            ).confirm(deviceLabel = "Pixel")
            val activation = async { harness.repository.confirmEnrollment(confirmed) }
            harness.barrier.started.await()

            val prepared = requireNotNull(harness.profiles.journal)
            assertEquals(RelayV2ProfileActivationPhase.PREPARED, prepared.phase)
            assertFalse(
                requireNotNull(harness.credentials.read(prepared.targetCredentialReference))
                    .hasCredentialMaterial,
            )
            val redeemCalls = harness.exchange.redeemCalls
            val admission = async { harness.repository.admitStartup() }
            yield()
            assertFalse(admission.isCompleted)

            harness.barrier.release.complete(Unit)
            val activated = (activation.await() as RelayV2EnrollmentResult.Activated).profile
            assertEquals(
                RelayV2StartupAdmissionResult.Ready(activated),
                admission.await(),
            )
            assertEquals(activated, harness.profiles.activeV2)
            assertEquals(null, harness.profiles.journal)
            assertEquals(redeemCalls, harness.exchange.redeemCalls)
            assertTrue(
                requireNotNull(harness.credentials.read(activated.credentialReference))
                    .hasCredentialMaterial,
            )
        }

    @Test
    fun `startup credential admission serializes refresh mutation through winner validation`() =
        runBlocking {
            val harness = Harness()
            val activated = harness.repository.confirmEnrollment(
                enrollmentDraft(
                    "enrollment-startup-refresh-race",
                    "twenroll2.code-startup-refresh-race",
                ).confirm(deviceLabel = "Refresh Race Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val prepared = harness.repository.prepareRefresh(activated.profile)
            val credentialRead = harness.credentials.blockNextReadAfterSnapshot()
            val admission = async(Dispatchers.Default) {
                harness.repository.admitStartup()
            }
            credentialRead.awaitStarted()

            val profileRepair = harness.profiles.blockNextCredentialVersionUpdate()
            val refresh = async(start = CoroutineStart.UNDISPATCHED) {
                harness.repository.applyRefreshResponse(
                    prepared,
                    refreshResponse(prepared, version = 2),
                )
            }
            val refreshEnteredRepairBeforeAdmissionReleased =
                profileRepair.started.isCompleted

            credentialRead.release()
            val admitted = withTimeout(1_000) { admission.await() }
            withTimeout(1_000) { profileRepair.started.await() }
            val blobVersionBeforeRepair =
                harness.credentials.read(activated.profile.credentialReference)?.credentialVersion
            val profileVersionBeforeRepair = harness.profiles.activeV2?.credentialVersion
            profileRepair.release.complete(Unit)
            val refreshResult = withTimeout(1_000) { refresh.await() }

            assertFalse(
                "Startup returned stale Ready after refresh committed a newer credential blob",
                refreshEnteredRepairBeforeAdmissionReleased &&
                    admitted == RelayV2StartupAdmissionResult.Ready(activated.profile) &&
                    blobVersionBeforeRepair == 2L &&
                    profileVersionBeforeRepair == 1L,
            )
            assertEquals(
                RelayV2StartupAdmissionResult.Ready(activated.profile),
                admitted,
            )
            assertEquals(
                RelayV2RefreshApplyResult.Applied(
                    credentialVersion = 2,
                    repairedProfileVersion = true,
                ),
                refreshResult,
            )
            assertEquals(2L, harness.profiles.activeV2?.credentialVersion)
            assertEquals(
                2L,
                harness.credentials.read(activated.profile.credentialReference)
                    ?.credentialVersion,
            )
        }

    @Test
    fun `disconnect receipt must match exactly and the validated proof reaches isolation unchanged`() =
        runBlocking {
            val mismatches = listOf<(
                RelayActiveProfileIdentity,
                String,
            ) -> RelayProfileDisconnectReceipt>(
                { profile, barrierId ->
                    RelayProfileDisconnectReceipt(
                        profile.copy(activationGeneration = profile.activationGeneration + 1),
                        barrierId,
                    )
                },
                { profile, barrierId ->
                    RelayProfileDisconnectReceipt(profile, "$barrierId-wrong")
                },
            )

            mismatches.forEach { mismatch ->
                val harness = Harness(disconnectReceipt = mismatch)

                assertTrue(
                    runCatching {
                        harness.repository.confirmEnrollment(
                            enrollmentDraft().confirm(deviceLabel = "Pixel"),
                        )
                    }.isFailure,
                )
                assertEquals(0, harness.isolationCalls)
                assertTrue(harness.isolationReceipts.isEmpty())
                assertEquals(0, harness.profiles.activationCount)
                assertEquals(RelayProfileDialect.V1, harness.profiles.activeIdentity?.dialect)
            }
        }

    @Test
    fun `newer confirmation immediately supersedes older activation in either response order`() =
        runBlocking {
            EnrollmentResponseOrder.entries.forEach { responseOrder ->
                val firstResponseArrivesFirst = responseOrder == EnrollmentResponseOrder.A_FIRST
                val harness = Harness()
                val firstGate = harness.exchange.deferEnrollment("enrollment-a")
                val secondGate = harness.exchange.deferEnrollment("enrollment-b")
                val first = async {
                    harness.repository.confirmEnrollment(
                        enrollmentDraft("enrollment-a", "twenroll2.code-a")
                            .confirm(deviceLabel = "Pixel A"),
                    )
                }
                val firstRequest = firstGate.request.await()
                val profileReadGate = if (firstResponseArrivesFirst) {
                    harness.profiles.blockNextActiveProfileRead()
                } else {
                    null
                }
                val second = async {
                    harness.repository.confirmEnrollment(
                        enrollmentDraft("enrollment-b", "twenroll2.code-b")
                            .confirm(deviceLabel = "Pixel B"),
                    )
                }
                profileReadGate?.started?.await()

                val (olderResult, winningProfile) = if (firstResponseArrivesFirst) {
                    firstGate.response.complete(enrollmentResponse(firstRequest, "a"))
                    val older = first.await()
                    assertTrue(older is RelayV2EnrollmentResult.Superseded)
                    assertEquals(0, harness.isolationCalls)
                    assertEquals(0, harness.profiles.activationCount)
                    requireNotNull(profileReadGate).release.complete(Unit)
                    val secondRequest = secondGate.request.await()
                    secondGate.response.complete(enrollmentResponse(secondRequest, "b"))
                    older to (second.await() as RelayV2EnrollmentResult.Activated).profile
                } else {
                    val secondRequest = secondGate.request.await()
                    secondGate.response.complete(enrollmentResponse(secondRequest, "b"))
                    val winner = (second.await() as RelayV2EnrollmentResult.Activated).profile
                    firstGate.response.complete(enrollmentResponse(firstRequest, "a"))
                    first.await() to winner
                }

                assertTrue(olderResult is RelayV2EnrollmentResult.Superseded)
                assertEquals(winningProfile, harness.profiles.activeV2)
                assertEquals(1, harness.barrier.calls)
                assertEquals(1, harness.isolationCalls)
                assertEquals(1, harness.profiles.activationCount)
                val winner = requireNotNull(
                    harness.credentials.read(winningProfile.credentialReference),
                )
                assertEquals("twcap2.access-b", winner.accessToken)
                assertEquals("twref2.refresh-b", winner.refreshToken)
                val loser = harness.credentials.values().single { !it.hasCredentialMaterial }
                assertEquals(0L, loser.credentialVersion)
                assertNotNull(loser.pendingAttempt)
            }

            val switched = Harness()
            val switchedGate = switched.exchange.deferEnrollment("enrollment-switch")
            val lateAfterSwitch = async {
                switched.repository.confirmEnrollment(
                    enrollmentDraft("enrollment-switch", "twenroll2.code-switch")
                        .confirm(deviceLabel = "Pixel"),
                )
            }
            val switchedRequest = switchedGate.request.await()
            val replacement = relayV2Profile().copy(profileId = "replacement-profile")
            assertEquals(
                replacement,
                switched.profiles.forceActivateRelayV2Profile(
                    switched.profiles.activeIdentity,
                    replacement,
                ),
            )
            switchedGate.response.complete(enrollmentResponse(switchedRequest, "switched-late"))
            assertEquals(
                RelayV2EnrollmentResult.Superseded(replacement.identity),
                lateAfterSwitch.await(),
            )
            assertEquals(0, switched.barrier.calls)
            assertTrue(switched.credentials.values().single().hasCredentialMaterial.not())

            val cancelled = Harness()
            val cancelledGate = cancelled.exchange.deferEnrollment("enrollment-cancel")
            val cancelledConfirmation = enrollmentDraft(
                enrollmentId = "enrollment-cancel",
                enrollmentCode = "twenroll2.code-cancel",
            ).confirm(deviceLabel = "Pixel")
            val lateAfterCancel = async {
                cancelled.repository.confirmEnrollment(cancelledConfirmation)
            }
            val cancelledRequest = cancelledGate.request.await()
            assertTrue(cancelled.repository.cancelPendingEnrollment(cancelledConfirmation))
            assertFalse(cancelled.repository.cancelPendingEnrollment(cancelledConfirmation))
            cancelledGate.response.complete(
                enrollmentResponse(cancelledRequest, identitySuffix = "cancelled-late"),
            )
            assertEquals(
                RelayV2EnrollmentResult.Superseded(cancelled.profiles.activeIdentity),
                lateAfterCancel.await(),
            )
            assertEquals(RelayProfileDialect.V1, cancelled.profiles.activeIdentity?.dialect)
            assertEquals(0, cancelled.barrier.calls)
            assertEquals(0, cancelled.isolationCalls)
            assertEquals(0, cancelled.profiles.activationCount)
            assertTrue(cancelled.credentials.values().single().hasCredentialMaterial.not())
        }

    @Test
    fun `new confirmation supersedes response blocked in disconnect before isolation`() =
        runBlocking {
            val harness = Harness(blockDisconnect = true)
            val olderConfirmation = enrollmentDraft(
                "enrollment-disconnect-a",
                "twenroll2.code-disconnect-a",
            ).confirm(deviceLabel = "Pixel A")
            val newerGate = harness.exchange.deferEnrollment("enrollment-disconnect-b")
            val older = async { harness.repository.confirmEnrollment(olderConfirmation) }
            harness.barrier.started.await()
            val olderReference = requireNotNull(
                harness.profiles.journal,
            ).targetCredentialReference
            assertFalse(harness.credentials.values().single().hasCredentialMaterial)

            val newer = async {
                harness.repository.confirmEnrollment(
                    enrollmentDraft(
                        "enrollment-disconnect-b",
                        "twenroll2.code-disconnect-b",
                    ).confirm(deviceLabel = "Pixel B"),
                )
            }
            val newerRequest = withTimeout(1_000) { newerGate.request.await() }
            assertEquals(null, harness.profiles.journal)
            assertEquals(0, harness.credentials.enrollmentCompletionCasCalls(olderReference))
            assertFalse(harness.credentials.values().single {
                it.pendingAttempt?.enrollmentId == "enrollment-disconnect-a"
            }.hasCredentialMaterial)
            harness.barrier.release.complete(Unit)

            assertTrue(older.await() is RelayV2EnrollmentResult.Superseded)
            assertEquals(0, harness.isolationCalls)
            assertEquals(0, harness.profiles.activationCount)
            assertEquals(null, harness.profiles.journal)
            assertEquals(0, harness.credentials.enrollmentCompletionCasCalls(olderReference))
            assertFalse(harness.credentials.values().single {
                it.pendingAttempt?.enrollmentId == "enrollment-disconnect-a"
            }.hasCredentialMaterial)

            newerGate.response.complete(enrollmentResponse(newerRequest, "disconnect-b"))
            val winner = (newer.await() as RelayV2EnrollmentResult.Activated).profile
            assertEquals(winner, harness.profiles.activeV2)
            assertEquals(0, harness.credentials.enrollmentCompletionCasCalls(olderReference))
            assertEquals(
                1,
                harness.credentials.enrollmentCompletionCasCalls(winner.credentialReference),
            )
            assertEquals(1, harness.isolationCalls)
            assertEquals(1, harness.profiles.activationCount)
            assertSameReferenceRetryRedeems(
                harness = harness,
                confirmed = olderConfirmation,
                enrollmentId = "enrollment-disconnect-a",
                expectedActive = winner.identity,
            )
        }

    @Test
    fun `cancelled response blocked in disconnect leaves only its pending attempt`() =
        runBlocking {
            val harness = Harness(blockDisconnect = true)
            val confirmed = enrollmentDraft(
                "enrollment-disconnect-cancel",
                "twenroll2.code-disconnect-cancel",
            ).confirm(deviceLabel = "Pixel A")
            val pending = async { harness.repository.confirmEnrollment(confirmed) }
            harness.barrier.started.await()
            val reference = requireNotNull(harness.profiles.journal).targetCredentialReference
            assertFalse(harness.credentials.values().single().hasCredentialMaterial)

            assertTrue(harness.repository.cancelPendingEnrollment(confirmed))
            assertEquals(null, harness.profiles.journal)
            assertEquals(0, harness.credentials.enrollmentCompletionCasCalls(reference))
            harness.barrier.release.complete(Unit)

            assertTrue(pending.await() is RelayV2EnrollmentResult.Superseded)
            assertEquals(0, harness.isolationCalls)
            assertEquals(0, harness.profiles.activationCount)
            assertEquals(null, harness.profiles.journal)
            assertEquals(0, harness.credentials.enrollmentCompletionCasCalls(reference))
            assertFalse(harness.credentials.values().single().hasCredentialMaterial)
            assertSameReferenceRetryRedeems(
                harness = harness,
                confirmed = confirmed,
                enrollmentId = "enrollment-disconnect-cancel",
                expectedActive = harness.profiles.activeIdentity,
            )
        }

    @Test
    fun `final commit lease prevents cancel or supersede during destructive isolation`() =
        runBlocking {
            DuringIsolationInterleaving.entries.forEach { interleaving ->
                val harness = Harness()
                val old = harness.repository.confirmEnrollment(
                    enrollmentDraft().confirm(deviceLabel = "Old Pixel"),
                ) as RelayV2EnrollmentResult.Activated
                val isolationGate = harness.isolation.blockNextIsolation()
                val confirmedA = enrollmentDraft(
                    "enrollment-isolation-a",
                    "twenroll2.code-isolation-a",
                ).confirm(deviceLabel = "Pixel A")
                val activationA = async {
                    harness.repository.confirmEnrollment(confirmedA)
                }
                isolationGate.started.await()

                assertEquals(null, harness.profiles.activeIdentity)
                assertEquals(
                    old.profile.identity,
                    harness.profiles.journal?.previousProfile,
                )
                assertEquals(
                    RelayV2ProfileActivationPhase.CREDENTIAL_READY,
                    harness.profiles.journal?.phase,
                )
                assertEquals(null, harness.credentials.read(old.profile.credentialReference))
                assertTrue(
                    harness.credentials.read(
                        requireNotNull(harness.profiles.journal).targetCredentialReference,
                    )?.hasCredentialMaterial == true,
                )

                when (interleaving) {
                    DuringIsolationInterleaving.CANCEL_A -> {
                        val cancellation = async {
                            harness.repository.cancelPendingEnrollment(confirmedA)
                        }
                        yield()
                        assertFalse(cancellation.isCompleted)

                        isolationGate.release.complete(Unit)
                        val committedA = (activationA.await()
                            as RelayV2EnrollmentResult.Activated).profile
                        assertFalse(cancellation.await())
                        assertEquals(committedA, harness.profiles.activeV2)
                        assertTrue(harness.credentials.read(
                            committedA.credentialReference,
                        )?.hasCredentialMaterial == true)
                    }
                    DuringIsolationInterleaving.CONFIRM_B -> {
                        val gateB = harness.exchange.deferEnrollment("enrollment-isolation-b")
                        val activationB = async {
                            harness.repository.confirmEnrollment(
                                enrollmentDraft(
                                    "enrollment-isolation-b",
                                    "twenroll2.code-isolation-b",
                                ).confirm(deviceLabel = "Pixel B"),
                            )
                        }
                        yield()
                        assertFalse(gateB.request.isCompleted)

                        isolationGate.release.complete(Unit)
                        val committedA = (activationA.await()
                            as RelayV2EnrollmentResult.Activated).profile
                        assertEquals(committedA, harness.profiles.activeV2)
                        assertTrue(harness.credentials.read(
                            committedA.credentialReference,
                        )?.hasCredentialMaterial == true)

                        val requestB = withTimeout(1_000) { gateB.request.await() }
                        gateB.response.complete(enrollmentResponse(requestB, "isolation-b"))
                        val committedB = (activationB.await()
                            as RelayV2EnrollmentResult.Activated).profile
                        assertEquals(committedB, harness.profiles.activeV2)
                        assertEquals(null, harness.credentials.read(
                            committedA.credentialReference,
                        ))
                        assertTrue(harness.credentials.read(
                            committedB.credentialReference,
                        )?.hasCredentialMaterial == true)
                    }
                }
                assertFalse(harness.profiles.activeIdentity == old.profile.identity)
            }
        }

    @Test
    fun `durable activation journal resumes every pre-commit failure after reopen`() =
        runBlocking {
            ActivationPreCommitFailure.entries.forEach { boundary ->
                val suffix = boundary.name.lowercase()
                val harness = Harness()
                val old = harness.repository.confirmEnrollment(
                    enrollmentDraft(
                        "enrollment-journal-old-$suffix",
                        "twenroll2.code-journal-old-$suffix",
                    ).confirm(deviceLabel = "Old Pixel"),
                ) as RelayV2EnrollmentResult.Activated
                val enrollmentId = "enrollment-journal-target-$suffix"
                val enrollmentCode = "twenroll2.code-journal-target-$suffix"
                val confirmed = enrollmentDraft(
                    enrollmentId,
                    enrollmentCode,
                ).confirm(deviceLabel = "Target Pixel")

                when (boundary) {
                    ActivationPreCommitFailure.PREPARE ->
                        harness.profiles.failNextPrepareBeforeWrite = true
                    ActivationPreCommitFailure.CREDENTIAL_CAS ->
                        harness.credentials.failNextCasBeforeWriteCount = 2
                    ActivationPreCommitFailure.CREDENTIAL_READY ->
                        harness.profiles.failNextCredentialReadyBeforeWrite = true
                    ActivationPreCommitFailure.ISOLATION ->
                        harness.isolation.failNextAfterDestructiveMutation = true
                    ActivationPreCommitFailure.PROFILE_PUBLISH ->
                        harness.profiles.failNextProfilePublishBeforeWrite = true
                }

                assertTrue(
                    "Expected injected failure at $boundary",
                    runCatching { harness.repository.confirmEnrollment(confirmed) }.isFailure,
                )
                assertEquals(1, harness.exchange.enrollmentCodeConsumptions(enrollmentCode))

                val targetReference = harness.profiles.journal?.targetCredentialReference
                    ?: harness.credentials.entries().entries.firstOrNull {
                        it.value.pendingAttempt?.enrollmentId == enrollmentId
                    }?.key
                    ?: requireNotNull(harness.profiles.activeV2).credentialReference
                val afterFailure = requireNotNull(harness.credentials.read(targetReference))
                val completedBeforeRetry = afterFailure.takeIf { it.hasCredentialMaterial }
                val expectedPhase = when (boundary) {
                    ActivationPreCommitFailure.PREPARE -> null
                    ActivationPreCommitFailure.CREDENTIAL_CAS,
                    ActivationPreCommitFailure.CREDENTIAL_READY,
                    -> RelayV2ProfileActivationPhase.PREPARED
                    ActivationPreCommitFailure.ISOLATION,
                    ActivationPreCommitFailure.PROFILE_PUBLISH,
                    -> RelayV2ProfileActivationPhase.CREDENTIAL_READY
                }
                assertEquals(expectedPhase, harness.profiles.journal?.phase)
                if (expectedPhase == RelayV2ProfileActivationPhase.CREDENTIAL_READY) {
                    assertEquals(null, harness.profiles.activeIdentity)
                    assertEquals(null, harness.profiles.activeV2)
                } else {
                    assertEquals(old.profile.identity, harness.profiles.activeIdentity)
                }
                if (boundary == ActivationPreCommitFailure.ISOLATION ||
                    boundary == ActivationPreCommitFailure.PROFILE_PUBLISH
                ) {
                    assertEquals(null, harness.credentials.read(old.profile.credentialReference))
                } else {
                    assertTrue(
                        harness.credentials.read(old.profile.credentialReference)
                            ?.hasCredentialMaterial == true,
                    )
                }
                when (boundary) {
                    ActivationPreCommitFailure.CREDENTIAL_READY,
                    ActivationPreCommitFailure.ISOLATION,
                    ActivationPreCommitFailure.PROFILE_PUBLISH,
                    -> {
                        assertTrue(afterFailure.hasCredentialMaterial)
                        assertEquals(1L, afterFailure.credentialVersion)
                        assertEquals(null, afterFailure.pendingAttempt)
                        assertNotNull(afterFailure.completedAttemptId)
                        assertNotNull(afterFailure.completedSecretReference)
                    }
                    else -> {
                        assertFalse(
                            "Expected pending credential after $boundary",
                            afterFailure.hasCredentialMaterial,
                        )
                        assertEquals(0L, afterFailure.credentialVersion)
                        assertNotNull(afterFailure.pendingAttempt)
                    }
                }

                val redeemCallsBeforeRetry = harness.exchange.redeemCalls
                harness.restartRepository()
                if (boundary == ActivationPreCommitFailure.CREDENTIAL_CAS) {
                    assertEquals(
                        RelayV2ActivationRecoveryResult.ReenrollmentRequired(targetReference),
                        harness.repository.recoverPendingActivation(),
                    )
                    assertEquals(old.profile.identity, harness.profiles.activeIdentity)
                    assertEquals(null, harness.profiles.journal)
                    assertEquals(redeemCallsBeforeRetry, harness.exchange.redeemCalls)
                    return@forEach
                }
                val recovered = when (boundary) {
                    ActivationPreCommitFailure.PREPARE -> {
                        assertEquals(
                            RelayV2ActivationRecoveryResult.NoPendingActivation,
                            harness.repository.recoverPendingActivation(),
                        )
                        (harness.repository.confirmEnrollment(confirmed)
                            as RelayV2EnrollmentResult.Activated).profile
                    }
                    else -> (harness.repository.recoverPendingActivation()
                        as RelayV2ActivationRecoveryResult.Activated).profile
                }
                val recoveredBlob = requireNotNull(harness.credentials.read(targetReference))

                assertEquals(targetReference, recovered.credentialReference)
                assertEquals(recovered, harness.profiles.activeV2)
                assertEquals(recovered.identity, harness.profiles.activeIdentity)
                assertEquals(null, harness.profiles.journal)
                assertSame(harness.barrier.returnedReceipt, harness.isolationReceipts.last())
                assertTrue(recoveredBlob.hasCredentialMaterial)
                assertEquals(1L, recoveredBlob.credentialVersion)
                assertEquals(1, harness.exchange.enrollmentCodeConsumptions(enrollmentCode))
                if (completedBeforeRetry != null) {
                    assertEquals(completedBeforeRetry, recoveredBlob)
                    assertEquals(redeemCallsBeforeRetry, harness.exchange.redeemCalls)
                } else {
                    assertEquals(redeemCallsBeforeRetry + 1, harness.exchange.redeemCalls)
                }
            }
        }

    @Test
    fun `startup recovery rolls prepared pending back after broker replay expires`() =
        runBlocking {
            val harness = Harness()
            val old = harness.repository.confirmEnrollment(
                enrollmentDraft(
                    "enrollment-expiry-old",
                    "twenroll2.code-expiry-old",
                ).confirm(deviceLabel = "Old Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val confirmed = enrollmentDraft(
                "enrollment-expiry-target",
                "twenroll2.code-expiry-target",
            ).confirm(deviceLabel = "Target Pixel")
            harness.credentials.failNextCasBeforeWriteCount = 2

            assertTrue(runCatching { harness.repository.confirmEnrollment(confirmed) }.isFailure)
            val prepared = requireNotNull(harness.profiles.journal)
            assertEquals(RelayV2ProfileActivationPhase.PREPARED, prepared.phase)
            assertEquals(old.profile.identity, harness.profiles.activeIdentity)
            assertFalse(
                requireNotNull(harness.credentials.read(prepared.targetCredentialReference))
                    .hasCredentialMaterial,
            )
            val redeemCalls = harness.exchange.redeemCalls

            harness.restartRepository()
            harness.exchange.advanceReplayTimeBy(10 * 60 * 1_000L + 1)
            assertEquals(
                RelayV2ActivationRecoveryResult.ReenrollmentRequired(
                    prepared.targetCredentialReference,
                ),
                harness.repository.recoverPendingActivation(),
            )
            assertEquals(redeemCalls, harness.exchange.redeemCalls)
            assertEquals(null, harness.profiles.journal)
            assertEquals(old.profile.identity, harness.profiles.activeIdentity)
            assertTrue(runCatching {
                harness.repository.confirmEnrollment(confirmed)
            }.exceptionOrNull()?.message?.contains("replay expired") == true)
            assertEquals(old.profile.identity, harness.profiles.activeIdentity)
            assertFalse(
                requireNotNull(harness.credentials.read(prepared.targetCredentialReference))
                    .hasCredentialMaterial,
            )
        }

    @Test
    fun `completed prepared winner rolls forward before replace cancel or same-reference retry`() =
        runBlocking {
            CompletedPreparedFollowUp.entries.forEach { followUp ->
                val suffix = followUp.name.lowercase()
                val harness = Harness()
                harness.repository.confirmEnrollment(
                    enrollmentDraft(
                        "enrollment-completed-old-$suffix",
                        "twenroll2.code-completed-old-$suffix",
                    ).confirm(deviceLabel = "Old Pixel"),
                ) as RelayV2EnrollmentResult.Activated
                val confirmedA = enrollmentDraft(
                    "enrollment-completed-a-$suffix",
                    "twenroll2.code-completed-a-$suffix",
                ).confirm(deviceLabel = "Pixel A")
                harness.profiles.failNextCredentialReadyBeforeWrite = true

                assertTrue(
                    runCatching { harness.repository.confirmEnrollment(confirmedA) }.isFailure,
                )
                val prepared = requireNotNull(harness.profiles.journal)
                assertEquals(RelayV2ProfileActivationPhase.PREPARED, prepared.phase)
                val completedWinner = requireNotNull(
                    harness.credentials.read(prepared.targetCredentialReference),
                )
                assertTrue(completedWinner.hasCredentialMaterial)
                assertEquals(
                    prepared.targetCredentialAttemptId,
                    completedWinner.completedAttemptId,
                )
                assertEquals(
                    prepared.targetCredentialSecretReference,
                    completedWinner.completedSecretReference,
                )
                val redeemCalls = harness.exchange.redeemCalls
                harness.restartRepository()

                when (followUp) {
                    CompletedPreparedFollowUp.CONFIRM_B -> {
                        val confirmedB = enrollmentDraft(
                            "enrollment-completed-b-$suffix",
                            "twenroll2.code-completed-b-$suffix",
                        ).confirm(deviceLabel = "Pixel B")
                        assertTrue(
                            harness.repository.confirmEnrollment(confirmedB) is
                                RelayV2EnrollmentResult.Superseded,
                        )
                        assertEquals(
                            prepared.targetCredentialReference,
                            harness.profiles.activeV2?.credentialReference,
                        )
                        assertEquals(2, harness.profiles.activationCount)
                        val activatedB = harness.repository.confirmEnrollment(confirmedB)
                            as RelayV2EnrollmentResult.Activated
                        assertEquals(activatedB.profile, harness.profiles.activeV2)
                        assertEquals(3, harness.profiles.activationCount)
                        assertEquals(
                            null,
                            harness.credentials.read(prepared.targetCredentialReference),
                        )
                    }
                    CompletedPreparedFollowUp.CANCEL_A -> {
                        assertFalse(harness.repository.cancelPendingEnrollment(confirmedA))
                        assertEquals(
                            prepared.targetCredentialReference,
                            harness.profiles.activeV2?.credentialReference,
                        )
                        assertEquals(
                            completedWinner,
                            harness.credentials.read(prepared.targetCredentialReference),
                        )
                        assertEquals(2, harness.profiles.activationCount)
                        assertEquals(redeemCalls, harness.exchange.redeemCalls)
                    }
                    CompletedPreparedFollowUp.CONFIRM_A_AGAIN -> {
                        val activatedA = harness.repository.confirmEnrollment(confirmedA)
                            as RelayV2EnrollmentResult.Activated
                        assertEquals(
                            prepared.targetCredentialReference,
                            activatedA.profile.credentialReference,
                        )
                        assertEquals(
                            completedWinner,
                            harness.credentials.read(prepared.targetCredentialReference),
                        )
                        assertEquals(2, harness.profiles.activationCount)
                        assertEquals(redeemCalls, harness.exchange.redeemCalls)
                    }
                }
                assertEquals(null, harness.profiles.journal)
            }
        }

    @Test
    fun `cancel and recovery converge when cancel owns exact pending rollback`() = runBlocking {
        val harness = Harness()
        val confirmed = enrollmentDraft(
            "enrollment-rollback-cancel",
            "twenroll2.code-rollback-cancel",
        ).confirm(deviceLabel = "Pixel")
        harness.credentials.failNextCasBeforeWriteCount = 2
        assertTrue(runCatching { harness.repository.confirmEnrollment(confirmed) }.isFailure)
        val journal = requireNotNull(harness.profiles.journal)
        harness.restartRepository()

        val exchangeGate = harness.exchange.deferEnrollment("enrollment-rollback-cancel")
        val liveConfirmation = async { harness.repository.confirmEnrollment(confirmed) }
        val replayRequest = exchangeGate.request.await()
        val rollbackGate = harness.profiles.blockNextPreparedRollback()
        val cancellation = async { harness.repository.cancelPendingEnrollment(confirmed) }
        rollbackGate.started.await()
        val recovery = async { harness.repository.recoverPendingActivation() }
        yield()
        assertFalse(recovery.isCompleted)

        rollbackGate.release.complete(Unit)
        assertTrue(cancellation.await())
        assertEquals(
            RelayV2ActivationRecoveryResult.NoPendingActivation,
            recovery.await(),
        )
        exchangeGate.response.complete(
            harness.exchange.completedResponse(replayRequest.exchangeAttemptId),
        )
        assertTrue(liveConfirmation.await() is RelayV2EnrollmentResult.Superseded)
        assertEquals(null, harness.profiles.journal)
        assertFalse(
            requireNotNull(harness.credentials.read(journal.targetCredentialReference))
                .hasCredentialMaterial,
        )
    }

    @Test
    fun `recovery removal retires a superseding intent with a stale journal read`() = runBlocking {
        val harness = Harness()
        val confirmedA = enrollmentDraft(
            "enrollment-rollback-a",
            "twenroll2.code-rollback-a",
        ).confirm(deviceLabel = "Pixel A")
        harness.credentials.failNextCasBeforeWriteCount = 2
        assertTrue(runCatching { harness.repository.confirmEnrollment(confirmedA) }.isFailure)
        val journal = requireNotNull(harness.profiles.journal)
        harness.restartRepository()

        val staleRead = harness.profiles.blockNextPendingActivationReadAfterSnapshot()
        val confirmedB = enrollmentDraft(
            "enrollment-rollback-b",
            "twenroll2.code-rollback-b",
        ).confirm(deviceLabel = "Pixel B")
        val activationB = async { harness.repository.confirmEnrollment(confirmedB) }
        staleRead.started.await()
        assertEquals(
            RelayV2ActivationRecoveryResult.ReenrollmentRequired(
                journal.targetCredentialReference,
            ),
            harness.repository.recoverPendingActivation(),
        )
        staleRead.release.complete(Unit)

        assertTrue(activationB.await() is RelayV2EnrollmentResult.Superseded)
        assertFalse(harness.repository.cancelPendingEnrollment(confirmedB))
        assertEquals(null, harness.profiles.journal)
        assertEquals(1, harness.credentials.values().size)
        assertFalse(harness.credentials.values().single().hasCredentialMaterial)
    }

    @Test
    fun `same-reference joiners stop after a completed earlier activation recovers`() =
        runBlocking {
            val harness = Harness()
            harness.repository.confirmEnrollment(
                enrollmentDraft(
                    "enrollment-join-old",
                    "twenroll2.code-join-old",
                ).confirm(deviceLabel = "Old Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val confirmedA = enrollmentDraft(
                "enrollment-join-a",
                "twenroll2.code-join-a",
            ).confirm(deviceLabel = "Pixel A")
            harness.profiles.failNextCredentialReadyBeforeWrite = true
            assertTrue(runCatching { harness.repository.confirmEnrollment(confirmedA) }.isFailure)
            val preparedA = requireNotNull(harness.profiles.journal)
            harness.restartRepository()

            val recoveryBarrier = harness.barrier.blockNextDisconnect()
            val gateB = harness.exchange.deferEnrollment("enrollment-join-b")
            val confirmedB = enrollmentDraft(
                "enrollment-join-b",
                "twenroll2.code-join-b",
            ).confirm(deviceLabel = "Pixel B")
            val firstB = async { harness.repository.confirmEnrollment(confirmedB) }
            recoveryBarrier.started.await()
            val joinedB = async { harness.repository.confirmEnrollment(confirmedB) }
            yield()
            assertFalse(gateB.request.isCompleted)

            recoveryBarrier.release.complete(Unit)
            val results = withTimeout(1_000) { listOf(firstB.await(), joinedB.await()) }
            assertTrue(results.all { it is RelayV2EnrollmentResult.Superseded })
            assertFalse(gateB.request.isCompleted)
            assertEquals(
                preparedA.targetCredentialReference,
                harness.profiles.activeV2?.credentialReference,
            )
            assertFalse(harness.repository.cancelPendingEnrollment(confirmedB))
        }

    @Test
    fun `same reference retry after recovery publish reuses the recovered activation`() =
        runBlocking {
            val harness = Harness()
            val confirmedA = enrollmentDraft(
                "enrollment-published-a",
                "twenroll2.code-published-a",
            ).confirm(deviceLabel = "Pixel A")
            harness.profiles.failNextCredentialReadyBeforeWrite = true
            assertTrue(runCatching { harness.repository.confirmEnrollment(confirmedA) }.isFailure)
            val preparedA = requireNotNull(harness.profiles.journal)
            val completedA = requireNotNull(
                harness.credentials.read(preparedA.targetCredentialReference),
            )
            val redeemCalls = harness.exchange.redeemCalls
            val completionCasCalls = harness.credentials.enrollmentCompletionCasCalls(
                preparedA.targetCredentialReference,
            )
            harness.restartRepository()

            val publishReturn = harness.profiles.blockNextProfilePublishReturn()
            val firstA = async { harness.repository.confirmEnrollment(confirmedA) }
            publishReturn.started.await()
            assertEquals(null, harness.profiles.journal)
            assertEquals(
                preparedA.targetCredentialReference,
                harness.profiles.activeV2?.credentialReference,
            )
            val joinedA = async { harness.repository.confirmEnrollment(confirmedA) }
            yield()
            assertFalse(joinedA.isCompleted)

            publishReturn.release.complete(Unit)
            val results = withTimeout(1_000) { listOf(firstA.await(), joinedA.await()) }
            val profiles = results.map { (it as RelayV2EnrollmentResult.Activated).profile }
            assertEquals(profiles.first(), profiles.last())
            assertEquals(profiles.first(), harness.profiles.activeV2)
            assertEquals(completedA, harness.credentials.read(preparedA.targetCredentialReference))
            assertEquals(redeemCalls, harness.exchange.redeemCalls)
            assertEquals(
                completionCasCalls,
                harness.credentials.enrollmentCompletionCasCalls(
                    preparedA.targetCredentialReference,
                ),
            )
            assertEquals(1, harness.profiles.activationCount)
        }

    @Test
    fun `completed A recovery cannot let B overwrite a newer C intent`() = runBlocking {
        val harness = Harness()
        harness.repository.confirmEnrollment(
            enrollmentDraft(
                "enrollment-abc-old",
                "twenroll2.code-abc-old",
            ).confirm(deviceLabel = "Old Pixel"),
        ) as RelayV2EnrollmentResult.Activated
        val confirmedA = enrollmentDraft(
            "enrollment-abc-a",
            "twenroll2.code-abc-a",
        ).confirm(deviceLabel = "Pixel A")
        harness.profiles.failNextCredentialReadyBeforeWrite = true
        assertTrue(runCatching { harness.repository.confirmEnrollment(confirmedA) }.isFailure)
        val preparedA = requireNotNull(harness.profiles.journal)
        assertTrue(
            requireNotNull(harness.credentials.read(preparedA.targetCredentialReference))
                .hasCredentialMaterial,
        )
        harness.restartRepository()

        val recoveryBarrier = harness.barrier.blockNextDisconnect()
        val gateB = harness.exchange.deferEnrollment("enrollment-abc-b")
        val confirmationB = enrollmentDraft(
            "enrollment-abc-b",
            "twenroll2.code-abc-b",
        ).confirm(deviceLabel = "Pixel B")
        val activationB = async { harness.repository.confirmEnrollment(confirmationB) }
        recoveryBarrier.started.await()

        val cActiveRead = harness.profiles.blockNextActiveProfileRead()
        val gateC = harness.exchange.deferEnrollment("enrollment-abc-c")
        val confirmationC = enrollmentDraft(
            "enrollment-abc-c",
            "twenroll2.code-abc-c",
        ).confirm(deviceLabel = "Pixel C")
        val activationC = async { harness.repository.confirmEnrollment(confirmationC) }
        cActiveRead.started.await()

        recoveryBarrier.release.complete(Unit)
        assertTrue(
            withTimeout(1_000) { activationB.await() } is RelayV2EnrollmentResult.Superseded,
        )
        assertFalse(gateB.request.isCompleted)
        assertEquals(
            preparedA.targetCredentialReference,
            harness.profiles.activeV2?.credentialReference,
        )
        assertEquals(null, harness.profiles.journal)

        cActiveRead.release.complete(Unit)
        val requestC = withTimeout(1_000) { gateC.request.await() }
        gateC.response.complete(enrollmentResponse(requestC, "abc-c"))
        val committedC = (activationC.await() as RelayV2EnrollmentResult.Activated).profile
        assertEquals(committedC, harness.profiles.activeV2)
        assertEquals(3, harness.profiles.activationCount)
        assertEquals(null, harness.credentials.read(preparedA.targetCredentialReference))
    }

    @Test
    fun `completed activation with a pending refresh resumes after reopen`() = runBlocking {
        val harness = Harness()
        val confirmed = enrollmentDraft(
            "enrollment-refresh-reopen",
            "twenroll2.code-refresh-reopen",
        ).confirm(deviceLabel = "Pixel")
        harness.profiles.failNextCredentialReadyBeforeWrite = true
        assertTrue(runCatching { harness.repository.confirmEnrollment(confirmed) }.isFailure)
        val journal = requireNotNull(harness.profiles.journal)
        val completed = requireNotNull(
            harness.credentials.read(journal.targetCredentialReference),
        )
        val refreshAttempt = RelayV2PendingCredentialAttempt(
            kind = RelayV2CredentialAttemptKind.REFRESH,
            attemptId = "refresh-during-reopen",
            oldCredentialVersion = completed.credentialVersion,
            secretReference = "refresh-secret-during-reopen",
            secret = requireNotNull(completed.refreshToken),
        )
        val refreshing = completed.copy(pendingAttempt = refreshAttempt)
        assertEquals(
            RelayV2CredentialCasResult.Updated(completed.credentialVersion),
            harness.credentials.compareAndSet(
                journal.targetCredentialReference,
                completed.expectation(),
                refreshing,
            ),
        )
        val redeemCalls = harness.exchange.redeemCalls
        harness.restartRepository()

        val recovered = harness.repository.recoverPendingActivation()
            as RelayV2ActivationRecoveryResult.Activated
        assertEquals(journal.targetCredentialReference, recovered.profile.credentialReference)
        assertEquals(recovered.profile, harness.profiles.activeV2)
        assertEquals(null, harness.profiles.journal)
        assertEquals(refreshing, harness.credentials.read(journal.targetCredentialReference))
        assertEquals(redeemCalls, harness.exchange.redeemCalls)
    }

    @Test
    fun `post-commit IO ambiguity rolls forward without repeating one-time enrollment`() =
        runBlocking {
            ActivationPostCommitAmbiguity.entries.forEach { boundary ->
                val suffix = boundary.name.lowercase()
                val harness = Harness()
                val old = harness.repository.confirmEnrollment(
                    enrollmentDraft(
                        "enrollment-post-old-$suffix",
                        "twenroll2.code-post-old-$suffix",
                    ).confirm(deviceLabel = "Old Pixel"),
                ) as RelayV2EnrollmentResult.Activated
                val enrollmentCode = "twenroll2.code-post-target-$suffix"
                val confirmed = enrollmentDraft(
                    "enrollment-post-target-$suffix",
                    enrollmentCode,
                ).confirm(deviceLabel = "Target Pixel")

                when (boundary) {
                    ActivationPostCommitAmbiguity.PREPARE ->
                        harness.profiles.failNextPrepareAfterWrite = true
                    ActivationPostCommitAmbiguity.CREDENTIAL_CAS ->
                        harness.credentials.failNextCasAfterWriteWithHigherVersion = true
                    ActivationPostCommitAmbiguity.CREDENTIAL_READY ->
                        harness.profiles.failNextCredentialReadyAfterWrite = true
                    ActivationPostCommitAmbiguity.PROFILE_PUBLISH ->
                        harness.profiles.failNextProfilePublishAfterWrite = true
                }

                val activated = harness.repository.confirmEnrollment(confirmed)
                    as RelayV2EnrollmentResult.Activated
                val credential = requireNotNull(
                    harness.credentials.read(activated.profile.credentialReference),
                )

                assertEquals(activated.profile, harness.profiles.activeV2)
                assertEquals(null, harness.profiles.journal)
                assertEquals(null, harness.credentials.read(old.profile.credentialReference))
                val expectedVersion = if (
                    boundary == ActivationPostCommitAmbiguity.CREDENTIAL_CAS
                ) 2L else 1L
                assertEquals(expectedVersion, credential.credentialVersion)
                assertEquals(expectedVersion, activated.profile.credentialVersion)
                assertTrue(credential.hasCredentialMaterial)
                assertNotNull(credential.completedAttemptId)
                assertNotNull(credential.completedSecretReference)
                assertEquals(1, harness.exchange.enrollmentCodeConsumptions(enrollmentCode))
            }
        }

    @Test
    fun `credential CAS missing or mismatched outcome fails closed without rebuilding version zero`() =
        runBlocking {
            CredentialCasCorruption.entries.forEach { corruption ->
                val suffix = corruption.name.lowercase()
                val harness = Harness()
                val old = harness.repository.confirmEnrollment(
                    enrollmentDraft(
                        "enrollment-corrupt-old-$suffix",
                        "twenroll2.code-corrupt-old-$suffix",
                    ).confirm(deviceLabel = "Old Pixel"),
                ) as RelayV2EnrollmentResult.Activated
                val enrollmentCode = "twenroll2.code-corrupt-target-$suffix"
                val confirmed = enrollmentDraft(
                    "enrollment-corrupt-target-$suffix",
                    enrollmentCode,
                ).confirm(deviceLabel = "Target Pixel")

                when (corruption) {
                    CredentialCasCorruption.MISSING ->
                        harness.credentials.failNextCasWithMissingBlob = true
                    CredentialCasCorruption.BINDING_MISMATCH ->
                        harness.credentials.failNextCasWithBindingMismatch = true
                    CredentialCasCorruption.ATTEMPT_MISMATCH ->
                        harness.credentials.failNextCasWithAttemptMismatch = true
                    CredentialCasCorruption.SECRET_REFERENCE_MISMATCH ->
                        harness.credentials.failNextCasWithSecretReferenceMismatch = true
                }
                assertTrue(runCatching {
                    harness.repository.confirmEnrollment(confirmed)
                }.isFailure)
                val targetReference = requireNotNull(
                    harness.profiles.journal,
                ).targetCredentialReference
                assertEquals(
                    RelayV2ProfileActivationPhase.PREPARED,
                    harness.profiles.journal?.phase,
                )
                assertEquals(old.profile.identity, harness.profiles.activeIdentity)
                assertTrue(
                    harness.credentials.read(old.profile.credentialReference)
                        ?.hasCredentialMaterial == true,
                )
                val corruptBlob = harness.credentials.read(targetReference)
                when (corruption) {
                    CredentialCasCorruption.MISSING -> assertEquals(null, corruptBlob)
                    CredentialCasCorruption.BINDING_MISMATCH,
                    CredentialCasCorruption.ATTEMPT_MISMATCH,
                    CredentialCasCorruption.SECRET_REFERENCE_MISMATCH,
                    -> {
                        assertEquals(1L, corruptBlob?.credentialVersion)
                        assertTrue(corruptBlob?.hasCredentialMaterial == true)
                    }
                }

                val redeemCallsBeforeReopen = harness.exchange.redeemCalls
                harness.restartRepository()
                assertEquals(
                    RelayV2ActivationRecoveryResult.Incompatible(
                        targetReference,
                        RelayV2CredentialRecoveryReason
                            .COMPLETION_PROOF_MISSING_OR_MISMATCHED,
                    ),
                    harness.repository.recoverPendingActivation(),
                )
                assertEquals(
                    RelayV2EnrollmentResult.RecoveryRequired(
                        targetReference,
                        RelayV2CredentialRecoveryReason
                            .COMPLETION_PROOF_MISSING_OR_MISMATCHED,
                    ),
                    harness.repository.confirmEnrollment(confirmed),
                )
                assertEquals(redeemCallsBeforeReopen, harness.exchange.redeemCalls)
                assertEquals(corruptBlob, harness.credentials.read(targetReference))
                assertEquals(old.profile.identity, harness.profiles.activeIdentity)
                assertEquals(
                    RelayV2ProfileActivationPhase.PREPARED,
                    harness.profiles.journal?.phase,
                )
                assertEquals(1, harness.profiles.activationCount)
                assertEquals(1, harness.exchange.enrollmentCodeConsumptions(enrollmentCode))
            }
        }

    @Test
    fun `same reference and pending attempt exact replay has one credential and activation winner`() =
        runBlocking {
            val harness = Harness()
            val gate = harness.exchange.deferEnrollment("enrollment-replay")
            val confirmed = enrollmentDraft(
                "enrollment-replay",
                "twenroll2.code-replay",
            ).confirm(deviceLabel = "Pixel")
            val first = async { harness.repository.confirmEnrollment(confirmed) }
            val firstRequest = gate.request.await()
            val replay = async { harness.repository.confirmEnrollment(confirmed) }
            val replayRequest = gate.replayRequest.await()

            assertEquals(firstRequest, replayRequest)
            gate.response.complete(enrollmentResponse(firstRequest, "replay"))
            val results = listOf(first.await(), replay.await())

            assertEquals(1, results.count { it is RelayV2EnrollmentResult.Activated })
            assertEquals(1, results.count { it is RelayV2EnrollmentResult.StaleCredentialResponse })
            assertFalse(results.any { it is RelayV2EnrollmentResult.Superseded })
            assertEquals(2, harness.exchange.redeemCalls)
            assertEquals(1, harness.exchange.enrollmentCodeConsumptions("twenroll2.code-replay"))
            assertEquals(1, harness.profiles.activationCount)
            assertEquals(1L, harness.credentials.values().single().credentialVersion)
        }

    @Test
    fun `late refresh response cannot roll credential version or tokens back`() = runBlocking {
        val harness = Harness()
        val activated = harness.repository.confirmEnrollment(
            enrollmentDraft().confirm(deviceLabel = "Pixel"),
        ) as RelayV2EnrollmentResult.Activated

        val first = harness.repository.prepareRefresh(activated.profile)
        val firstResponse = refreshResponse(first, version = 2)
        assertEquals(
            RelayV2RefreshApplyResult.Applied(2, repairedProfileVersion = true),
            harness.repository.applyRefreshResponse(first, firstResponse),
        )

        val profileAtVersionTwo = requireNotNull(harness.profiles.activeV2)
        val second = harness.repository.prepareRefresh(profileAtVersionTwo)
        val secondResponse = refreshResponse(second, version = 3)
        assertEquals(
            RelayV2RefreshApplyResult.Applied(3, repairedProfileVersion = true),
            harness.repository.applyRefreshResponse(second, secondResponse),
        )

        assertEquals(
            RelayV2RefreshApplyResult.StaleCredentialResponse(3),
            harness.repository.applyRefreshResponse(first, firstResponse),
        )
        val winner = harness.credentials.read(activated.profile.credentialReference)
        assertEquals(3L, winner?.credentialVersion)
        assertEquals("twcap2.access-3", winner?.accessToken)
        assertEquals("twref2.refresh-3", winner?.refreshToken)
        assertEquals(3L, harness.profiles.activeV2?.credentialVersion)
    }

    @Test
    fun `credential reconciliation repairs ahead blob and fails closed on invalid monotonic state`() =
        runBlocking {
            val ahead = Harness()
            val activated = ahead.repository.confirmEnrollment(
                enrollmentDraft().confirm(deviceLabel = "Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val versionOneBlob = requireNotNull(
                ahead.credentials.read(activated.profile.credentialReference),
            )
            assertEquals(
                RelayV2CredentialCasResult.Updated(2),
                ahead.credentials.compareAndSet(
                    activated.profile.credentialReference,
                    versionOneBlob.expectation(),
                    versionOneBlob.copy(credentialVersion = 2),
                ),
            )

            assertEquals(
                RelayV2CredentialReconciliationResult.Repaired(
                    activated.profile.copy(credentialVersion = 2),
                ),
                ahead.repository.reconcileActiveCredential(),
            )
            assertEquals(
                RelayV2CredentialReconciliationResult.InSync(
                    activated.profile.copy(credentialVersion = 2),
                ),
                ahead.repository.reconcileActiveCredential(),
            )

            assertTrue(
                ahead.profiles.updateRelayV2CredentialVersion(
                    profileId = activated.profile.profileId,
                    credentialReference = activated.profile.credentialReference,
                    expectedActivationGeneration = activated.profile.activationGeneration,
                    expectedVersion = 2,
                    newVersion = 3,
                ),
            )
            val behind = ahead.repository.reconcileActiveCredential()
                as RelayV2CredentialReconciliationResult.Failed
            assertEquals(
                RelayV2CredentialReconciliationFailure.CREDENTIAL_BLOB_BEHIND_PROFILE,
                behind.failure,
            )

            val mismatched = Harness()
            val mismatchedActivation = mismatched.repository.confirmEnrollment(
                enrollmentDraft().confirm(deviceLabel = "Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val boundBlob = requireNotNull(
                mismatched.credentials.read(mismatchedActivation.profile.credentialReference),
            )
            assertEquals(
                RelayV2CredentialCasResult.Updated(1),
                mismatched.credentials.compareAndSet(
                    mismatchedActivation.profile.credentialReference,
                    boundBlob.expectation(),
                    boundBlob.copy(hostId = "different-host"),
                ),
            )
            val bindingFailure = mismatched.repository.reconcileActiveCredential()
                as RelayV2CredentialReconciliationResult.Failed
            assertEquals(
                RelayV2CredentialReconciliationFailure.BINDING_MISMATCH,
                bindingFailure.failure,
            )
        }

    @Test
    fun `refresh reports metadata failure and fences the same target at a new generation`() =
        runBlocking {
            val rejected = Harness()
            val rejectedActivation = rejected.repository.confirmEnrollment(
                enrollmentDraft().confirm(deviceLabel = "Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val rejectedRefresh = rejected.repository.prepareRefresh(rejectedActivation.profile)
            rejected.profiles.failNextCredentialVersionUpdate = true

            val rejectedResult = rejected.repository.applyRefreshResponse(
                rejectedRefresh,
                refreshResponse(rejectedRefresh, version = 2),
            ) as RelayV2RefreshApplyResult.ProfileReconciliationFailed
            assertEquals(2L, rejectedResult.credentialVersion)
            assertEquals(
                RelayV2CredentialReconciliationFailure.PROFILE_VERSION_UPDATE_REJECTED,
                rejectedResult.failure.failure,
            )
            assertEquals(1L, rejected.profiles.activeV2?.credentialVersion)

            val switched = Harness()
            val oldActivation = switched.repository.confirmEnrollment(
                enrollmentDraft().confirm(deviceLabel = "Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val lateRefresh = switched.repository.prepareRefresh(oldActivation.profile)
            val replacement = oldActivation.profile.copy(
                activationGeneration = oldActivation.profile.activationGeneration + 1,
            )
            assertEquals(oldActivation.profile.profileId, replacement.profileId)
            assertEquals(
                oldActivation.profile.credentialReference,
                replacement.credentialReference,
            )
            assertEquals(
                replacement,
                switched.profiles.forceActivateRelayV2Profile(
                    expectedActiveProfile = oldActivation.profile.identity,
                    profile = replacement,
                ),
            )
            val activationCountBeforeResponse = switched.profiles.activationCount

            assertEquals(
                RelayV2RefreshApplyResult.ActiveProfileChanged(
                    credentialVersion = null,
                    activeProfile = replacement.identity,
                ),
                switched.repository.applyRefreshResponse(
                    lateRefresh,
                    refreshResponse(lateRefresh, version = 2),
                ),
            )
            assertEquals(replacement, switched.profiles.activeV2)
            assertEquals(activationCountBeforeResponse, switched.profiles.activationCount)
            assertEquals(
                1L,
                switched.credentials.read(oldActivation.profile.credentialReference)?.credentialVersion,
            )
        }

    @Test
    fun `reconfirming same profile and credential is a no-op that keeps callback fence`() =
        runBlocking {
            val harness = Harness()
            val confirmed = enrollmentDraft().confirm(deviceLabel = "Pixel")
            val first = harness.repository.confirmEnrollment(confirmed) as RelayV2EnrollmentResult.Activated
            val firstIdentity = first.profile.identity
            val barrierCalls = harness.barrier.calls
            val isolationCalls = harness.isolationCalls
            val activationCalls = harness.profiles.activationCount

            val repeated = harness.repository.confirmEnrollment(confirmed) as RelayV2EnrollmentResult.Activated

            assertEquals(1, harness.exchange.redeemCalls)
            assertEquals(barrierCalls, harness.barrier.calls)
            assertEquals(isolationCalls, harness.isolationCalls)
            assertEquals(activationCalls, harness.profiles.activationCount)
            assertEquals(firstIdentity, repeated.profile.identity)
            assertNotNull(harness.credentials.read(first.profile.credentialReference))
            assertTrue(
                harness.profileSwitch.accepts(
                    RelayProfileCallbackScope(
                        profileId = firstIdentity.profileId,
                        activationGeneration = firstIdentity.activationGeneration,
                    ),
                ),
            )
            assertFalse(
                harness.profileSwitch.accepts(
                    RelayProfileCallbackScope(
                        profileId = firstIdentity.profileId,
                        activationGeneration = firstIdentity.activationGeneration - 1,
                    ),
                ),
            )
            assertFalse(
                harness.profileSwitch.accepts(
                    RelayProfileCallbackScope(
                        profileId = "legacy-v1",
                        activationGeneration = 0,
                    ),
                ),
            )

            val currentBlob = requireNotNull(
                harness.credentials.read(first.profile.credentialReference),
            )
            assertEquals(
                RelayV2CredentialCasResult.Updated(2),
                harness.credentials.compareAndSet(
                    first.profile.credentialReference,
                    RelayV2CredentialCasExpectation(
                        credentialVersion = 1,
                        pendingAttemptId = null,
                        pendingSecretReference = null,
                    ),
                    currentBlob.copy(credentialVersion = 2),
                ),
            )
            harness.profiles.failNextCredentialVersionUpdate = true
            assertTrue(runCatching { harness.repository.confirmEnrollment(confirmed) }.isFailure)
            assertEquals(null, harness.profiles.activeV2)
            assertEquals(
                RelayV2ProfileActivationPhase.CREDENTIAL_READY,
                harness.profiles.journal?.phase,
            )
            assertNotNull(harness.credentials.read(first.profile.credentialReference))
            assertEquals(isolationCalls, harness.isolationCalls)

            val recovered = harness.repository.confirmEnrollment(confirmed)
                as RelayV2EnrollmentResult.Activated
            assertEquals(2L, recovered.profile.credentialVersion)
            assertEquals(2L, harness.profiles.activeV2?.credentialVersion)
            assertEquals(null, harness.profiles.journal)
            assertEquals(isolationCalls, harness.isolationCalls)
        }

    private class Harness(
        blockDisconnect: Boolean = false,
        disconnectReceipt: ((RelayActiveProfileIdentity, String) -> RelayProfileDisconnectReceipt)? = null,
    ) {
        val events = mutableListOf<String>()
        val credentials = MemoryCredentialStore(events)
        val profiles = MemoryProfileStore(events)
        val barrier = RecordingDisconnectBarrier(events, blockDisconnect, disconnectReceipt)
        val isolation = RecordingIsolationBoundary(events, profiles, credentials)
        val isolationCalls: Int
            get() = isolation.calls
        val isolationReceipts: List<RelayProfileDisconnectReceipt>
            get() = isolation.receipts
        private val ids = AtomicInteger()
        private val idFactory = { "test-${ids.incrementAndGet()}" }
        val exchange = FakeCredentialExchange(events)
        var profileSwitch = newProfileSwitch()
            private set
        var repository = newRepository()
            private set

        fun restartRepository() {
            profileSwitch = newProfileSwitch()
            repository = newRepository()
        }

        private fun newProfileSwitch() = RelayV2ProfileSwitchStateMachine(
            profileStore = profiles,
            disconnectBarrier = barrier,
            isolationBoundary = isolation,
            newId = idFactory,
        )

        private fun newRepository() = RelayV2ProfileRepository(
            credentialStore = credentials,
            profileStore = profiles,
            profileSwitch = profileSwitch,
            exchange = exchange,
            clientInstanceId = "android-install-1",
            newId = idFactory,
        )
    }

    private class MemoryCredentialStore(
        private val events: MutableList<String>,
    ) : RelayV2CredentialStore {
        private val blobs = linkedMapOf<RelayV2CredentialReference, RelayV2CredentialBlob>()
        private val enrollmentCompletionCasCallsByReference =
            linkedMapOf<RelayV2CredentialReference, Int>()
        var failNextCasBeforeWriteCount = 0
        var failNextCasAfterWrite = false
        var failNextCasAfterWriteWithHigherVersion = false
        var failNextCasWithMissingBlob = false
        var failNextCasWithBindingMismatch = false
        var failNextCasWithAttemptMismatch = false
        var failNextCasWithSecretReferenceMismatch = false
        private var nextReadAfterSnapshotGate: BlockingGate? = null

        fun blockNextReadAfterSnapshot(): BlockingGate = synchronized(this) {
            check(nextReadAfterSnapshotGate == null)
            BlockingGate().also { nextReadAfterSnapshotGate = it }
        }

        override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? {
            val (snapshot, gate) = synchronized(this) {
                Pair(blobs[reference], nextReadAfterSnapshotGate).also {
                    nextReadAfterSnapshotGate = null
                }
            }
            gate?.block()
            return snapshot
        }

        @Synchronized
        override fun create(
            reference: RelayV2CredentialReference,
            blob: RelayV2CredentialBlob,
        ): Boolean {
            if (reference in blobs) return false
            blobs[reference] = blob
            return true
        }

        @Synchronized
        override fun compareAndSet(
            reference: RelayV2CredentialReference,
            expectation: RelayV2CredentialCasExpectation,
            replacement: RelayV2CredentialBlob,
        ): RelayV2CredentialCasResult = compareAndSetLocked(reference, expectation, replacement)

        private fun compareAndSetLocked(
            reference: RelayV2CredentialReference,
            expectation: RelayV2CredentialCasExpectation,
            replacement: RelayV2CredentialBlob,
        ): RelayV2CredentialCasResult {
            if (failNextCasBeforeWriteCount > 0) {
                failNextCasBeforeWriteCount -= 1
                error("Relay v2 credential CAS failed before write")
            }
            val current = blobs[reference]
                ?: return RelayV2CredentialCasResult.Stale(null)
            if (!current.matchesExpectation(expectation)) {
                return RelayV2CredentialCasResult.Stale(current.credentialVersion)
            }
            if (current.pendingAttempt?.kind ==
                RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE &&
                replacement.hasCredentialMaterial
            ) {
                enrollmentCompletionCasCallsByReference[reference] =
                    enrollmentCompletionCasCallsByReference.getOrDefault(reference, 0) + 1
            }
            if (failNextCasWithMissingBlob) {
                failNextCasWithMissingBlob = false
                blobs.remove(reference)
                error("Relay v2 credential disappeared during CAS")
            }
            if (failNextCasWithBindingMismatch) {
                failNextCasWithBindingMismatch = false
                blobs[reference] = replacement.copy(hostId = "different-host")
                error("Relay v2 credential binding changed during CAS")
            }
            if (failNextCasWithAttemptMismatch) {
                failNextCasWithAttemptMismatch = false
                blobs[reference] = replacement.copy(completedAttemptId = "different-attempt")
                error("Relay v2 credential attempt changed during CAS")
            }
            if (failNextCasWithSecretReferenceMismatch) {
                failNextCasWithSecretReferenceMismatch = false
                blobs[reference] = replacement.copy(
                    completedSecretReference = "different-secret-reference",
                )
                error("Relay v2 credential secret reference changed during CAS")
            }
            require(replacement.credentialVersion >= current.credentialVersion)
            blobs[reference] = replacement
            if (current.pendingAttempt?.kind ==
                RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE &&
                replacement.hasCredentialMaterial
            ) {
                events += "credential:ready"
            }
            if (failNextCasAfterWriteWithHigherVersion) {
                failNextCasAfterWriteWithHigherVersion = false
                blobs[reference] = replacement.copy(
                    credentialVersion = replacement.credentialVersion + 1,
                )
                error("Relay v2 credential CAS advanced before an ambiguous failure")
            }
            if (failNextCasAfterWrite) {
                failNextCasAfterWrite = false
                error("Relay v2 credential CAS outcome is ambiguous")
            }
            return RelayV2CredentialCasResult.Updated(replacement.credentialVersion)
        }

        private fun RelayV2CredentialBlob.matchesExpectation(
            expectation: RelayV2CredentialCasExpectation,
        ): Boolean = credentialVersion == expectation.credentialVersion &&
            pendingAttempt?.attemptId == expectation.pendingAttemptId &&
            pendingAttempt?.secretReference == expectation.pendingSecretReference

        @Synchronized
        override fun clear(reference: RelayV2CredentialReference) {
            blobs.remove(reference)
        }

        fun isEmpty(): Boolean = blobs.isEmpty()
        @Synchronized
        fun enrollmentCompletionCasCalls(reference: RelayV2CredentialReference): Int =
            enrollmentCompletionCasCallsByReference.getOrDefault(reference, 0)
        @Synchronized
        fun values(): List<RelayV2CredentialBlob> = blobs.values.toList()
        @Synchronized
        fun entries(): Map<RelayV2CredentialReference, RelayV2CredentialBlob> = blobs.toMap()
    }

    private class MemoryProfileStore(
        private val events: MutableList<String>,
    ) : RelayV2ProfileStore {
        private var storedActiveIdentity: RelayActiveProfileIdentity? = RelayActiveProfileIdentity(
            profileId = "legacy-v1",
            dialect = RelayProfileDialect.V1,
            activationGeneration = 0,
        )
        private var storedActiveV2: RelayV2Profile? = null
        var journal: RelayV2ProfileActivationJournal? = null
            private set
        val activeIdentity: RelayActiveProfileIdentity?
            get() = storedActiveIdentity.takeIf {
                journal == null || journal?.phase == RelayV2ProfileActivationPhase.PREPARED
            }
        val activeV2: RelayV2Profile?
            get() = storedActiveV2.takeIf {
                journal == null || journal?.phase == RelayV2ProfileActivationPhase.PREPARED
            }
        var activationCount = 0
        var failNextCredentialVersionUpdate = false
        var failNextPrepareBeforeWrite = false
        var failNextPrepareAfterWrite = false
        var failNextCredentialReadyBeforeWrite = false
        var failNextCredentialReadyAfterWrite = false
        var failNextProfilePublishBeforeWrite = false
        var failNextProfilePublishAfterWrite = false
        var persistedValues: Map<String, Any> = emptyMap()
        private var nextActiveProfileReadGate: SuspensionGate? = null
        private var nextPendingActivationReadGate: SuspensionGate? = null
        private var nextPreparedRollbackGate: SuspensionGate? = null
        private var nextProfilePublishReturnGate: SuspensionGate? = null
        private var nextCredentialVersionUpdateGate: SuspensionGate? = null

        fun blockNextActiveProfileRead(): SuspensionGate = SuspensionGate().also {
            check(nextActiveProfileReadGate == null)
            nextActiveProfileReadGate = it
        }

        fun blockNextPendingActivationReadAfterSnapshot(): SuspensionGate =
            SuspensionGate().also {
                check(nextPendingActivationReadGate == null)
                nextPendingActivationReadGate = it
            }

        fun blockNextPreparedRollback(): SuspensionGate = SuspensionGate().also {
            check(nextPreparedRollbackGate == null)
            nextPreparedRollbackGate = it
        }

        fun blockNextProfilePublishReturn(): SuspensionGate = SuspensionGate().also {
            check(nextProfilePublishReturnGate == null)
            nextProfilePublishReturnGate = it
        }

        fun blockNextCredentialVersionUpdate(): SuspensionGate = SuspensionGate().also {
            check(nextCredentialVersionUpdateGate == null)
            nextCredentialVersionUpdateGate = it
        }

        override suspend fun activeProfileIdentity(): RelayActiveProfileIdentity? {
            nextActiveProfileReadGate?.also {
                nextActiveProfileReadGate = null
                it.started.complete(Unit)
                it.release.await()
            }
            return activeIdentity
        }

        override suspend fun activeRelayV2Profile(): RelayV2Profile? = activeV2

        override suspend fun pendingRelayV2Activation(): RelayV2ProfileActivationJournal? {
            val snapshot = journal
            nextPendingActivationReadGate?.also {
                nextPendingActivationReadGate = null
                it.started.complete(Unit)
                it.release.await()
            }
            return snapshot
        }

        override suspend fun prepareRelayV2Activation(
            expectedActiveProfile: RelayActiveProfileIdentity?,
            operationId: String,
            profile: RelayV2Profile,
            targetBindingDigest: String,
            targetCredentialAttemptId: String,
            targetCredentialSecretReference: String,
            barrierId: String?,
            previousCredentialReference: RelayV2CredentialReference?,
        ): RelayV2ProfileActivationJournal? {
            if (failNextPrepareBeforeWrite) {
                failNextPrepareBeforeWrite = false
                error("Relay v2 activation prepare failed before write")
            }
            if (storedActiveIdentity != expectedActiveProfile) return null
            val current = journal
            val prepared = RelayV2ProfileActivationJournal(
                operationId = operationId,
                previousProfile = storedActiveIdentity,
                barrierId = barrierId,
                previousCredentialReference = previousCredentialReference,
                targetProfileId = profile.profileId,
                targetCredentialReference = profile.credentialReference,
                targetCredentialVersion = profile.credentialVersion,
                targetBindingDigest = targetBindingDigest,
                targetCredentialAttemptId = targetCredentialAttemptId,
                targetCredentialSecretReference = targetCredentialSecretReference,
                targetActivationGeneration = profile.activationGeneration,
                phase = RelayV2ProfileActivationPhase.PREPARED,
            )
            when {
                current == null -> journal = prepared
                current == prepared -> Unit
                else -> return null
            }
            if (failNextPrepareAfterWrite) {
                failNextPrepareAfterWrite = false
                error("Relay v2 activation prepare outcome is ambiguous")
            }
            return prepared
        }

        override suspend fun markRelayV2CredentialReady(
            operationId: String,
            proof: RelayV2CompletedCredentialProof,
        ): RelayV2ProfileActivationJournal? {
            if (failNextCredentialReadyBeforeWrite) {
                failNextCredentialReadyBeforeWrite = false
                error("Relay v2 credential-ready phase failed before write")
            }
            val current = journal?.takeIf { it.operationId == operationId } ?: return null
            if (storedActiveIdentity != current.previousProfile ||
                !current.targetsCredential(proof)
            ) return null
            val updated = when (current.phase) {
                RelayV2ProfileActivationPhase.PREPARED -> current.copy(
                    targetCredentialVersion = proof.credentialVersion,
                    phase = RelayV2ProfileActivationPhase.CREDENTIAL_READY,
                )
                RelayV2ProfileActivationPhase.CREDENTIAL_READY -> when {
                    proof.credentialVersion == current.targetCredentialVersion -> current
                    else -> current.copy(targetCredentialVersion = proof.credentialVersion)
                }
            }
            journal = updated
            if (failNextCredentialReadyAfterWrite) {
                failNextCredentialReadyAfterWrite = false
                error("Relay v2 credential-ready phase outcome is ambiguous")
            }
            return updated
        }

        override suspend fun rollbackPreparedRelayV2Activation(
            journal: RelayV2ProfileActivationJournal,
        ): Boolean {
            nextPreparedRollbackGate?.also {
                nextPreparedRollbackGate = null
                it.started.complete(Unit)
                it.release.await()
            }
            if (journal.phase != RelayV2ProfileActivationPhase.PREPARED ||
                this.journal != journal || storedActiveIdentity != journal.previousProfile
            ) return false
            this.journal = null
            return true
        }

        override suspend fun activateRelayV2Profile(
            journal: RelayV2ProfileActivationJournal,
            profile: RelayV2Profile,
        ): RelayV2Profile? {
            if (this.journal != journal ||
                journal.phase != RelayV2ProfileActivationPhase.CREDENTIAL_READY ||
                !journal.targets(profile) ||
                storedActiveIdentity != journal.previousProfile
            ) return null
            if (failNextProfilePublishBeforeWrite) {
                failNextProfilePublishBeforeWrite = false
                error("Relay v2 profile publish failed before write")
            }
            val resolved = resolveProfile(profile)
            publishProfile(resolved)
            this.journal = null
            nextProfilePublishReturnGate?.also {
                nextProfilePublishReturnGate = null
                it.started.complete(Unit)
                it.release.await()
            }
            if (failNextProfilePublishAfterWrite) {
                failNextProfilePublishAfterWrite = false
                error("Relay v2 profile publish outcome is ambiguous")
            }
            return resolved
        }

        fun forceActivateRelayV2Profile(
            expectedActiveProfile: RelayActiveProfileIdentity?,
            profile: RelayV2Profile,
        ): RelayV2Profile? {
            if (journal != null || storedActiveIdentity != expectedActiveProfile) return null
            val resolved = resolveProfile(profile)
            publishProfile(resolved)
            return resolved
        }

        fun destructiveActiveV2(): RelayV2Profile? = storedActiveV2

        private fun resolveProfile(profile: RelayV2Profile): RelayV2Profile {
            val current = storedActiveV2
            val sameActivation = current?.identity == profile.identity &&
                current.credentialReference == profile.credentialReference
            if (current != null &&
                sameActivation &&
                profile.credentialVersion > current.credentialVersion &&
                failNextCredentialVersionUpdate
            ) {
                failNextCredentialVersionUpdate = false
                error("Relay v2 credential version update was rejected")
            }
            val resolved = if (sameActivation) {
                requireNotNull(current).copy(
                    credentialVersion = maxOf(
                        current.credentialVersion,
                        profile.credentialVersion,
                    ),
                )
            } else {
                profile
            }
            return resolved
        }

        private fun publishProfile(resolved: RelayV2Profile) {
            val sameActivation = storedActiveV2?.identity == resolved.identity &&
                storedActiveV2?.credentialReference == resolved.credentialReference
            if (!sameActivation) {
                activationCount += 1
                events += "activate"
            }
            storedActiveV2 = resolved
            storedActiveIdentity = resolved.identity
            persistedValues = mapOf(
                "profileId" to resolved.profileId,
                "issuerUrl" to resolved.issuerUrl,
                "relayUrl" to resolved.relayUrl,
                "hostId" to resolved.hostId,
                "principalId" to resolved.principalId,
                "grantId" to resolved.grantId,
                "clientInstanceId" to resolved.clientInstanceId,
                "credentialReference" to resolved.credentialReference.value,
                "credentialVersion" to resolved.credentialVersion,
                "activationGeneration" to resolved.activationGeneration,
                "credentialKind" to "twcap2_grant",
                "offeredSubprotocol" to resolved.offeredSubprotocol,
            )
        }

        override suspend fun updateRelayV2CredentialVersion(
            profileId: String,
            credentialReference: RelayV2CredentialReference,
            expectedActivationGeneration: Long,
            expectedVersion: Long,
            newVersion: Long,
        ): Boolean {
            if (failNextCredentialVersionUpdate) {
                failNextCredentialVersionUpdate = false
                return false
            }
            if (journal?.phase?.let { it != RelayV2ProfileActivationPhase.PREPARED } == true) {
                return false
            }
            val current = storedActiveV2 ?: return false
            if (current.profileId != profileId ||
                current.credentialReference != credentialReference ||
                current.activationGeneration != expectedActivationGeneration ||
                current.credentialVersion != expectedVersion
            ) return false
            nextCredentialVersionUpdateGate?.also {
                nextCredentialVersionUpdateGate = null
                it.started.complete(Unit)
                it.release.await()
            }
            val updated = current.copy(credentialVersion = newVersion)
            storedActiveV2 = updated
            storedActiveIdentity = updated.identity
            persistedValues = persistedValues + ("credentialVersion" to newVersion)
            return true
        }
    }

    private class RecordingDisconnectBarrier(
        private val events: MutableList<String>,
        blocked: Boolean,
        private val receiptFactory: ((
            RelayActiveProfileIdentity,
            String,
        ) -> RelayProfileDisconnectReceipt)?,
    ) : RelayProfileDisconnectBarrier {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var calls = 0
        var returnedReceipt: RelayProfileDisconnectReceipt? = null
        private var nextGate: SuspensionGate? = null

        init {
            if (!blocked) release.complete(Unit)
        }

        fun blockNextDisconnect(): SuspensionGate = SuspensionGate().also {
            check(nextGate == null)
            nextGate = it
        }

        override suspend fun disconnectAndDrain(
            profile: RelayActiveProfileIdentity,
            barrierId: String,
        ): RelayProfileDisconnectReceipt {
            calls += 1
            events += "disconnect:start"
            started.complete(Unit)
            release.await()
            nextGate?.also { gate ->
                nextGate = null
                gate.started.complete(Unit)
                gate.release.await()
            }
            events += "disconnect:end"
            return (receiptFactory?.invoke(profile, barrierId)
                ?: RelayProfileDisconnectReceipt(profile, barrierId)).also {
                returnedReceipt = it
            }
        }
    }

    private class RecordingIsolationBoundary(
        private val events: MutableList<String>,
        private val profiles: MemoryProfileStore,
        private val credentials: MemoryCredentialStore,
    ) : RelayProfileIsolationBoundary {
        var calls = 0
        var failNextAfterDestructiveMutation = false
        val receipts = mutableListOf<RelayProfileDisconnectReceipt>()
        private var nextGate: SuspensionGate? = null

        fun blockNextIsolation(): SuspensionGate = SuspensionGate().also {
            check(nextGate == null)
            nextGate = it
        }

        override suspend fun clearAfterDisconnect(
            receipt: RelayProfileDisconnectReceipt,
            previousCredentialReference: RelayV2CredentialReference?,
        ) {
            calls += 1
            receipts += receipt
            events += "clear"
            // Model the real boundary's credential deletion responsibility before pausing.
            profiles.destructiveActiveV2()
                ?.takeIf { it.identity == receipt.profile }
                ?.let { previous ->
                    require(previous.credentialReference == previousCredentialReference)
                    credentials.clear(previous.credentialReference)
                }
            if (failNextAfterDestructiveMutation) {
                failNextAfterDestructiveMutation = false
                error("Relay v2 isolation failed after destructive mutation")
            }
            nextGate?.also {
                nextGate = null
                it.started.complete(Unit)
                it.release.await()
            }
        }
    }

    private class FakeCredentialExchange(
        private val events: MutableList<String>,
    ) : RelayV2CredentialExchange {
        var redeemCalls = 0
        private var nowMs = 0L
        private val deferredRedeems = linkedMapOf<String, DeferredRedeem>()
        private val enrollmentCodeOwners = linkedMapOf<String, String>()
        private val completedAttempts = linkedMapOf<String, CompletedRedeem>()

        fun advanceReplayTimeBy(durationMs: Long) {
            require(durationMs >= 0)
            nowMs += durationMs
        }

        fun deferEnrollment(enrollmentId: String): DeferredRedeem = DeferredRedeem().also {
            check(deferredRedeems.put(enrollmentId, it) == null)
        }

        fun enrollmentCodeConsumptions(code: String): Int =
            if (enrollmentCodeOwners.containsKey(code)) 1 else 0

        fun completedResponse(attemptId: String): RelayV2EnrollmentExchangeResponse =
            requireNotNull(completedAttempts[attemptId]).response

        override suspend fun redeem(
            request: RelayV2EnrollmentExchangeRequest,
        ): RelayV2EnrollmentExchangeResponse {
            redeemCalls += 1
            events += "exchange"
            val completed = completedAttempts[request.exchangeAttemptId]
            require(completed == null || nowMs - completed.completedAtMs <= REPLAY_TTL_MS) {
                "Enrollment replay expired"
            }
            val attemptOwner = enrollmentCodeOwners[request.enrollmentCode]
            require(attemptOwner == null || attemptOwner == request.exchangeAttemptId) {
                "Enrollment code was already consumed by another attempt"
            }
            enrollmentCodeOwners[request.enrollmentCode] = request.exchangeAttemptId
            deferredRedeems[request.enrollmentId]?.let { deferred ->
                deferred.record(request)
                return deferred.response.await().also { response ->
                    require(response.exchangeAttemptId == request.exchangeAttemptId)
                    require(completed == null || completed.response == response) {
                        "Exact enrollment attempt replay changed its completed result"
                    }
                    completedAttempts.putIfAbsent(
                        request.exchangeAttemptId,
                        CompletedRedeem(response, nowMs),
                    )
                }
            }
            completed?.let { return it.response }
            return RelayV2EnrollmentExchangeResponse(
                exchangeAttemptId = request.exchangeAttemptId,
                principalId = "principal-1",
                grantId = "grant-1",
                hostId = "mac-admin",
                relayUrl = "wss://relay.example.com/client",
                accessToken = ACCESS_TOKEN_1,
                accessExpiresAtMs = 2_000,
                refreshToken = REFRESH_TOKEN_1,
                refreshExpiresAtMs = 3_000,
            ).also {
                completedAttempts[request.exchangeAttemptId] = CompletedRedeem(it, nowMs)
            }
        }

        override suspend fun refresh(request: RelayV2RefreshRequest): RelayV2RefreshResponse =
            error("No production or fake refresh call is needed by these state-machine cases")

        private data class CompletedRedeem(
            val response: RelayV2EnrollmentExchangeResponse,
            val completedAtMs: Long,
        )

        private companion object {
            const val REPLAY_TTL_MS = 10 * 60 * 1_000L
        }
    }

    private class DeferredRedeem {
        val request = CompletableDeferred<RelayV2EnrollmentExchangeRequest>()
        val replayRequest = CompletableDeferred<RelayV2EnrollmentExchangeRequest>()
        val response = CompletableDeferred<RelayV2EnrollmentExchangeResponse>()

        fun record(value: RelayV2EnrollmentExchangeRequest) {
            if (!request.complete(value)) replayRequest.complete(value)
        }
    }

    private class SuspensionGate {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
    }

    private class BlockingGate {
        private val started = CountDownLatch(1)
        private val released = CountDownLatch(1)

        fun awaitStarted() {
            check(started.await(5, TimeUnit.SECONDS)) {
                "Timed out waiting for the credential read gate"
            }
        }

        fun block() {
            started.countDown()
            check(released.await(5, TimeUnit.SECONDS)) {
                "Timed out waiting to release the credential read gate"
            }
        }

        fun release() {
            released.countDown()
        }
    }

    private suspend fun assertSameReferenceRetryRedeems(
        harness: Harness,
        confirmed: RelayV2ConfirmedEnrollment,
        enrollmentId: String,
        expectedActive: RelayActiveProfileIdentity?,
    ) = coroutineScope {
        val pendingBeforeRetry = harness.credentials.values().single {
            it.pendingAttempt?.enrollmentId == enrollmentId
        }
        val redeemCallsBeforeRetry = harness.exchange.redeemCalls
        val retryGate = harness.exchange.deferEnrollment(enrollmentId)
        val retry = async { harness.repository.confirmEnrollment(confirmed) }
        val retryRequest = withTimeout(1_000) { retryGate.request.await() }

        assertEquals(redeemCallsBeforeRetry + 1, harness.exchange.redeemCalls)
        assertEquals(pendingBeforeRetry.pendingAttempt?.attemptId, retryRequest.exchangeAttemptId)
        assertTrue(harness.repository.cancelPendingEnrollment(confirmed))
        retryGate.response.complete(
            harness.exchange.completedResponse(retryRequest.exchangeAttemptId),
        )
        assertTrue(retry.await() is RelayV2EnrollmentResult.Superseded)
        assertEquals(pendingBeforeRetry, harness.credentials.values().single {
            it.pendingAttempt?.enrollmentId == enrollmentId
        })
        assertFalse(pendingBeforeRetry.hasCredentialMaterial)
        assertEquals(expectedActive, harness.profiles.activeIdentity)
    }

    private enum class EnrollmentResponseOrder {
        A_FIRST,
        B_FIRST,
    }

    private enum class DuringIsolationInterleaving {
        CANCEL_A,
        CONFIRM_B,
    }

    private enum class CompletedPreparedFollowUp {
        CONFIRM_B,
        CANCEL_A,
        CONFIRM_A_AGAIN,
    }

    private enum class ActivationPreCommitFailure {
        PREPARE,
        CREDENTIAL_CAS,
        CREDENTIAL_READY,
        ISOLATION,
        PROFILE_PUBLISH,
    }

    private enum class ActivationPostCommitAmbiguity {
        PREPARE,
        CREDENTIAL_CAS,
        CREDENTIAL_READY,
        PROFILE_PUBLISH,
    }

    private enum class CredentialCasCorruption {
        MISSING,
        BINDING_MISMATCH,
        ATTEMPT_MISMATCH,
        SECRET_REFERENCE_MISMATCH,
    }

    private enum class StartupUnavailableCase {
        MISSING,
        BINDING_MISMATCH,
        BLOB_BEHIND,
        REPAIR_CONFLICT,
    }

    private fun relayV2Profile(): RelayV2Profile = RelayV2Profile(
        profileId = "relay-v2-profile-1",
        issuerUrl = "https://relay.example.com",
        relayUrl = "wss://relay.example.com/client",
        hostId = "mac-admin",
        principalId = "principal-1",
        grantId = "grant-1",
        clientInstanceId = "android-install-1",
        credentialReference = RelayV2CredentialReference("credential-reference-1"),
        credentialVersion = 4,
        activationGeneration = 7,
    )

    private fun Preferences.valueNamed(name: String): Any? =
        asMap().entries.singleOrNull { it.key.name == name }?.value

    private fun Preferences.namedValues(): Map<String, Any> =
        asMap().entries.associate { it.key.name to it.value }

    private suspend fun <T> withPreferencesStore(
        file: java.io.File,
        block: suspend (PreferencesStore) -> T,
    ): T {
        val job = SupervisorJob()
        val dataStore = PreferenceDataStoreFactory.create(
            scope = CoroutineScope(job + Dispatchers.IO),
            produceFile = { file },
        )
        return try {
            block(PreferencesStore(dataStore))
        } finally {
            job.cancelAndJoin()
        }
    }

    private suspend fun assertV1ProfileMutationsRejected(preferences: PreferencesStore) {
        val mutations = listOf<suspend () -> Unit>(
            {
                preferences.saveProfile(
                    relayUrl = "wss://write-through.example.com/client",
                    hostId = "write-through-host",
                    autoConnect = true,
                )
            },
            { preferences.setPreferredHost("write-through-host") },
            {
                preferences.setPreferredHostAndScope(
                    "write-through-host",
                    "write-through-scope",
                )
            },
            { preferences.setPreferredScope("write-through-scope") },
            { preferences.setAutoConnect(true) },
            { preferences.clearProfile() },
        )
        mutations.forEach { mutate ->
            assertTrue(runCatching { mutate() }.isFailure)
        }
    }

    private fun RelayV2CredentialBlob.expectation(): RelayV2CredentialCasExpectation =
        RelayV2CredentialCasExpectation(
            credentialVersion = credentialVersion,
            pendingAttemptId = pendingAttempt?.attemptId,
            pendingSecretReference = pendingAttempt?.secretReference,
        )

    private fun enrollmentDraft(
        enrollmentId: String = "enrollment-1",
        enrollmentCode: String = ENROLLMENT_CODE,
    ): RelayV2EnrollmentReviewDraft =
        requireNotNull(
            RelayV2EnrollmentReviewParser.parse(
                "tmuxworktree://enroll?v=2" +
                    "&issuerUrl=https%3A%2F%2Frelay.example.com" +
                    "&relayUrl=wss%3A%2F%2Frelay.example.com%2Fclient" +
                    "&hostId=mac-admin" +
                    "&enrollmentId=$enrollmentId" +
                    "&enrollmentCode=$enrollmentCode",
            ),
        )

    private fun enrollmentResponse(
        request: RelayV2EnrollmentExchangeRequest,
        identitySuffix: String,
    ): RelayV2EnrollmentExchangeResponse = RelayV2EnrollmentExchangeResponse(
        exchangeAttemptId = request.exchangeAttemptId,
        principalId = "principal-$identitySuffix",
        grantId = "grant-$identitySuffix",
        hostId = "mac-admin",
        relayUrl = "wss://relay.example.com/client",
        accessToken = "twcap2.access-$identitySuffix",
        accessExpiresAtMs = 2_000,
        refreshToken = "twref2.refresh-$identitySuffix",
        refreshExpiresAtMs = 3_000,
    )

    private fun refreshResponse(
        prepared: RelayV2PreparedRefresh,
        version: Int,
    ): RelayV2RefreshResponse = RelayV2RefreshResponse(
        refreshAttemptId = prepared.request.refreshAttemptId,
        principalId = "principal-1",
        grantId = "grant-1",
        hostId = "mac-admin",
        relayUrl = "wss://relay.example.com/client",
        accessToken = "twcap2.access-$version",
        accessExpiresAtMs = 2_000L + version,
        refreshToken = "twref2.refresh-$version",
        refreshExpiresAtMs = 3_000L + version,
    )

    private fun readPendingKindTag(bytes: ByteArray): Int {
        val input = ByteArrayInputStream(bytes)
        val data = DataInputStream(input)
        skipCredentialPrefix(data)
        return data.readInt()
    }

    private fun pendingKindOffset(bytes: ByteArray): Int {
        val input = ByteArrayInputStream(bytes)
        skipCredentialPrefix(DataInputStream(input))
        return bytes.size - input.available()
    }

    private fun skipCredentialPrefix(data: DataInputStream) {
        data.readInt()
        data.readLong()
        repeat(4) { data.skipBoundedString() }
        repeat(3) { data.skipNullableString() }
        data.skipNullableLong()
        data.skipNullableString()
        data.skipNullableLong()
        assertTrue(data.readBoolean())
    }

    private fun DataInputStream.skipBoundedString() {
        val size = readInt()
        assertEquals(size, skipBytes(size))
    }

    private fun DataInputStream.skipNullableString() {
        if (readBoolean()) skipBoundedString()
    }

    private fun DataInputStream.skipNullableLong() {
        if (readBoolean()) readLong()
    }

    private companion object {
        const val ENROLLMENT_CODE = "twenroll2.one-time-code"
        const val ACCESS_TOKEN_1 = "twcap2.access-1"
        const val REFRESH_TOKEN_1 = "twref2.refresh-1"
    }
}
