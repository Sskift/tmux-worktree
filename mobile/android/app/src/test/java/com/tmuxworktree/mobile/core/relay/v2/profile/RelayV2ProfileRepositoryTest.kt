package com.tmuxworktree.mobile.core.relay.v2.profile

import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import com.tmuxworktree.mobile.core.data.RelayProfilePreferencesCodec
import com.tmuxworktree.mobile.core.data.RelayV2CredentialBlobCodec
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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

        val unknownTag = exchangeBytes.copyOf()
        ByteBuffer.wrap(unknownTag).putInt(pendingKindOffset(unknownTag), 99)
        assertTrue(runCatching { RelayV2CredentialBlobCodec.decode(unknownTag) }.isFailure)
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
            assertTrue(harness.credentials.values().single().hasCredentialMaterial)

            harness.barrier.release.complete(Unit)
            val result = activation.await() as RelayV2EnrollmentResult.Activated
            val profile = result.profile

            assertEquals(RelayV2CredentialKind.TW_CAP2_GRANT, profile.credentialKind)
            assertEquals(RelayV2Profile.RELAY_V2_SUBPROTOCOL, profile.offeredSubprotocol)
            assertFalse(profile.autoConnect)
            assertEquals(
                listOf("exchange", "disconnect:start", "disconnect:end", "clear", "activate"),
                harness.events,
            )

            val nonSensitivePersistence = harness.profiles.persistedValues.values.joinToString("|")
            assertFalse(nonSensitivePersistence.contains(ENROLLMENT_CODE))
            assertFalse(nonSensitivePersistence.contains(ACCESS_TOKEN_1))
            assertFalse(nonSensitivePersistence.contains(REFRESH_TOKEN_1))
            val secureBlob = harness.credentials.read(profile.credentialReference)
            assertEquals(ACCESS_TOKEN_1, secureBlob?.accessToken)
            assertEquals(REFRESH_TOKEN_1, secureBlob?.refreshToken)
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
            switched.profiles.activateRelayV2Profile(replacement)
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
            assertEquals(1L, harness.profiles.activeV2?.credentialVersion)
            assertNotNull(harness.credentials.read(first.profile.credentialReference))
            assertEquals(isolationCalls, harness.isolationCalls)
        }

    private class Harness(blockDisconnect: Boolean = false) {
        val events = mutableListOf<String>()
        val credentials = MemoryCredentialStore()
        val profiles = MemoryProfileStore(events)
        val barrier = RecordingDisconnectBarrier(events, blockDisconnect)
        var isolationCalls = 0
        private val ids = AtomicInteger()
        private val idFactory = { "test-${ids.incrementAndGet()}" }
        val exchange = FakeCredentialExchange(events)
        val profileSwitch = RelayV2ProfileSwitchStateMachine(
            profileStore = profiles,
            disconnectBarrier = barrier,
            isolationBoundary = RelayProfileIsolationBoundary { previous ->
                isolationCalls += 1
                events += "clear"
                // Model the real boundary's credential deletion responsibility. If the state
                // machine calls this for the same target, this deliberately removes that target.
                profiles.activeV2
                    ?.takeIf { it.identity == previous }
                    ?.let { credentials.clear(it.credentialReference) }
            },
            newId = idFactory,
        )
        val repository = RelayV2ProfileRepository(
            credentialStore = credentials,
            profileStore = profiles,
            profileSwitch = profileSwitch,
            exchange = exchange,
            clientInstanceId = "android-install-1",
            newId = idFactory,
        )
    }

    private class MemoryCredentialStore : RelayV2CredentialStore {
        private val blobs = linkedMapOf<RelayV2CredentialReference, RelayV2CredentialBlob>()

        @Synchronized
        override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? =
            blobs[reference]

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
        ): RelayV2CredentialCasResult {
            val current = blobs[reference]
                ?: return RelayV2CredentialCasResult.Stale(null)
            if (current.credentialVersion != expectation.credentialVersion ||
                current.pendingAttempt?.attemptId != expectation.pendingAttemptId ||
                current.pendingAttempt?.secretReference != expectation.pendingSecretReference
            ) {
                return RelayV2CredentialCasResult.Stale(current.credentialVersion)
            }
            require(replacement.credentialVersion >= current.credentialVersion)
            blobs[reference] = replacement
            return RelayV2CredentialCasResult.Updated(replacement.credentialVersion)
        }

        @Synchronized
        override fun clear(reference: RelayV2CredentialReference) {
            blobs.remove(reference)
        }

        fun isEmpty(): Boolean = blobs.isEmpty()
        fun values(): List<RelayV2CredentialBlob> = blobs.values.toList()
    }

    private class MemoryProfileStore(
        private val events: MutableList<String>,
    ) : RelayV2ProfileStore {
        var activeIdentity: RelayActiveProfileIdentity? = RelayActiveProfileIdentity(
            profileId = "legacy-v1",
            dialect = RelayProfileDialect.V1,
            activationGeneration = 0,
        )
        var activeV2: RelayV2Profile? = null
        var activationCount = 0
        var failNextCredentialVersionUpdate = false
        var persistedValues: Map<String, Any> = emptyMap()

        override suspend fun activeProfileIdentity(): RelayActiveProfileIdentity? = activeIdentity

        override suspend fun activeRelayV2Profile(): RelayV2Profile? = activeV2

        override suspend fun activateRelayV2Profile(profile: RelayV2Profile) {
            activationCount += 1
            events += "activate"
            activeV2 = profile
            activeIdentity = profile.identity
            persistedValues = mapOf(
                "profileId" to profile.profileId,
                "issuerUrl" to profile.issuerUrl,
                "relayUrl" to profile.relayUrl,
                "hostId" to profile.hostId,
                "principalId" to profile.principalId,
                "grantId" to profile.grantId,
                "clientInstanceId" to profile.clientInstanceId,
                "credentialReference" to profile.credentialReference.value,
                "credentialVersion" to profile.credentialVersion,
                "activationGeneration" to profile.activationGeneration,
                "credentialKind" to "twcap2_grant",
                "offeredSubprotocol" to profile.offeredSubprotocol,
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
            val current = activeV2 ?: return false
            if (current.profileId != profileId ||
                current.credentialReference != credentialReference ||
                current.activationGeneration != expectedActivationGeneration ||
                current.credentialVersion != expectedVersion
            ) return false
            val updated = current.copy(credentialVersion = newVersion)
            activeV2 = updated
            activeIdentity = updated.identity
            persistedValues = persistedValues + ("credentialVersion" to newVersion)
            return true
        }
    }

    private class RecordingDisconnectBarrier(
        private val events: MutableList<String>,
        blocked: Boolean,
    ) : RelayProfileDisconnectBarrier {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var calls = 0

        init {
            if (!blocked) release.complete(Unit)
        }

        override suspend fun disconnectAndDrain(
            profile: RelayActiveProfileIdentity,
            barrierId: String,
        ): RelayProfileDisconnectReceipt {
            calls += 1
            events += "disconnect:start"
            started.complete(Unit)
            release.await()
            events += "disconnect:end"
            return RelayProfileDisconnectReceipt(profile, barrierId)
        }
    }

    private class FakeCredentialExchange(
        private val events: MutableList<String>,
    ) : RelayV2CredentialExchange {
        var redeemCalls = 0

        override suspend fun redeem(
            request: RelayV2EnrollmentExchangeRequest,
        ): RelayV2EnrollmentExchangeResponse {
            redeemCalls += 1
            events += "exchange"
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
            )
        }

        override suspend fun refresh(request: RelayV2RefreshRequest): RelayV2RefreshResponse =
            error("No production or fake refresh call is needed by these state-machine cases")
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

    private fun RelayV2CredentialBlob.expectation(): RelayV2CredentialCasExpectation =
        RelayV2CredentialCasExpectation(
            credentialVersion = credentialVersion,
            pendingAttemptId = pendingAttempt?.attemptId,
            pendingSecretReference = pendingAttempt?.secretReference,
        )

    private fun enrollmentDraft(): RelayV2EnrollmentReviewDraft =
        requireNotNull(
            RelayV2EnrollmentReviewParser.parse(
                "tmuxworktree://enroll?v=2" +
                    "&issuerUrl=https%3A%2F%2Frelay.example.com" +
                    "&relayUrl=wss%3A%2F%2Frelay.example.com%2Fclient" +
                    "&hostId=mac-admin" +
                    "&enrollmentId=enrollment-1" +
                    "&enrollmentCode=$ENROLLMENT_CODE",
            ),
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
