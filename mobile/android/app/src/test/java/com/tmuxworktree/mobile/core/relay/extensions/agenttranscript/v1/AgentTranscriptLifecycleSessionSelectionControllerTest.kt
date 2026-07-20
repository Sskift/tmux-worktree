package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadAuthorityPort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadCut
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadCutResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadLeaseResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryReadCapability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AppliedCursor
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeReachability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleSessionSelectionControllerTest {
    @Test
    fun `unavailable acquire and stale lease never read repository or run selection`() =
        runBlocking {
            val namespace = namespace()
            val cut = readCut(authority(namespace))
            listOf(
                "unavailable" to FakeReadAuthority(
                    RelayV2CurrentRepositoryReadCutResult.Unavailable,
                ),
                "stale" to FakeReadAuthority(
                    RelayV2CurrentRepositoryReadCutResult.Available(cut),
                    staleLease = true,
                ),
            ).forEach { (scenario, readAuthority) ->
                val repositoryReads = AtomicInteger(0)
                val selectionBlocks = AtomicInteger(0)
                val controller = AgentTranscriptLifecycleSessionSelectionController(
                    readAuthority = readAuthority,
                    stateRepositoryRead = { _, _, _ ->
                        repositoryReads.incrementAndGet()
                        materializedCut(namespace)
                    },
                )

                val result = controller.withCurrentSession(intent(namespace)) {
                    selectionBlocks.incrementAndGet()
                }

                if (scenario == "unavailable") {
                    assertEquals(AgentTranscriptLifecycleCurrentSessionResult.Unavailable, result)
                    assertEquals(0, readAuthority.leaseCalls)
                } else {
                    assertEquals(AgentTranscriptLifecycleCurrentSessionResult.Stale, result)
                    assertEquals(1, readAuthority.leaseCalls)
                }
                assertEquals(0, readAuthority.leasedBlockExecutions)
                assertEquals(0, repositoryReads.get())
                assertEquals(0, selectionBlocks.get())
                assertEquals(
                    listOf(RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE),
                    readAuthority.requestedCapabilities,
                )
            }
        }

    @Test
    fun `exact selection reads and runs only inside lease with complete authority and cut`() =
        runBlocking {
            val namespace = namespace()
            val authority = authority(namespace)
            val materialized = materializedCut(namespace)
            val readAuthority = FakeReadAuthority(
                RelayV2CurrentRepositoryReadCutResult.Available(readCut(authority)),
            )
            var repositoryReads = 0
            val controller = AgentTranscriptLifecycleSessionSelectionController(
                readAuthority = readAuthority,
                stateRepositoryRead = { requestedNamespace, scopeId, sessionId ->
                    assertTrue(readAuthority.inLease)
                    assertEquals(namespace, requestedNamespace)
                    assertEquals("scope-a", scopeId)
                    assertEquals("session-a", sessionId)
                    repositoryReads += 1
                    materialized
                },
            )

            val result = controller.withCurrentSession(intent(namespace)) { selection ->
                assertTrue(readAuthority.inLease)
                assertEquals(authority, selection.authority)
                assertEquals(materialized, selection.materializedCut)
                "selected"
            }

            assertEquals(
                AgentTranscriptLifecycleCurrentSessionResult.Current("selected"),
                result,
            )
            assertEquals(1, repositoryReads)
            assertEquals(1, readAuthority.leasedBlockExecutions)
            assertFalse(readAuthority.inLease)
        }

    @Test
    fun `authority mismatches avoid repository and opaque mismatches never select by display name`() =
        runBlocking {
            val namespace = namespace()
            val readAuthority = FakeReadAuthority(
                RelayV2CurrentRepositoryReadCutResult.Available(
                    readCut(authority(namespace)),
                ),
            )
            val repositoryReads = AtomicInteger(0)
            val selectionBlocks = AtomicInteger(0)
            val materialized = materializedCut(namespace, displayName = "same-display-name")
            val controller = AgentTranscriptLifecycleSessionSelectionController(
                readAuthority = readAuthority,
                stateRepositoryRead = { _, _, _ ->
                    repositoryReads.incrementAndGet()
                    materialized
                },
            )

            listOf(
                namespace.copy(profileId = "profile-other"),
                namespace.copy(principalId = "principal-other"),
                namespace.copy(clientInstanceId = "client-other"),
                namespace.copy(hostId = "host-other"),
                namespace.copy(hostEpoch = "epoch-other"),
            ).forEach { mismatchedNamespace ->
                assertEquals(
                    AgentTranscriptLifecycleCurrentSessionResult.Unavailable,
                    controller.withCurrentSession(intent(mismatchedNamespace)) {
                        selectionBlocks.incrementAndGet()
                    },
                )
            }
            assertEquals(0, repositoryReads.get())
            assertEquals(0, selectionBlocks.get())

            listOf(
                intent(namespace).copy(scopeId = "scope-other"),
                intent(namespace).copy(sessionId = "session-other"),
            ).forEach { mismatchedOpaqueId ->
                assertEquals(
                    AgentTranscriptLifecycleCurrentSessionResult.Unavailable,
                    controller.withCurrentSession(mismatchedOpaqueId) {
                        selectionBlocks.incrementAndGet()
                    },
                )
            }
            assertEquals(2, repositoryReads.get())
            assertEquals(0, selectionBlocks.get())
        }

    @Test
    fun `missing repository cut is unavailable and block failures propagate unchanged`() =
        runBlocking {
            val namespace = namespace()
            val materialized = materializedCut(namespace)
            val readAuthority = FakeReadAuthority(
                RelayV2CurrentRepositoryReadCutResult.Available(
                    readCut(authority(namespace)),
                ),
            )
            var returnMaterialized = false
            var selectionBlocks = 0
            val controller = AgentTranscriptLifecycleSessionSelectionController(
                readAuthority = readAuthority,
                stateRepositoryRead = { _, _, _ ->
                    if (returnMaterialized) materialized else null
                },
            )

            assertEquals(
                AgentTranscriptLifecycleCurrentSessionResult.Unavailable,
                controller.withCurrentSession(intent(namespace)) {
                    selectionBlocks += 1
                },
            )
            assertEquals(0, selectionBlocks)

            returnMaterialized = true
            val failure = IllegalStateException("selection failed")
            assertSame(
                failure,
                runCatching {
                    controller.withCurrentSession(intent(namespace)) { throw failure }
                }.exceptionOrNull(),
            )
            val cancellation = CancellationException("selection cancelled")
            assertSame(
                cancellation,
                runCatching {
                    controller.withCurrentSession(intent(namespace)) { throw cancellation }
                }.exceptionOrNull(),
            )
            assertFalse(readAuthority.inLease)
        }

    private fun namespace() = RelayV2StateNamespace(
        profileId = "profile-a",
        principalId = "principal-a",
        clientInstanceId = "client-a",
        hostId = "host-a",
        hostEpoch = "epoch-a",
    )

    private fun intent(namespace: RelayV2StateNamespace) =
        AgentTranscriptLifecycleSessionSelectionIntent(
            namespace = namespace,
            scopeId = "scope-a",
            sessionId = "session-a",
        )

    private fun authority(
        namespace: RelayV2StateNamespace,
    ) = RelayV2RepositoryEffectAuthority(
        generation = RelayV2EffectGeneration(
            profileId = namespace.profileId,
            profileGeneration = 7,
            connectionGeneration = 11,
        ),
        profileId = namespace.profileId,
        profileActivationGeneration = 7,
        principalId = namespace.principalId,
        clientInstanceId = namespace.clientInstanceId,
        hostId = namespace.hostId,
        hostEpoch = namespace.hostEpoch,
    )

    private fun readCut(
        authority: RelayV2RepositoryEffectAuthority,
    ) = object : RelayV2CurrentRepositoryReadCut {
        override val authority = authority
        override val capability = RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE
    }

    private fun materializedCut(
        namespace: RelayV2StateNamespace,
        scopeId: String = "scope-a",
        sessionId: String = "session-a",
        displayName: String = "Session",
    ): RelayV2MaterializedSessionReadCut {
        val scope = RelayV2ScopeResource(
            scopeId = scopeId,
            displayName = "Scope",
            kind = RelayV2ScopeKind.LOCAL,
            reachability = RelayV2ScopeReachability.ONLINE,
        )
        val session = RelayV2SessionResource(
            scopeId = scopeId,
            sessionId = sessionId,
            kind = RelayV2SessionKind.WORKTREE,
            displayName = displayName,
            project = "project",
            label = null,
            cwd = "/repo",
            attached = false,
            windowCount = 1,
            createdAtMs = 1,
            activityAtMs = 2,
        )
        return RelayV2MaterializedSessionReadCut(
            namespace = namespace,
            cursor = RelayV2AppliedCursor(namespace.hostEpoch, "5"),
            scopesRevision = "7",
            scope = scope,
            sessionsRevision = "9",
            session = session,
        )
    }

    private class FakeReadAuthority(
        private val acquired: RelayV2CurrentRepositoryReadCutResult,
        private val staleLease: Boolean = false,
    ) : RelayV2CurrentRepositoryReadAuthorityPort {
        val requestedCapabilities = mutableListOf<RelayV2RepositoryReadCapability>()
        var leaseCalls = 0
        var leasedBlockExecutions = 0
        var inLease = false

        override fun currentRepositoryReadCut(
            capability: RelayV2RepositoryReadCapability,
        ): RelayV2CurrentRepositoryReadCutResult {
            requestedCapabilities += capability
            return acquired
        }

        override suspend fun <T> withCurrentRepositoryReadLease(
            cut: RelayV2CurrentRepositoryReadCut,
            block: suspend () -> T,
        ): RelayV2CurrentRepositoryReadLeaseResult<T> {
            leaseCalls += 1
            if (staleLease) return RelayV2CurrentRepositoryReadLeaseResult.Stale
            inLease = true
            return try {
                leasedBlockExecutions += 1
                RelayV2CurrentRepositoryReadLeaseResult.Current(block())
            } finally {
                inLease = false
            }
        }
    }
}
