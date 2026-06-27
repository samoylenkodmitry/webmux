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
        val reinstall = intent?.getBooleanExtra(EXTRA_REINSTALL, false) ?: false
        val rebootstrap = intent?.getBooleanExtra(EXTRA_REBOOTSTRAP, false) ?: false
        if (working.compareAndSet(false, true)) {
            Thread { bringUp(url, reinstall, rebootstrap) }.start()
        }
        return START_STICKY
    }

    private fun bringUp(url: String, reinstall: Boolean, rebootstrap: Boolean) {
        try {
            if (reinstall) { status("Wiping userland for clean reinstall…"); userland.wipe() }
            else if (rebootstrap) { status("Re-running bootstrap…"); userland.clearBootstrap() }
            userland.prepareRuntime()
            if (!userland.isInstalled()) {
                userland.install(url) { msg -> status(msg) }
            }
            if (!userland.isBootstrapped()) {
                status("Installing toolchain + webmux + Claude (several min)…")
                val rc = userland.bootstrap { line ->
                    Log.i(TAG, line)
                    if (line.startsWith("BOOT:")) status(line.removePrefix("BOOT:").trim())
                }
                if (rc != 0 || !userland.isBootstrapped()) {
                    status("Bootstrap failed (rc=$rc)"); return
                }
            }
            runWebmuxForever()
        } catch (t: Throwable) {
            Log.e(TAG, "bringUp failed", t)
            status("Error: ${t.message}")
        } finally {
            working.set(false)
        }
    }

    /** Resolve the tailnet IP, launch webmux (which seeds its sessions), restart if it dies. */
    private fun runWebmuxForever() {
        while (true) {
            val ip = waitForTailnetIp()
            if (ip == null) { status("Waiting for Tailscale… open the Tailscale app"); Thread.sleep(8000); continue }
            status("Starting webmux on $ip:8083…")
            val proc = userland.startWebmux(ip)
            status("✓ On the fleet — http://$ip:8083")
            proc.inputStream.bufferedReader().forEachLine { Log.i(TAG, it) }
            val rc = proc.waitFor()
            status("webmux exited (rc=$rc) — restarting…")
            Thread.sleep(3000)
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
