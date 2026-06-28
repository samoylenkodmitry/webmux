package dev.webmux.host

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Onboarding helpers: detect what's set up, open the exact screen to fix each thing,
 * auto-install the push app, and find the OEM "auto-start" screen that aggressive
 * vendors (Huawei/Xiaomi/…) hide and that silently kills background apps.
 */
object Setup {
    const val NTFY_PKG = "io.heckel.ntfy"

    // --- status detection ---------------------------------------------------

    fun batteryUnrestricted(ctx: Context): Boolean {
        val pm = ctx.getSystemService(android.os.PowerManager::class.java) ?: return false
        return pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    fun notificationsOn(ctx: Context): Boolean =
        androidx.core.app.NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    fun accessibilityOn(ctx: Context): Boolean {
        val flat = Settings.Secure.getString(ctx.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return flat.split(':').any { it.substringBefore('/') == ctx.packageName || it.contains("${ctx.packageName}/") }
    }

    fun keyboardEnabled(ctx: Context): Boolean {
        val imm = ctx.getSystemService(InputMethodManager::class.java) ?: return false
        return imm.enabledInputMethodList.any { it.packageName == ctx.packageName }
    }

    fun keyboardSelected(ctx: Context): Boolean {
        val id = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD) ?: return false
        return id.startsWith(ctx.packageName)
    }

    fun ntfyInstalled(ctx: Context): Boolean =
        runCatching { ctx.packageManager.getPackageInfo(NTFY_PKG, 0) }.isSuccess

    fun wakeRegistered(ctx: Context): Boolean =
        !ctx.getSharedPreferences(HostService.PREFS, Context.MODE_PRIVATE)
            .getString(WakeReceiver.KEY_ENDPOINT, "").isNullOrEmpty()

    fun ntfyServerUrl(ctx: Context): String =
        ctx.getSharedPreferences(HostService.PREFS, Context.MODE_PRIVATE).getString(KEY_NTFY_URL, "") ?: ""

    fun setNtfyServerUrl(ctx: Context, url: String) {
        ctx.getSharedPreferences(HostService.PREFS, Context.MODE_PRIVATE).edit().putString(KEY_NTFY_URL, url.trim()).apply()
    }

    // --- OEM auto-start (dontkillmyapp) -------------------------------------

    /**
     * Some vendors hide a per-app "auto-launch" toggle; without it they kill us. We try
     * the exact screen first, but those activities are usually exported=false (only the
     * vendor app / shell can open them), so we fall back to launching the vendor's
     * "manager" app — the user taps App launch from there. Null → caller opens app details.
     */
    fun oemAutostartIntent(ctx: Context): Intent? {
        val pm = ctx.packageManager
        val candidates = listOf(
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.letv.android.letvsafe" to "com.letv.android.letvsafe.AutobootManageActivity",
            "com.asus.mobilemanager" to "com.asus.mobilemanager.entry.FunctionActivity",
        )
        for ((pkg, cls) in candidates) {
            val i = Intent().setClassName(pkg, cls)
            if (pm.resolveActivity(i, 0) != null) return i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        // Exact screen not launchable → open the vendor's manager app home.
        for (mgr in listOf("com.huawei.systemmanager", "com.miui.securitycenter",
                "com.coloros.safecenter", "com.iqoo.secure", "com.vivo.permissionmanager",
                "com.samsung.android.lool", "com.asus.mobilemanager")) {
            pm.getLaunchIntentForPackage(mgr)?.let { return it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        }
        return null
    }

    /** True on vendors known to kill background apps, so we surface the auto-start step. */
    fun isAggressiveOem(): Boolean {
        val m = Build.MANUFACTURER.lowercase()
        return listOf("huawei", "honor", "xiaomi", "redmi", "poco", "oppo", "realme",
            "vivo", "oneplus", "letv", "meizu", "asus").any { m.contains(it) }
    }

    fun appDetailsIntent(ctx: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            android.net.Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    // --- auto-install the ntfy push app -------------------------------------

    /** Resolve the latest ntfy F-Droid-flavor APK (no Google deps) from GitHub releases. */
    fun ntfyApkUrl(): String? = runCatching {
        val c = (URL("https://api.github.com/repos/binwiederhier/ntfy-android/releases/latest").openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000; readTimeout = 15000
            setRequestProperty("Accept", "application/vnd.github+json")
        }
        val body = c.inputStream.bufferedReader().use { it.readText() }
        c.disconnect()
        Regex("\"browser_download_url\"\\s*:\\s*\"([^\"]+fdroid-release\\.apk)\"").find(body)?.groupValues?.get(1)
    }.getOrNull()

    /** Download an APK to cache, reporting 0..100 progress. */
    fun downloadApk(ctx: Context, url: String, name: String, onProgress: (Int) -> Unit): File {
        val out = File(ctx.cacheDir, name)
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true; connectTimeout = 20000; readTimeout = 60000
        }
        c.connect()
        val total = c.contentLength.toLong()
        c.inputStream.use { inp ->
            out.outputStream().use { o ->
                val buf = ByteArray(64 * 1024); var read = 0L; var last = -1; var n: Int
                while (inp.read(buf).also { n = it } >= 0) {
                    o.write(buf, 0, n); read += n
                    if (total > 0) { val p = (read * 100 / total).toInt(); if (p != last) { last = p; onProgress(p) } }
                }
            }
        }
        c.disconnect()
        return out
    }

    private const val KEY_NTFY_URL = "ntfy_url"
}
