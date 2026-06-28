package dev.webmux.host

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import org.unifiedpush.android.connector.UnifiedPush
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var status: TextView
    private lateinit var updateBanner: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(56, 120, 56, 56)
        }
        val title = TextView(this).apply {
            text = "WebMux Host"
            textSize = 26f
        }
        val subtitle = TextView(this).apply {
            text = "Run tmux + Claude on this phone and reach it from any " +
                "webmux on your tailnet."
            textSize = 14f
            setPadding(0, 16, 0, 32)
        }
        // Shown only when a newer APK is published (checked on launch).
        updateBanner = Button(this).apply {
            visibility = View.GONE
            setOnClickListener { updateApp() }
        }
        status = TextView(this).apply {
            text = "Idle."
            textSize = 14f
            setPadding(0, 24, 0, 24)
        }
        val start = Button(this).apply {
            text = "Start / Join fleet"
            setOnClickListener { startHost() }
        }
        val battery = Button(this).apply {
            text = "Allow background (battery)"
            setOnClickListener { requestIgnoreBattery() }
        }
        val phoneControl = Button(this).apply {
            text = "Enable phone control (Accessibility)"
            setOnClickListener {
                startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
                status.text = "In Accessibility settings, enable \"WebMux Host\" so Claude can drive the phone."
            }
        }
        val repair = Button(this).apply {
            text = "Repair / apply updates (keeps Claude login)"
            setOnClickListener {
                val svc = Intent(this@MainActivity, HostService::class.java)
                    .putExtra(HostService.EXTRA_REBOOTSTRAP, true)
                ContextCompat.startForegroundService(this@MainActivity, svc)
                status.text = "Re-running setup (updates webmux + MCP; keeps your rootfs + Claude login)…"
            }
        }
        val updateApp = Button(this).apply {
            text = "Update app (download from GitHub)"
            setOnClickListener { updateApp() }
        }
        val keyboard = Button(this).apply {
            text = "Enable keyboard (sendkeys + clipboard)"
            setOnClickListener { enableKeyboard() }
        }
        val saver = Button(this).apply {
            text = saverLabel()
            setOnClickListener { toggleBatterySaver(this) }
        }
        val wake = Button(this).apply {
            text = "Enable remote wake (lets a sleeping phone be reached)"
            setOnClickListener { enableWake() }
        }

        val sv = ScrollView(this)
        root.addView(title)
        root.addView(subtitle)
        root.addView(updateBanner)
        root.addView(start)
        root.addView(battery)
        root.addView(phoneControl)
        root.addView(keyboard)
        root.addView(saver)
        root.addView(wake)
        root.addView(repair)
        root.addView(updateApp)
        root.addView(status)
        sv.addView(root)
        setContentView(sv)

        checkForUpdateBanner()

        // Start the service while the app is unambiguously in the foreground, BEFORE
        // requesting notifications (whose system dialog would background us and make
        // the foreground-service start illegal on Android 12+).
        // Test hook: `am start … --ez autostart true --es rootfs_url <url>`.
        if (intent?.getBooleanExtra("autostart", false) == true) startHost()

        maybeRequestNotifications()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra("autostart", false)) startHost()
    }

    private fun startHost() {
        android.util.Log.i("webmuxhost", "startHost()")
        val svc = Intent(this, HostService::class.java)
        intent?.getStringExtra(HostService.EXTRA_ROOTFS_URL)?.let {
            svc.putExtra(HostService.EXTRA_ROOTFS_URL, it)
        }
        if (intent?.getBooleanExtra(HostService.EXTRA_REINSTALL, false) == true) {
            svc.putExtra(HostService.EXTRA_REINSTALL, true)
        }
        if (intent?.getBooleanExtra(HostService.EXTRA_REBOOTSTRAP, false) == true) {
            svc.putExtra(HostService.EXTRA_REBOOTSTRAP, true)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(this, svc)
        } else {
            startService(svc)
        }
        status.text = "Host service started — see the notification."
    }

    /** Check GitHub Releases for a newer APK of this app, download it, and install. */
    private fun updateApp() {
        val act = this
        status.text = "Checking GitHub for a newer app…"
        Thread {
            val current = SelfUpdate.currentVersion(act)
            val latest = SelfUpdate.latestVersion()
            when {
                latest == null -> { ui("Update check failed — no network or GitHub unreachable."); return@Thread }
                !SelfUpdate.isNewer(latest, current) -> { ui("Already on the latest app (v$current)."); return@Thread }
            }
            val apk = try {
                ui("New version v$latest — downloading…")
                SelfUpdate.download(act) { p -> ui("Downloading v$latest…  $p%") }
            } catch (e: Exception) { ui("Download failed: ${e.message}"); return@Thread }
            if (!SelfUpdate.canInstall(act)) {
                ui("Allow \"install unknown apps\" for WebMux Host, then tap Update app again.")
                runOnUiThread { SelfUpdate.requestInstallPermission(act) }
                return@Thread
            }
            ui("Opening installer for v$latest — tap Update to finish.")
            runOnUiThread { SelfUpdate.installApk(act, apk) }
        }.start()
    }

    private fun ui(msg: String) = runOnUiThread { status.text = msg }

    /** On launch, surface a one-tap banner if a newer APK is published. */
    private fun checkForUpdateBanner() {
        val act = this
        Thread {
            val current = SelfUpdate.currentVersion(act)
            val latest = SelfUpdate.latestVersion() ?: return@Thread
            if (SelfUpdate.isNewer(latest, current)) runOnUiThread {
                updateBanner.text = "v$latest available — tap to update (you're on v$current)"
                updateBanner.visibility = View.VISIBLE
            }
        }.start()
    }

    private fun saverOn(): Boolean =
        getSharedPreferences(HostService.PREFS, MODE_PRIVATE).getBoolean(HostService.KEY_SAVER, true)

    private fun saverLabel(): String =
        "Battery saver: " + if (saverOn()) "ON (sleeps when unplugged)" else "OFF (always reachable)"

    /** Toggle the wake-lock policy: sleep-when-idle vs always-awake. Applied to the live service. */
    private fun toggleBatterySaver(button: Button) {
        val now = !saverOn()
        getSharedPreferences(HostService.PREFS, MODE_PRIVATE).edit().putBoolean(HostService.KEY_SAVER, now).apply()
        ContextCompat.startForegroundService(
            this, Intent(this, HostService::class.java).putExtra(HostService.EXTRA_SET_SAVER, now)
        )
        button.text = saverLabel()
        status.text = if (now)
            "Battery saver on: the phone sleeps when unplugged + idle; stays awake while charging or while a session is connected, and wakes when you turn the screen on."
        else
            "Battery saver off: the phone stays awake to be reachable anytime (uses more battery)."
    }

    /** Link a UnifiedPush distributor (the ntfy app) and register, so the fleet can wake this phone. */
    private fun enableWake() {
        val act = this
        UnifiedPush.tryUseCurrentOrDefaultDistributor(act) { ok ->
            runOnUiThread {
                if (ok) {
                    UnifiedPush.register(act, instance = HostService.WAKE_INSTANCE,
                        messageForDistributor = "WebMux remote wake")
                    status.text = "Remote wake: registering via your push app… it should now show a WebMux subscription. " +
                        "If nothing happens, install the \"ntfy\" app, set its server to your orange pi, then tap again."
                } else {
                    status.text = "No push app found. Install \"ntfy\" (F-Droid or Play), open it once and set its " +
                        "default server to your orange pi, then tap \"Enable remote wake\" again."
                }
            }
        }
    }

    /** Enable + switch to the WebMux keyboard, which provides sendkeys + clipboard to Claude. */
    private fun enableKeyboard() {
        val imm = getSystemService(InputMethodManager::class.java)
        val enabled = imm?.enabledInputMethodList?.any { it.packageName == packageName } == true
        if (enabled) {
            imm?.showInputMethodPicker()
            status.text = "Pick \"WebMux Keyboard\" to make it active — then Claude can send keys + read/write the clipboard."
        } else {
            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
            status.text = "Turn on \"WebMux Keyboard\", then tap this again to switch to it."
        }
    }

    private fun maybeRequestNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    private fun requestIgnoreBattery() {
        val pm = getSystemService(PowerManager::class.java)
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
            @Suppress("BatteryLife")
            val i = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName")
            )
            startActivity(i)
        } else {
            status.text = "Battery optimization already disabled."
        }
    }
}
