package dev.webmux.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Long-lived foreground service that hosts webmux on this phone. It brings up the
 * proot/Debian userland (downloading it on first run) and — in later milestones —
 * launches webmux + Claude inside it, bound to the phone's Tailscale IP.
 */
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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        userland = Userland(this)
        acquireWakeLock()
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
        val url = intent?.getStringExtra(EXTRA_ROOTFS_URL) ?: Userland.DEFAULT_ROOTFS_URL
        if (intent?.getBooleanExtra(EXTRA_REINSTALL, false) == true) pendingReinstall = true
        if (intent?.getBooleanExtra(EXTRA_REBOOTSTRAP, false) == true) pendingRebootstrap = true
        if (working.compareAndSet(false, true)) {
            Thread { supervise(url) }.start()
        } else if (pendingReinstall || pendingRebootstrap) {
            // Supervisor already running: bounce webmux so the loop re-pulls on fresh
            // code (the flags are read at the top of the next iteration).
            status("Applying update — restarting webmux…")
            webmuxProc?.destroy()
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
                status("✓ On the fleet — http://$ip:8083")
                proc.inputStream.bufferedReader().forEachLine { Log.i(TAG, it) }
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

    private fun status(text: String) {
        Log.i(TAG, "status: $text")
        updateNotice(text)
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

    private fun notice(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("WebMux Host")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setOngoing(true)
            .build()

    private fun updateNotice(text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).notify(NOTE_ID, notice(text))
        }
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(PowerManager::class.java) ?: return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "webmux:host").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    override fun onDestroy() {
        runCatching { control?.stop() }
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ROOTFS_URL = "rootfs_url"
        const val EXTRA_REINSTALL = "reinstall"
        const val EXTRA_REBOOTSTRAP = "rebootstrap"
        private const val TAG = "webmuxhost"
        private const val CHANNEL = "webmux-host"
        private const val NOTE_ID = 1
    }
}
