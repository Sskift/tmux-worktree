package com.tmuxworktree.mobile.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.ComposeNavigator
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.testing.TestNavHostController
import com.tmuxworktree.mobile.app.navigation.V2MainNavHost
import com.tmuxworktree.mobile.app.navigation.V2Routes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class NavigationTransitionInstrumentedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun everyRoutePushAndPopReplacesItsParentWithoutAnAnimationOverlap() {
        composeRule.mainClock.autoAdvance = false
        val navController = installCompleteRouteGraph()
        composeRule.mainClock.advanceTimeBy(1_000)
        assertOnlyRoute("route_inbox")

        destinations.forEach { destination ->
            composeRule.runOnIdle { navController.navigate(destination.route) }
            advancePastNavigationDispatch()
            assertOnlyRoute(destination.tag)
            composeRule.runOnIdle {
                assertTrue(navController.popBackStack())
                assertEquals(V2Routes.INBOX, navController.currentDestination?.route)
            }
            advancePastNavigationDispatch()
            assertOnlyRoute("route_inbox")
        }
    }

    private fun advancePastNavigationDispatch() {
        // Navigation's back-stack StateFlow and AnimatedContent each need a frame to
        // observe the new entry. This remains well below the removed 220 ms transition.
        repeat(4) { composeRule.mainClock.advanceTimeByFrame() }
    }

    private fun assertOnlyRoute(expectedTag: String) {
        composeRule.onNodeWithTag(expectedTag).assertExists()
        allRouteTags.minus(expectedTag).forEach { tag ->
            composeRule.onNodeWithTag(tag).assertDoesNotExist()
        }
    }

    private fun installCompleteRouteGraph(): NavHostController {
        lateinit var navController: TestNavHostController
        composeRule.setContent {
            val context = LocalContext.current
            navController = remember(context) {
                TestNavHostController(context).also {
                    it.navigatorProvider.addNavigator(ComposeNavigator())
                }
            }
            V2MainNavHost(navController = navController) {
                composable(V2Routes.INBOX) { RouteMarker("route_inbox") }
                composable(V2Routes.WORKSPACES) { RouteMarker("route_workspaces") }
                composable(V2Routes.SETTINGS) { RouteMarker("route_settings") }
                composable(V2Routes.HEALTH) { RouteMarker("route_health") }
                composable(V2Routes.LARK_BINDINGS) { RouteMarker("route_lark_bindings") }
                composable(V2Routes.NEW_WORKTREE) { RouteMarker("route_new_worktree") }
                composable(V2Routes.NEW_TERMINAL) { RouteMarker("route_new_terminal") }
                sessionRoute(V2Routes.SESSION, "route_session")
                sessionRoute(V2Routes.TERMINAL, "route_terminal")
                sessionRoute(V2Routes.CHAT, "route_chat")
            }
        }
        return navController
    }

    private fun androidx.navigation.NavGraphBuilder.sessionRoute(route: String, tag: String) {
        composable(
            route = route,
            arguments = listOf(navArgument("sessionKey") { type = NavType.StringType }),
        ) { RouteMarker(tag) }
    }

    private data class Destination(val route: String, val tag: String)

    private companion object {
        val destinations = listOf(
            Destination(V2Routes.WORKSPACES, "route_workspaces"),
            Destination(V2Routes.SETTINGS, "route_settings"),
            Destination(V2Routes.HEALTH, "route_health"),
            Destination(V2Routes.LARK_BINDINGS, "route_lark_bindings"),
            Destination(V2Routes.NEW_WORKTREE, "route_new_worktree"),
            Destination(V2Routes.NEW_TERMINAL, "route_new_terminal"),
            Destination(V2Routes.session("host:session"), "route_session"),
            Destination(V2Routes.terminal("host:terminal"), "route_terminal"),
            Destination(V2Routes.chat("host:chat"), "route_chat"),
        )
        val allRouteTags = destinations.mapTo(mutableSetOf("route_inbox")) { it.tag }
    }
}

@androidx.compose.runtime.Composable
private fun RouteMarker(tag: String) {
    Box(Modifier.fillMaxSize().testTag(tag))
}
