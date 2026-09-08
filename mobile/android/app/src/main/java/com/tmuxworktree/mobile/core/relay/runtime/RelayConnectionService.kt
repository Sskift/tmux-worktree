package com.tmuxworktree.mobile.core.relay.runtime

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.tmuxworktree.mobile.R
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeComposition
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimePhase
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
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
    private var relayWakeLock: PowerManager.WakeLock? = null

    /** The most recent start generation; stopSelf(lastStartId) never outranks a newer start. */
    @Volatile
    private var lastStartId: Int = 0

    /**
     * Flips to true once the process-restart composition bootstrap has settled. The health
     * collector holds the foreground notification until then so a START_STICKY recreation does
     * not stop the service in the brief window before the persisted auto-connect profile has
     * been rebuilt (or proven absent).
     */
    private val bootstrapSettled = MutableStateFlow(false)

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        // Promote to foreground immediately; the notification text is updated from health.
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.relay_notification_connecting)))
        acquireRelayWakeLock()
        serviceScope.launch { ensureProcessCompositionBootstrap() }
        healthCollectionJob = serviceScope.launch {
            // A present-but-not-yet-STOPPED composition is treated as active so the foreground
            // keep-alive survives the startup/recovery window between install and CONNECTING.
            val v2 = RelayV2ConnectionRegistry.composition.flatMapLatest { composition ->
                if (composition == null) {
                    flow {
                        // No composition in this process yet: hold the foreground while the
                        // process-restart bootstrap rebuilds a persisted auto-connect profile.
                        // Only once it settles with nothing to guard do we emit null -> stopSelf.
                        emit(RelayV2BaseRuntimePhase.CONNECTING)
                        bootstrapSettled.first { settled -> settled }
                        emit(null)
                    }
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
                    // Fence aligned with onStartCommand: a successor composition may have been
                    // installed between the terminal state emission and this collection, and a
                    // newer start generation must not be stopped by a stale decision.
                    if (RelayConnectionServiceDecisions.keepForeground(
                            RelayV2ConnectionRegistry.composition.value,
                            bootstrapSettled.value,
                        )
                    ) {
                        return@collectLatest
                    }
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf(lastStartId)
                } else {
                    updateNotification(getString(textRes))
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        // If every connection is already stopped, stop the service immediately. A present-but-not
        // terminal/closed v2 composition counts as active during its startup/recovery window, and
        // a still-running process-restart bootstrap holds the foreground until it settles.
        if (!RelayConnectionServiceDecisions.keepForeground(
                RelayV2ConnectionRegistry.composition.value,
                bootstrapSettled.value,
            )
        ) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf(startId)
        }
        return START_STICKY
    }

    /**
     * Rebuilds the Relay v2 composition after a process kill + START_STICKY restart. The
     * composition factory lives in the app/DI layer (it owns Room/DataStore construction); the
     * service reaches it through [RelayV2ServiceProcessBootstrap], resolved reflectively so the
     * core runtime package never depends on the app package. The bootstrap is network-free
     * (startup admission reads only persisted state) and installs onto the process-level
     * [RelayV2ConnectionRegistry.scope], so a later ViewModel startup reuses this exact
     * composition via `isReusableFor` instead of creating a second owner.
     */
    private suspend fun ensureProcessCompositionBootstrap() {
        val bootstrap = RelayV2ServiceProcessBootstrapHook.resolve()
        try {
            val current = RelayV2ConnectionRegistry.composition.value
            if (current == null || current.isTerminalOrClosed()) {
                bootstrap?.bootstrap(applicationContext)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // Fail closed: a bootstrap that throws leaves no composition; the collector stops the
            // service once settled rather than holding a foreground notification forever.
        } finally {
            bootstrapSettled.value = true
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        healthCollectionJob?.cancel()
        serviceScope.cancel()
        relayWakeLock?.let { lock ->
            if (lock.isHeld) runCatching { lock.release() }
        }
        relayWakeLock = null
        super.onDestroy()
    }

    /**
     * The foreground notification makes the connection user-visible, but it does not guarantee
     * CPU time after the display is locked on every Android build. Keep only a partial wake lock
     * for the exact lifetime of the active Relay service so Broker heartbeats can be answered and
     * a screen lock does not turn into an avoidable transport disconnect.
     */
    @SuppressLint("WakelockTimeout")
    private fun acquireRelayWakeLock() {
        val manager = getSystemService(PowerManager::class.java) ?: return
        val lock = manager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "$packageName:relay-connection",
        ).apply { setReferenceCounted(false) }
        if (runCatching { lock.acquire() }.isSuccess) relayWakeLock = lock
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

/**
 * Foreground keep-alive decision shared by the health collector and onStartCommand so both
 * observe the same fence: a live (non-terminal) composition always keeps the service up; with
 * no composition the service is kept only while a process-restart bootstrap is still in flight.
 */
internal object RelayConnectionServiceDecisions {
    fun keepForeground(
        composition: RelayV2BaseRuntimeComposition?,
        bootstrapSettled: Boolean,
    ): Boolean {
        if (composition != null && !composition.isTerminalOrClosed()) return true
        return composition == null && !bootstrapSettled
    }
}

/**
 * Process-restart composition bootstrap seam. The production implementation lives in the app/DI
 * layer (it reads the persisted auto-connect profile and builds the composition on the registry
 * scope); it must never touch UI state or UI fences. Returns true when a live composition is
 * installed after the call.
 */
internal interface RelayV2ServiceProcessBootstrap {
    suspend fun bootstrap(context: Context): Boolean
}

/**
 * Resolves the production [RelayV2ServiceProcessBootstrap] without a compile-time dependency from
 * the core runtime package onto the app package. Tests can install an override directly. The
 * reflective lookup is fail-soft: if the app-layer entry is absent the service behaves exactly
 * as before (no composition, stop when settled).
 */
internal object RelayV2ServiceProcessBootstrapHook {
    @Volatile
    private var override: RelayV2ServiceProcessBootstrap? = null

    private val reflective: RelayV2ServiceProcessBootstrap? by lazy {
        runCatching {
            val cls = Class.forName("com.tmuxworktree.mobile.app.RelayV2ServiceRuntimeBootstrap")
            cls.getField("INSTANCE").get(null) as? RelayV2ServiceProcessBootstrap
        }.getOrNull()
    }

    fun installForTest(bootstrap: RelayV2ServiceProcessBootstrap?) {
        override = bootstrap
    }

    fun resolve(): RelayV2ServiceProcessBootstrap? = override ?: reflective
}
