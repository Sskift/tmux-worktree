package com.tmuxworktree.mobile.app

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tmuxworktree.mobile.app.navigation.V2Navigation
import com.tmuxworktree.mobile.core.model.TransportPhase
import com.tmuxworktree.mobile.designsystem.TwTheme

internal fun shouldShowTargetLoading(state: V2UiState): Boolean =
    state.hosts.isEmpty() &&
        state.health.errorMessage.isBlank() &&
        state.health.phase in setOf(TransportPhase.CONNECTING, TransportPhase.HANDSHAKING)

@Composable
fun V2App(
    viewModel: V2ViewModel,
    onScanQr: () -> Unit,
    overlay: @Composable () -> Unit = {},
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    TwTheme(darkTheme = state.preferences.darkThemeEnabled) {
        Box {
            V2Navigation(
                viewModel = viewModel,
                onScanQr = onScanQr,
            )
            overlay()
        }
    }
}
