package dev.webmux.host

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var status: TextView

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

        val sv = ScrollView(this)
        root.addView(title)
        root.addView(subtitle)
        root.addView(start)
        root.addView(battery)
        root.addView(status)
        sv.addView(root)
        setContentView(sv)

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
