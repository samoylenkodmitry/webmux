package dev.webmux.host

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Receives UnifiedPush events from the distributor (the ntfy app). A push is a "wake"
 * signal: we start HostService and open a wake window so webmux resumes and the phone
 * is reachable on the tailnet for a short while — the no-Google way to wake a sleeping
 * phone on demand. The endpoint URL (where the fleet POSTs to wake us) is stored so
 * webmux can announce it to peers via the loopback control API.
 */
class WakeReceiver : MessagingReceiver() {

    override fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) {
        Log.i(TAG, "wake endpoint registered: ${endpoint.url}")
        context.getSharedPreferences(HostService.PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_ENDPOINT, endpoint.url).apply()
        ensureService(context, wake = false)
    }

    override fun onMessage(context: Context, message: PushMessage, instance: String) {
        Log.i(TAG, "wake push received (${message.content.size}B)")
        ensureService(context, wake = true)
    }

    override fun onRegistrationFailed(context: Context, reason: FailedReason, instance: String) {
        Log.w(TAG, "wake registration failed: $reason")
    }

    override fun onUnregistered(context: Context, instance: String) {
        Log.i(TAG, "wake unregistered")
        context.getSharedPreferences(HostService.PREFS, Context.MODE_PRIVATE)
            .edit().remove(KEY_ENDPOINT).apply()
    }

    private fun ensureService(context: Context, wake: Boolean) {
        val i = Intent(context, HostService::class.java)
        if (wake) i.putExtra(HostService.EXTRA_WAKE, true)
        ContextCompat.startForegroundService(context, i)
    }

    companion object {
        private const val TAG = "webmuxwake"
        const val KEY_ENDPOINT = "wake_endpoint"
    }
}
