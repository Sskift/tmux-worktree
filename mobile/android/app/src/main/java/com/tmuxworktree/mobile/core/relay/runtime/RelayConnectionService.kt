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
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.TransportPhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Foreground service that keeps the relay connection alive while the app is in the background.
 *
 * The service owns the [RelayV1ConnectionActor]'s lifecycle via [RelayConnectionRegistry]. It runs
 * in the foreground with a persistent notification whenever the transport is not fully stopped, and
 * stops itself once the connection is disconnected.
 */
class RelayConnectionService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob())
    private var healthCollectionJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        // Promote to foreground immediately; the notification text is updated from health.
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.relay_notification_connecting)))
        val actor = RelayConnectionRegistry.actor
        healthCollectionJob = serviceScope.launch {
            actor.health.collectLatest { health ->
                val connected = health.phase != TransportPhase.STOPPED
                if (connected) {
                    val text = when (health.overall) {
                        ConnectionStatus.ONLINE -> getString(R.string.relay_notification_connected)
                        ConnectionStatus.CONNECTING,
                        ConnectionStatus.RECOVERING,
                        -> getString(R.string.relay_notification_reconnecting)
                        ConnectionStatus.PAUSED -> getString(R.string.relay_notification_waiting_network)
                        else -> getString(R.string.relay_notification_connecting)
                    }
                    updateNotification(text)
                } else {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // If the actor is already stopped, stop the service immediately.
        val actor = RelayConnectionRegistry.actor
        if (actor.health.value.phase == TransportPhase.STOPPED) {
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
