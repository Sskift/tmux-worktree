package com.tmuxworktree.mobile.app

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.ComposeNavigator
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.testing.TestNavHostController
import com.tmuxworktree.mobile.app.navigation.V2Routes
import com.tmuxworktree.mobile.app.navigation.creationFormRouteToDismiss
import com.tmuxworktree.mobile.app.navigation.createdSessionDestinationRoute
import com.tmuxworktree.mobile.app.navigation.navigateAfterCreation
import com.tmuxworktree.mobile.app.navigation.relaySessionDestinations
import com.tmuxworktree.mobile.core.model.RelaySession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class CreationNavigationInstrumentedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun worktreeSuccessRemovesSubmittedFormFromBackStack() {
        val navController = installCreationGraph()

        composeRule.runOnIdle { navController.navigate(V2Routes.NEW_WORKTREE) }
        composeRule.runOnIdle {
            navController.navigateAfterCreation(
                destinationRoute = V2Routes.session("host:created"),
                formRoute = V2Routes.NEW_WORKTREE,
            )
        }
        composeRule.runOnIdle {
            assertEquals(V2Routes.SESSION, navController.currentDestination?.route)
            assertTrue(navController.popBackStack())
            assertEquals(V2Routes.INBOX, navController.currentDestination?.route)
        }
    }

    @Test
    fun terminalSuccessRemovesSubmittedFormFromBackStack() {
        val navController = installCreationGraph()

        composeRule.runOnIdle { navController.navigate(V2Routes.NEW_TERMINAL) }
        composeRule.runOnIdle {
            navController.navigateAfterCreation(
                destinationRoute = V2Routes.terminal("host:terminal"),
                formRoute = V2Routes.NEW_TERMINAL,
            )
        }
        composeRule.runOnIdle {
            assertEquals(V2Routes.TERMINAL, navController.currentDestination?.route)
            assertTrue(navController.popBackStack())
            assertEquals(V2Routes.INBOX, navController.currentDestination?.route)
        }
    }

    @Test
    fun queuedCreationKeepsFormAndOnlyHostConfirmedCompletionDismissesIt() {
        val navController = installCreationGraph()

        composeRule.runOnIdle { navController.navigate(V2Routes.NEW_TERMINAL) }
        composeRule.runOnIdle {
            val queued = V2UiEffect.CreationQueued(
                CreationTarget.TERMINAL,
                "Terminal request saved; waiting for the computer",
            )
            assertEquals(null, queued.creationFormRouteToDismiss())
            assertEquals(V2Routes.NEW_TERMINAL, navController.currentDestination?.route)
        }
        composeRule.runOnIdle {
            val completed = V2UiEffect.CreationCompleted(
                CreationTarget.TERMINAL,
                "Terminal created",
                sessionStableId = "created-terminal-stable-id",
            )
            val formRoute = completed.creationFormRouteToDismiss()
            navController.navigateAfterCreation(
                destinationRoute = requireNotNull(completed.createdSessionDestinationRoute()),
                formRoute = requireNotNull(formRoute),
            )
            assertEquals(V2Routes.TERMINAL, navController.currentDestination?.route)
        }
    }

    @Test
    fun sessionRoutesResolveOnlyTheCurrentMaterializedSession() {
        val uiState = MutableStateFlow(V2UiState())
        val currentStableId = relayV2SessionUiStableId(
            "relay-v2-${"p".repeat(43)}",
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "dashboard-${"h".repeat(32)}",
            "33333333-3333-4333-8333-333333333333",
            "scope_${"s".repeat(32)}",
            "ses_${"t".repeat(32)}",
        )
        val current = RelaySession(
            hostId = "dashboard-${"h".repeat(32)}",
            name = "v2-terminal",
            stableIdOverride = currentStableId,
        )
        val replacement = current.copy(
            stableIdOverride = relayV2SessionUiStableId(
                "relay-v2-${"p".repeat(43)}",
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
                "dashboard-${"h".repeat(32)}",
                "33333333-3333-4333-8333-333333333333",
                "scope_${"s".repeat(32)}",
                "ses_${"r".repeat(32)}",
            ),
        )
        val navController = installRelaySessionGraph(uiState)

        composeRule.runOnIdle { navController.navigate(V2Routes.session(currentStableId)) }
        assertOnlyRoute("route_missing")
        composeRule.runOnIdle { uiState.value = V2UiState(sessions = listOf(current)) }
        assertOnlyRoute("route_session")
        composeRule.runOnIdle { uiState.value = V2UiState() }
        assertOnlyRoute("route_missing")
        composeRule.runOnIdle { uiState.value = V2UiState(sessions = listOf(replacement)) }
        assertOnlyRoute("route_missing")

        composeRule.runOnIdle {
            uiState.value = V2UiState()
            assertTrue(navController.popBackStack())
            navController.navigate(V2Routes.terminal(currentStableId))
        }
        assertOnlyRoute("route_missing")
        composeRule.runOnIdle { uiState.value = V2UiState(sessions = listOf(current)) }
        assertOnlyRoute("route_terminal")
        composeRule.runOnIdle { uiState.value = V2UiState() }
        assertOnlyRoute("route_missing")
        composeRule.runOnIdle { uiState.value = V2UiState(sessions = listOf(replacement)) }
        assertOnlyRoute("route_missing")
    }

    private fun assertOnlyRoute(expectedTag: String) {
        composeRule.onNodeWithTag(expectedTag).assertIsDisplayed()
        setOf("route_missing", "route_session", "route_terminal")
            .minus(expectedTag)
            .forEach { composeRule.onNodeWithTag(it).assertDoesNotExist() }
    }

    private fun installRelaySessionGraph(
        uiState: StateFlow<V2UiState>,
    ): NavHostController {
        lateinit var navController: TestNavHostController
        composeRule.setContent {
            val context = LocalContext.current
            navController = remember(context) {
                TestNavHostController(context).also {
                    it.navigatorProvider.addNavigator(ComposeNavigator())
                }
            }
            NavHost(navController = navController, startDestination = V2Routes.INBOX) {
                composable(V2Routes.INBOX) { Box(Modifier.testTag("route_inbox")) }
                relaySessionDestinations(
                    uiState = uiState,
                    missingContent = { Text("Missing", Modifier.testTag("route_missing")) },
                    sessionContent = { _, _ ->
                        Text("Session", Modifier.testTag("route_session"))
                    },
                    terminalContent = { _, _ ->
                        Text("Terminal", Modifier.testTag("route_terminal"))
                    },
                    chatContent = { _, _ ->
                        Text("Chat", Modifier.testTag("route_chat"))
                    },
                )
            }
        }
        composeRule.waitForIdle()
        return navController
    }

    private fun installCreationGraph(): NavHostController {
        lateinit var navController: TestNavHostController
        composeRule.setContent {
            val context = LocalContext.current
            navController = remember(context) {
                TestNavHostController(context).also {
                    it.navigatorProvider.addNavigator(ComposeNavigator())
                }
            }
            NavHost(navController = navController, startDestination = V2Routes.INBOX) {
                composable(V2Routes.INBOX) { Box(Modifier) }
                composable(V2Routes.NEW_WORKTREE) { Box(Modifier) }
                composable(V2Routes.NEW_TERMINAL) { Box(Modifier) }
                composable(
                    route = V2Routes.SESSION,
                    arguments = listOf(navArgument("sessionKey") { type = NavType.StringType }),
                ) { Box(Modifier) }
                composable(
                    route = V2Routes.TERMINAL,
                    arguments = listOf(navArgument("sessionKey") { type = NavType.StringType }),
                ) { Box(Modifier) }
            }
        }
        composeRule.waitForIdle()
        return navController
    }
}
