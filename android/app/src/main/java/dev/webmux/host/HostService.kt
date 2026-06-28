package dev.webmux.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import org.unifiedpush.android.connector.UnifiedPush
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Long-lived foreground service that hosts webmux on this phone. It brings up the
 * proot/Debian userland (downloading it on first run) and — in later milestones —
 * launches webmux + Claude inside it, bound to the phone's Tailscale IP.
 */
/** A snapshot of the host's power state for the app panel + notification. */
class PowerInfo(
    val awake: Boolean,     // is the CPU wake-lock currently held?
    val reason: String,     // human-readable why (e.g. "Asleep — saving battery")
    val dutyPct: Int,       // % of the window the wake-lock was held
    val windowMin: Int,     // minutes the window spans
    val battery: Int,       // battery % (-1 unknown)
    val charging: Boolean,
    val saver: Boolean,     // battery-saver policy on?
    val floor: Int,         // sleep-below-% floor (0 = off)
)

class HostService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private val working = AtomicBoolean(false)
    private lateinit var userland: Userland
    private var control: ControlServer? = null

    // The currently-running webmux process, so a Repair/reinstall request can bounce
    // it even while the supervisor loop is mid-flight.
    @Volatile private var webmuxProc: Process? = null
    @Volatile private var pendingReinstall = false
    @Volatile private var pendingRebootstrap = false

    // Box freshness: the app updates itself from GitHub, but the webmux *inside* the box
    // is a separate git checkout that can silently lag (new app + old box). We pull it
    // forward on startup and periodically while charging so it never gets stuck.
    @Volatile private var fleetUrl: String? = null
    @Volatile private var lastBoxSyncAt = 0L
    private val boxSyncing = AtomicBoolean(false)

    // --- power policy -------------------------------------------------------
    // The wake-lock is what stops the phone from sleeping. Holding it 24/7 is the
    // dominant battery cost, so we hold it only when the phone is actually in use
    // (charging, screen on, or a webmux session connected) plus a short grace after
    // the last disconnect — otherwise we release it and let the device suspend.
    @Volatile private var screenOn = true
    @Volatile private var charging = false
    @Volatile private var clientConnected = false
    @Volatile private var batterySaver = true
    @Volatile private var batteryFloor = 0      // 0 = off; otherwise sleep on battery at/below this %
    @Volatile private var forceSleep = false    // user tapped "Sleep now"; cleared on charge/screen-on
    @Volatile private var powerReason = "starting…"
    private var graceUntil = 0L
    private var wakeUntil = 0L

    // Wake-lock duty cycle over a rolling ~1h window — the honest "is it draining?" number.
    // A PARTIAL_WAKE_LOCK only costs battery while held, so "% of the last hour awake" is
    // what actually matters. Accounted lazily at every recompute and on read.
    private var dutyHeld = false
    private var dutyLastMs = 0L
    private var dutyAwakeMs = 0L
    private var dutyWindowStartMs = 0L
    private val powerHandler = Handler(Looper.getMainLooper())
    private val powerTick = Runnable { recomputeWakeLock() }
    private var powerReceiver: BroadcastReceiver? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        userland = Userland(this)
        initPower()
        // Refresh our UnifiedPush registration (and thus the wake endpoint) on every
        // start, if the user has already linked a distributor (the ntfy app).
        if (UnifiedPush.getSavedDistributor(this) != null) {
            runCatching { UnifiedPush.register(this, instance = WAKE_INSTANCE) }
        }
        // Loopback phone-control API for the on-device Claude (127.0.0.1:8084).
        runCatching {
            control = ControlServer(applicationContext).apply {
                start(fi.iki.elonen.NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            }
            Log.i(TAG, "control server on 127.0.0.1:8084")
        }.onFailure { Log.e(TAG, "control server failed", it) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground("Starting…")
        if (intent?.hasExtra(EXTRA_SET_SAVER) == true) {
            setBatterySaver(intent.getBooleanExtra(EXTRA_SET_SAVER, true))
        }
        if (intent?.getBooleanExtra(EXTRA_WAKE, false) == true) {
            status("Woken on demand — coming online…"); beginWakeWindow(WAKE_WINDOW_MS)
        }
        val url = intent?.getStringExtra(EXTRA_ROOTFS_URL) ?: Userland.DEFAULT_ROOTFS_URL
        if (intent?.getBooleanExtra(EXTRA_REINSTALL, false) == true) pendingReinstall = true
        if (intent?.getBooleanExtra(EXTRA_REBOOTSTRAP, false) == true) pendingRebootstrap = true
        if (working.compareAndSet(false, true)) {
            Thread { supervise(url) }.start()
        } else if (pendingReinstall || pendingRebootstrap) {
            // Supervisor already running: bounce webmux so the loop re-pulls on fresh
            // code (the flags are read at the top of the next iteration). Stop node from
            // inside the box (off the main thread) — destroying the proot wrapper doesn't
            // reliably kill the child, which left the supervisor parked on the old build.
            status("Applying update — restarting webmux…")
            Thread { userland.stopWebmux() }.start()
        }
        return START_STICKY
    }

    /**
     * Single supervisor loop: (re)install + (re)bootstrap as requested, run webmux,
     * and restart it whenever it exits. Repair/reinstall set the pending flags and
     * kill the process; the next iteration honours them, so updates are deterministic
     * even while webmux is live (no systemd here to `restart`).
     */
    private fun supervise(url: String) {
        try {
            userland.prepareRuntime()
            while (true) {
                if (pendingReinstall) {
                    pendingReinstall = false
                    status("Wiping userland for clean reinstall…")
                    userland.wipe(); userland.prepareRuntime()
                }
                if (!userland.isInstalled()) {
                    userland.install(url) { msg -> status(msg) }
                }
                if (pendingRebootstrap || !userland.isBootstrapped()) {
                    pendingRebootstrap = false
                    userland.clearBootstrap()
                    status("Installing toolchain + webmux + Claude (several min)…")
                    val rc = userland.bootstrap { line ->
                        Log.i(TAG, line)
                        if (line.startsWith("BOOT:")) status(line.removePrefix("BOOT:").trim())
                    }
                    if (rc != 0 || !userland.isBootstrapped()) {
                        status("Bootstrap failed (rc=$rc) — retry in 30s"); Thread.sleep(30_000); continue
                    }
                }
                val ip = waitForTailnetIp()
                if (ip == null) { status("Waiting for Tailscale… open the Tailscale app"); Thread.sleep(8000); continue }
                status("Starting webmux on $ip:8083…")
                val proc = userland.startWebmux(ip)
                webmuxProc = proc
                fleetUrl = "http://$ip:8083"
                status(fleetText())
                // Heal a stale box: pull webmux forward (the app self-updates, the box
                // doesn't). Runs in the background so bring-up isn't blocked on the fetch.
                scheduleBoxSync()
                // Drain stdout until it ends. A Repair/reinstall calls webmuxProc.destroy(),
                // which closes this stream mid-read and throws "read interrupted by close()";
                // swallow it so the bounce falls through to restart instead of killing the
                // whole supervisor (which left phones stuck on the old version).
                try { proc.inputStream.bufferedReader().forEachLine { Log.i(TAG, it) } }
                catch (_: Throwable) { /* stream closed by a bounce — fall through */ }
                val rc = proc.waitFor()
                webmuxProc = null
                val why = if (pendingRebootstrap || pendingReinstall) "applying update" else "rc=$rc"
                status("webmux stopped ($why) — restarting…")
                Thread.sleep(2000)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "supervise failed", t)
            status("Error: ${t.message}")
            working.set(false) // let a later intent restart the supervisor
        }
    }

    private fun waitForTailnetIp(maxWaitMs: Long = 30_000): String? {
        val deadline = System.currentTimeMillis() + maxWaitMs
        while (System.currentTimeMillis() < deadline) {
            Userland.findTailnetIp()?.let { return it }
            Thread.sleep(1500)
        }
        return Userland.findTailnetIp()
    }

    private fun fleetText(): String {
        val v = lastBoxVersion?.let { " (webmux $it)" } ?: ""
        val u = fleetUrl?.let { " — $it" } ?: ""
        return "✓ On the fleet$v$u"
    }

    /**
     * Detect + heal a stale box. Throttled to one network check per BOX_SYNC_INTERVAL_MS
     * (always allowed on the first check since the service started, so a boot/wake heals
     * promptly); periodic re-checks wait until the phone is charging so they cost nothing
     * on battery. If the pull moves HEAD, bounce webmux so the supervisor restarts node on
     * the new code. Runs off-thread; never blocks the supervisor.
     */
    private fun scheduleBoxSync() {
        val now = SystemClock.elapsedRealtime()
        val first = lastBoxSyncAt == 0L
        if (!first && now - lastBoxSyncAt < BOX_SYNC_INTERVAL_MS) return
        if (!first && batterySaver && !charging) return
        if (!boxSyncing.compareAndSet(false, true)) return
        lastBoxSyncAt = now
        Thread {
            try {
                val r = userland.syncWebmuxCode { l ->
                    if (l.startsWith("BOOT:")) status(l.removePrefix("BOOT:").trim())
                }
                lastBoxVersion = r.version
                if (r.changed && webmuxProc != null) {
                    status("Updated webmux to ${r.version} — restarting…")
                    userland.stopWebmux() // node exits cleanly; supervisor restarts it on the new code
                } else {
                    status(fleetText())
                }
            } catch (t: Throwable) {
                Log.w(TAG, "box sync failed", t); status(fleetText())
            } finally {
                boxSyncing.set(false)
            }
        }.start()
    }

    // Periodic freshness check for a box that's been running old code for a long time
    // (its supervisor is parked in waitFor() and never re-pulls on its own). Only acts
    // while charging and with no client attached, so it never disrupts active use.
    private val boxSyncTick = object : Runnable {
        override fun run() {
            if (webmuxProc != null && charging && !clientConnected) scheduleBoxSync()
            powerHandler.postDelayed(this, BOX_SYNC_INTERVAL_MS)
        }
    }

    @Volatile private var lastStatus = "Idle"

    private fun status(text: String) {
        Log.i(TAG, "status: $text")
        lastStatus = text
        updateNotice(text)
    }

    /** Re-emit the notification with the same status but a fresh power line. */
    private fun refreshNotice() = updateNotice(lastStatus)

    /** One-line power summary shown in the notification's expanded view. */
    private fun powerLine(): String {
        val i = powerInfo()
        val bat = if (i.battery >= 0) " · ${i.battery}%${if (i.charging) "⚡" else ""}" else ""
        val head = if (i.awake) "● Awake" else "💤 Asleep"
        return "$head · CPU on ${i.dutyPct}% of last ${i.windowMin}m$bat"
    }

    private fun goForeground(text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "WebMux Host", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val n = notice(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTE_ID, n)
        }
    }

    private fun notice(text: String): Notification {
        val power = runCatching { powerLine() }.getOrDefault("")
        val body = if (power.isNotEmpty()) "$text\n$power" else text
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("WebMux Host")
            .setContentText(if (power.isNotEmpty()) power else text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setOngoing(true)
            .build()
    }

    private fun updateNotice(text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).notify(NOTE_ID, notice(text))
        }
    }

    private fun initPower() {
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "webmux:host")?.apply {
            setReferenceCounted(false)
        }
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).let {
            batterySaver = it.getBoolean(KEY_SAVER, true)
            batteryFloor = it.getInt(KEY_FLOOR, 0)
        }
        screenOn = pm?.isInteractive ?: true
        charging = getSystemService(BatteryManager::class.java)?.isCharging ?: false
        powerReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                when (i?.action) {
                    Intent.ACTION_SCREEN_ON -> screenOn = true
                    Intent.ACTION_SCREEN_OFF -> screenOn = false
                    Intent.ACTION_POWER_CONNECTED -> charging = true
                    Intent.ACTION_POWER_DISCONNECTED -> charging = false
                }
                recomputeWakeLock()
            }
        }
        registerReceiver(powerReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        })
        recomputeWakeLock()
        powerHandler.postDelayed(boxSyncTick, BOX_SYNC_INTERVAL_MS)
    }

    /** Hold the wake-lock only while the phone is in use; otherwise let it sleep. */
    @Synchronized
    private fun recomputeWakeLock() {
        val wl = wakeLock ?: return
        val now = SystemClock.elapsedRealtime()
        settleDuty(now)
        if (charging || screenOn) forceSleep = false // user's back / plugged in → cancel manual sleep
        val tempUntil = maxOf(graceUntil, wakeUntil) // grace after a session, or a wake-on-demand window
        val temp = now < tempUntil
        val low = !charging && batteryFloor in 1..100 && batteryLevel().let { it in 1..batteryFloor }
        val inUse = charging || screenOn || clientConnected
        // Persistent hold = the policy keeps us awake. A manual "Sleep now" or a battery
        // floor (when not charging and the screen's off) overrides it; the short temp
        // window (reconnect/wake-on-demand) is always honoured so pushes still land.
        val persistent = (!batterySaver || inUse) && !forceSleep && !(low && !screenOn)
        val shouldHold = persistent || temp
        if (shouldHold && !wl.isHeld) wl.acquire()
        else if (!shouldHold && wl.isHeld) wl.release()
        dutyHeld = shouldHold
        powerReason = describePower(shouldHold, temp, low)
        // If only a temporary window is keeping us awake, schedule a recheck at its end.
        powerHandler.removeCallbacks(powerTick)
        if (shouldHold && temp && !persistent) {
            powerHandler.postDelayed(powerTick, tempUntil - now + 50)
        }
        refreshNotice() // keep the shade's awake/asleep + battery line current on transitions
    }

    /** Attribute time-since-last to the awake total, keeping a rolling ~1h window. */
    private fun settleDuty(now: Long) {
        if (dutyLastMs == 0L) { dutyLastMs = now; dutyWindowStartMs = now; return }
        if (dutyHeld) dutyAwakeMs += now - dutyLastMs
        dutyLastMs = now
        val elapsed = now - dutyWindowStartMs
        if (elapsed > WINDOW_MS) { // decay so the % tracks the last ~hour, not all of history
            dutyAwakeMs = (dutyAwakeMs * WINDOW_MS / elapsed)
            dutyWindowStartMs = now - WINDOW_MS
        }
    }

    private fun batteryLevel(): Int = runCatching {
        getSystemService(BatteryManager::class.java)?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
    }.getOrDefault(-1)

    private fun describePower(awake: Boolean, temp: Boolean, low: Boolean): String = when {
        !awake && forceSleep -> "Asleep — you tapped Sleep now"
        !awake && low -> "Asleep — battery below ${batteryFloor}%"
        !awake -> "Asleep — saving battery"
        charging -> "Awake — charging"
        clientConnected -> "Awake — a session is open"
        screenOn -> "Awake — screen on"
        !batterySaver -> "Awake — battery saver is off"
        temp -> "Awake — brief reconnect window"
        else -> "Awake"
    }

    /** Snapshot for the app's battery panel and the notification. */
    @Synchronized
    fun powerInfo(): PowerInfo {
        val now = SystemClock.elapsedRealtime()
        settleDuty(now)
        val win = (now - dutyWindowStartMs).coerceAtLeast(1)
        val pct = (dutyAwakeMs * 100 / win).toInt().coerceIn(0, 100)
        return PowerInfo(dutyHeld, powerReason, pct, (win / 60_000).toInt().coerceAtLeast(1),
            batteryLevel(), charging, batterySaver, batteryFloor)
    }

    fun setBatteryFloor(pct: Int) {
        batteryFloor = pct.coerceIn(0, 100)
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(KEY_FLOOR, batteryFloor).apply()
        recomputeWakeLock(); refreshNotice()
    }

    /** Release the wake-lock now and stay asleep until the user returns or plugs in. */
    fun forceSleepNow() { forceSleep = true; recomputeWakeLock(); refreshNotice() }

    /** Open a window of wakefulness so webmux resumes + Tailscale reconnects after a wake push. */
    fun beginWakeWindow(ms: Long) {
        wakeUntil = SystemClock.elapsedRealtime() + ms
        recomputeWakeLock()
    }

    /** Called from ControlServer when webmux's connected-client count crosses 0↔1. */
    fun setClientConnected(connected: Boolean) {
        clientConnected = connected
        if (!connected) graceUntil = SystemClock.elapsedRealtime() + GRACE_MS
        recomputeWakeLock()
    }

    fun setBatterySaver(on: Boolean) {
        batterySaver = on
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_SAVER, on).apply()
        recomputeWakeLock(); refreshNotice()
    }

    override fun onDestroy() {
        instance = null
        powerHandler.removeCallbacks(powerTick)
        powerHandler.removeCallbacks(boxSyncTick)
        powerReceiver?.let { runCatching { unregisterReceiver(it) } }
        runCatching { control?.stop() }
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ROOTFS_URL = "rootfs_url"
        const val EXTRA_REINSTALL = "reinstall"
        const val EXTRA_REBOOTSTRAP = "rebootstrap"
        const val EXTRA_SET_SAVER = "set_saver"
        const val EXTRA_WAKE = "wake"
        const val PREFS = "webmux"
        const val KEY_SAVER = "battery_saver"
        const val KEY_FLOOR = "battery_floor"
        const val WAKE_INSTANCE = "webmux"
        private const val GRACE_MS = 60_000L
        private const val WAKE_WINDOW_MS = 120_000L
        private const val WINDOW_MS = 3_600_000L // duty-cycle averaging window (~1h)
        private const val BOX_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000L // 6h between freshness checks
        private const val TAG = "webmuxhost"

        // The box's webmux version (git short HEAD), surfaced to MainActivity so a
        // new-app/old-box mismatch is visible. Filled by the first freshness check.
        @Volatile
        var lastBoxVersion: String? = null
        private const val CHANNEL = "webmux-host"
        private const val NOTE_ID = 1

        // So ControlServer (loopback /power) can feed the connected-client signal in.
        @Volatile
        var instance: HostService? = null
    }
}
