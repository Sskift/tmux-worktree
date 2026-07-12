package com.tmuxworktree.mobile.app

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.ComposeNavigator
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.testing.TestNavHostController
import com.tmuxworktree.mobile.app.navigation.V2Routes
import com.tmuxworktree.mobile.app.navigation.navigateAfterCreation
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
