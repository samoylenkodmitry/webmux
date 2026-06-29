package dev.webmux.host

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat

/** Restart the host service after a reboot so the phone rejoins the fleet on its own. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            // On-demand: stay dead after a reboot — only a wake demand should fire the box.
            val onDemand = context.getSharedPreferences(HostService.PREFS, Context.MODE_PRIVATE)
                .getBoolean(HostService.KEY_ONDEMAND, false)
            if (onDemand) return
            val svc = Intent(context, HostService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, svc)
            } else {
                context.startService(svc)
            }
        }
    }
}
