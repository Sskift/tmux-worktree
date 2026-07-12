package com.tmuxworktree.mobile.app

import androidx.compose.runtime.Composable
import com.tmuxworktree.mobile.app.navigation.V2Navigation
import com.tmuxworktree.mobile.core.model.TransportPhase

internal fun shouldShowTargetLoading(state: V2UiState): Boolean =
    state.hosts.isEmpty() &&
        state.health.errorMessage.isBlank() &&
        state.health.phase in setOf(TransportPhase.CONNECTING, TransportPhase.HANDSHAKING)

@Composable
fun V2App(
    viewModel: V2ViewModel,
    onScanQr: () -> Unit,
) {
    V2Navigation(
        viewModel = viewModel,
        onScanQr = onScanQr,
    )
}
