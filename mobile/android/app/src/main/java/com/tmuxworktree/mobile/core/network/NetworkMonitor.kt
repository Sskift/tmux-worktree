package com.tmuxworktree.mobile.core.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

data class NetworkState(
    val available: Boolean,
    val networkHandle: Long? = null,
)

class NetworkMonitor(context: Context) {
    private val connectivityManager = context.applicationContext
        .getSystemService(ConnectivityManager::class.java)

    val state: Flow<NetworkState> = callbackFlow {
        fun currentState(): NetworkState {
            val active = connectivityManager.activeNetwork ?: return NetworkState(false)
            val capabilities = connectivityManager.getNetworkCapabilities(active)
                ?: return NetworkState(false)
            // A relay may intentionally live on a Wi-Fi/VPN-only `.local`
            // network, so validation against the public internet is not a
            // prerequisite. The WebSocket actor remains the source of truth
            // for end-to-end relay reachability.
            val available = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
            return NetworkState(
                available = available,
                networkHandle = active.networkHandle.takeIf { available },
            )
        }

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                trySend(currentState())
            }

            override fun onLost(network: Network) {
                trySend(currentState())
            }

            override fun onCapabilitiesChanged(
                network: Network,
                networkCapabilities: NetworkCapabilities,
            ) {
                trySend(currentState())
            }

            override fun onUnavailable() {
                trySend(NetworkState(false))
            }
        }

        trySend(currentState())
        connectivityManager.registerDefaultNetworkCallback(callback)
        awaitClose { connectivityManager.unregisterNetworkCallback(callback) }
    }.distinctUntilChanged()

    val isOnline: Flow<Boolean> = state
        .map { network: NetworkState -> network.available }
        .distinctUntilChanged()
}
