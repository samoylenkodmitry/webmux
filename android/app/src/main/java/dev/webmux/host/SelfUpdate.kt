package dev.webmux.host

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app self-update: pull the latest signed APK of ourselves from GitHub Releases and
 * hand it to the system package installer (same signing key → in-place update, keeps
 * data + the Claude login). Every release carries a stable-named asset `webmux-host.apk`,
 * and GitHub's `/releases/latest/download/<asset>` serves it from whatever the newest
 * release is — so the URL never hard-codes a version. Version detection reads the tag
 * from the `/releases/latest` redirect, avoiding the rate-limited API.
 */
object SelfUpdate {
    private const val REPO = "samoylenkodmitry/webmux"
    private const val LATEST = "https://github.com/$REPO/releases/latest"
    private const val APK_URL = "https://github.com/$REPO/releases/latest/download/webmux-host.apk"
    private val TAG_VERSION = Regex("""host-v(\d+(?:\.\d+)*)""")

    fun currentVersion(ctx: Context): String =
        runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "0"

    /** Newest published version, parsed from the `/releases/latest` 30x redirect target. */
    fun latestVersion(): String? = runCatching {
        val c = (URL(LATEST).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = false
            connectTimeout = 15000; readTimeout = 15000
            setRequestProperty("Accept", "text/html")
        }
        val loc = c.getHeaderField("Location") ?: c.url.toString()
        c.disconnect()
        TAG_VERSION.find(loc)?.groupValues?.get(1)
    }.getOrNull()

    /** True iff remote dotted-int version is strictly greater than current. */
    fun isNewer(remote: String, current: String): Boolean {
        val r = remote.split('.'); val c = current.split('.')
        for (i in 0 until maxOf(r.size, c.size)) {
            val a = r.getOrNull(i)?.toIntOrNull() ?: 0
            val b = c.getOrNull(i)?.toIntOrNull() ?: 0
            if (a != b) return a > b
        }
        return false
    }

    /** Download the latest APK into cacheDir/update.apk, reporting 0..100 progress. */
    fun download(ctx: Context, onProgress: (Int) -> Unit): File {
        val out = File(ctx.cacheDir, "update.apk")
        val c = (URL(APK_URL).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 20000; readTimeout = 60000
        }
        c.connect()
        val total = c.contentLength.toLong()
        c.inputStream.use { inp ->
            out.outputStream().use { o ->
                val buf = ByteArray(64 * 1024); var read = 0L; var lastPct = -1; var n: Int
                while (inp.read(buf).also { n = it } >= 0) {
                    o.write(buf, 0, n); read += n
                    if (total > 0) {
                        val pct = (read * 100 / total).toInt()
                        if (pct != lastPct) { lastPct = pct; onProgress(pct) }
                    }
                }
            }
        }
        c.disconnect()
        return out
    }

    /** Android 8+ requires a per-app "install unknown apps" grant before we can install. */
    fun canInstall(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ctx.packageManager.canRequestPackageInstalls()

    fun requestInstallPermission(ctx: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
    }

    /** Launch the system installer for the downloaded APK. */
    fun installApk(ctx: Context, apk: File) {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", apk)
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        )
    }
}
