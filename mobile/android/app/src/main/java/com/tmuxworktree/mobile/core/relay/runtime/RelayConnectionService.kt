package com.tmuxworktree.mobile.core.relay.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.tmuxworktree.mobile.R
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimePhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Foreground service that keeps the relay connection alive while the app is in the background.
 *
 * The service keeps the process foreground while the Relay v2 base runtime composition owned by
 * [RelayV2ConnectionRegistry] is not fully stopped. It stops itself once v2 is disconnected.
 */
class RelayConnectionService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob())
    private var healthCollectionJob: Job? = null

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        // Promote to foreground immediately; the notification text is updated from health.
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.relay_notification_connecting)))
        healthCollectionJob = serviceScope.launch {
            // A present-but-not-yet-STOPPED composition is treated as active so the foreground
            // keep-alive survives the startup/recovery window between install and CONNECTING.
            val v2 = RelayV2ConnectionRegistry.composition.flatMapLatest { composition ->
                if (composition == null) {
                    flowOf<RelayV2BaseRuntimePhase?>(null)
                } else {
                    composition.state.map { state ->
                        if (composition.isTerminalOrClosed()) null else state.phase
                    }
                }
            }
            v2.map { v2Phase ->
                if (v2Phase == null) null else when (v2Phase) {
                        RelayV2BaseRuntimePhase.ONLINE -> R.string.relay_notification_connected
                        RelayV2BaseRuntimePhase.CONNECTING,
                        RelayV2BaseRuntimePhase.RESYNCING,
                        -> R.string.relay_notification_reconnecting
                        RelayV2BaseRuntimePhase.SUSPENDED ->
                            R.string.relay_notification_waiting_network
                        else -> R.string.relay_notification_connecting
                }
            }.collectLatest { textRes ->
                if (textRes == null) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                } else {
                    updateNotification(getString(textRes))
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // If every connection is already stopped, stop the service immediately. A present-but-not
        // terminal/closed v2 composition counts as active during its startup/recovery window.
        val v2 = RelayV2ConnectionRegistry.composition.value
        val v2Active = v2 != null && !v2.isTerminalOrClosed()
        if (!v2Active) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        healthCollectionJob?.cancel()
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.relay_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.relay_notification_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    companion object {
        private const val CHANNEL_ID = "relay_connection"
        private const val NOTIFICATION_ID = 0x52454C41 // "RELA"

        fun start(context: Context) {
            val intent = Intent(context, RelayConnectionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
