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
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.unifiedpush.android.connector.UnifiedPush

/**
 * Guided setup: a live checklist that detects what's configured, opens the exact screen
 * for what isn't, auto-installs the push app, surfaces the OEM auto-start screen, and
 * auto-configures ntfy via the accessibility service. The aim is the fewest manual taps.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var status: TextView
    private lateinit var updateBanner: Button
    private lateinit var checklist: LinearLayout
    private lateinit var hostInfo: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(56, 96, 56, 56)
        }
        root.addView(TextView(this).apply { text = "WebMux Host"; textSize = 26f })
        root.addView(TextView(this).apply {
            text = "Run tmux + Claude on this phone and reach it from any webmux on your tailnet."
            textSize = 14f; setPadding(0, 12, 0, 8)
        })
        hostInfo = TextView(this).apply { textSize = 12f; alpha = 0.6f; setPadding(0, 4, 0, 0) }
        root.addView(hostInfo)
        updateBanner = Button(this).apply { visibility = View.GONE; setOnClickListener { updateApp() } }
        root.addView(updateBanner)

        root.addView(Button(this).apply {
            text = "Start / Join fleet"
            setOnClickListener { startHost() }
        })
        root.addView(sectionLabel("Setup"))
        checklist = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(checklist)

        root.addView(sectionLabel("Maintenance"))
        root.addView(Button(this).apply {
            text = "Repair / apply updates (keeps Claude login)"
            setOnClickListener {
                ContextCompat.startForegroundService(this@MainActivity,
                    Intent(this@MainActivity, HostService::class.java).putExtra(HostService.EXTRA_REBOOTSTRAP, true))
                status.text = "Re-running setup inside the box (updates webmux + Claude; keeps your login)…"
            }
        })
        root.addView(Button(this).apply {
            text = "Update app (download from GitHub)"
            setOnClickListener { updateApp() }
        })

        status = TextView(this).apply { text = "Idle."; textSize = 14f; setPadding(0, 24, 0, 24) }
        root.addView(status)

        val sv = ScrollView(this); sv.addView(root); setContentView(sv)

        if (intent?.getBooleanExtra("autostart", false) == true) startHost()
        ensureNotificationPermission()
        checkForUpdateBanner()
    }

    override fun onResume() {
        super.onResume()
        refreshChecklist()
        refreshHostInfo()
    }

    /** Show the app version and the box's webmux version side by side — a lagging box
     *  (new app, old webmux inside) is the kind of mismatch that used to be invisible. */
    private fun refreshHostInfo() {
        val app = SelfUpdate.currentVersion(this)
        val box = HostService.lastBoxVersion
        hostInfo.text = "App v$app" + (box?.let { " · box webmux $it" } ?: "")
    }

    // --- checklist ----------------------------------------------------------

    private fun sectionLabel(t: String) = TextView(this).apply {
        text = t; textSize = 12f; setPadding(0, 28, 0, 4); alpha = 0.6f
    }

    /** Rebuild the checklist from current live status. Called on every resume. */
    private fun refreshChecklist() {
        checklist.removeAllViews()
        row("Allow background (battery)", "So Android doesn't kill the box",
            Setup.batteryUnrestricted(this)) { requestIgnoreBattery() }
        row("Notifications", "Show the running status",
            Setup.notificationsOn(this)) { openAppNotificationSettings() }
        if (Setup.isAggressiveOem()) {
            row("Allow auto-start (${Build.MANUFACTURER})", "Your phone hides this; without it it kills the app",
                null) { openOemAutostart() }
        }
        row("Phone control (accessibility)", "Lets Claude tap/see the screen",
            Setup.accessibilityOn(this)) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            status.text = "Enable \"WebMux Host\" in Accessibility."
        }
        row("Keyboard (sendkeys + clipboard)", "Lets Claude type + use the clipboard",
            Setup.keyboardEnabled(this) && Setup.keyboardSelected(this)) { enableKeyboard() }
        row("Push app (ntfy)", "Doorbell that wakes a sleeping phone",
            Setup.ntfyInstalled(this)) { installNtfy() }
        row("Remote wake", "Reach this phone even when it's asleep",
            if (Setup.wakeRegistered(this)) true else false) { setUpWake() }
    }

    /** A checklist row: ✓ done (grey), or a tappable "fix this" button. */
    private fun row(title: String, detail: String, done: Boolean?, fix: () -> Unit) {
        val mark = when (done) { true -> "✓"; false -> "◻"; null -> "•" }
        checklist.addView(Button(this).apply {
            text = "$mark  $title\n$detail"
            textSize = 14f
            setAllCaps(false)
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            alpha = if (done == true) 0.55f else 1f
            setOnClickListener { fix(); }
        })
    }

    // --- remote-wake setup (the multi-step one) -----------------------------

    private fun setUpWake() {
        if (!Setup.ntfyInstalled(this)) {
            status.text = "Installing the wake app (ntfy)…"
            installNtfy()
            toast("When ntfy finishes installing, tap “Remote wake” again.")
            return
        }
        // One tap: register for push wake using the ntfy app's push server as-is. No URL
        // to type, no ntfy settings to change — the wake endpoint comes back to us
        // automatically and we confirm below.
        status.text = "Turning on remote wake…"
        registerWake()
        val act = this
        Thread {
            var ok = false
            for (n in 0 until 24) { Thread.sleep(500); if (Setup.wakeRegistered(act)) { ok = true; break } }
            runOnUiThread {
                refreshChecklist()
                status.text = if (ok)
                    "✓ Remote wake is ON — the fleet can wake this phone when it's asleep."
                else
                    "Couldn't turn on remote wake. Open the ntfy app once so it's running, make sure ntfy + WebMux Host are allowed to run in the background (the auto-start step above), then tap Remote wake again."
            }
        }.start()
    }

    private fun toast(msg: String) =
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_LONG).show()

    private fun registerWake() {
        val act = this
        UnifiedPush.tryUseCurrentOrDefaultDistributor(act) { ok ->
            if (ok) UnifiedPush.register(act, instance = HostService.WAKE_INSTANCE, messageForDistributor = "WebMux remote wake")
        }
    }

    private fun installNtfy() {
        val act = this
        status.text = "Fetching the ntfy app…"
        Thread {
            val url = Setup.ntfyApkUrl()
            if (url == null) { ui("Couldn't reach GitHub. Install \"ntfy\" from F-Droid or Play, then come back."); return@Thread }
            val apk = try { Setup.downloadApk(act, url, "ntfy.apk") { p -> ui("Downloading ntfy… $p%") } }
            catch (e: Exception) { ui("ntfy download failed: ${e.message}"); return@Thread }
            if (!SelfUpdate.canInstall(act)) {
                ui("Allow \"install unknown apps\" for WebMux Host, then tap Push app again.")
                runOnUiThread { SelfUpdate.requestInstallPermission(act) }; return@Thread
            }
            ui("Opening installer for ntfy — tap Install.")
            runOnUiThread { SelfUpdate.installApk(act, apk) }
        }.start()
    }

    private fun openOemAutostart() {
        val i = Setup.oemAutostartIntent(this)
        if (i != null) {
            runCatching { startActivity(i) }.onFailure { startActivity(Setup.appDetailsIntent(this)) }
            status.text = "Find WebMux Host (and ntfy) and turn ON auto-launch / run in background."
        } else {
            startActivity(Setup.appDetailsIntent(this))
            status.text = "Allow background activity / auto-launch for WebMux Host here."
        }
    }

    // --- keyboard / battery / notifications ---------------------------------

    private fun enableKeyboard() {
        val imm = getSystemService(InputMethodManager::class.java)
        if (Setup.keyboardEnabled(this)) {
            imm?.showInputMethodPicker()
            status.text = "Pick \"WebMux Keyboard\" to make it active."
        } else {
            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
            status.text = "Turn on \"WebMux Keyboard\", then tap this again to switch to it."
        }
    }

    private fun requestIgnoreBattery() {
        val pm = getSystemService(PowerManager::class.java)
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
            @Suppress("BatteryLife")
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } else status.text = "Battery optimization already off."
    }

    private fun openAppNotificationSettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        } else {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshChecklist()
    }

    // --- app self-update ----------------------------------------------------

    private fun updateApp() {
        val act = this
        status.text = "Checking GitHub for a newer app…"
        Thread {
            val current = SelfUpdate.currentVersion(act)
            val latest = SelfUpdate.latestVersion()
            when {
                latest == null -> { ui("Update check failed — no network?"); return@Thread }
                !SelfUpdate.isNewer(latest, current) -> { ui("Already on the latest app (v$current)."); return@Thread }
            }
            val apk = try { ui("Downloading v$latest…"); SelfUpdate.download(act) { p -> ui("Downloading v$latest…  $p%") } }
            catch (e: Exception) { ui("Download failed: ${e.message}"); return@Thread }
            if (!SelfUpdate.canInstall(act)) {
                ui("Allow \"install unknown apps\" for WebMux Host, then tap Update app again.")
                runOnUiThread { SelfUpdate.requestInstallPermission(act) }; return@Thread
            }
            ui("Opening installer for v$latest — tap Update.")
            runOnUiThread { SelfUpdate.installApk(act, apk) }
        }.start()
    }

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

    private fun ui(msg: String) = runOnUiThread { status.text = msg }

    private fun startHost() {
        val svc = Intent(this, HostService::class.java)
        intent?.getStringExtra(HostService.EXTRA_ROOTFS_URL)?.let { svc.putExtra(HostService.EXTRA_ROOTFS_URL, it) }
        ContextCompat.startForegroundService(this, svc)
        status.text = "Host service started — see the notification."
    }
}
