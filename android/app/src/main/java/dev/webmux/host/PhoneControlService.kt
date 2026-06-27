package dev.webmux.host

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The bridge out of Claude's proot box into the actual phone. An Accessibility Service
 * is the only no-root way an app can both SEE the screen (takeScreenshot + the UI tree)
 * and DRIVE it (gestures, text, global actions). The loopback ControlServer calls these
 * methods on behalf of the on-device Claude.
 */
class PhoneControlService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    // --- seeing -------------------------------------------------------------

    /** Capture the screen as PNG bytes (Android 11+; needs canTakeScreenshot). */
    fun screenshot(): ByteArray? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val latch = CountDownLatch(1)
        var out: ByteArray? = null
        val executor = java.util.concurrent.Executor {
            android.os.Handler(android.os.Looper.getMainLooper()).post(it)
        }
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, executor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(result: ScreenshotResult) {
                        try {
                            val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                            val soft = hw?.copy(Bitmap.Config.ARGB_8888, false)
                            result.hardwareBuffer.close()
                            hw?.recycle()
                            if (soft != null) {
                                val bos = ByteArrayOutputStream()
                                soft.compress(Bitmap.CompressFormat.PNG, 90, bos)
                                soft.recycle()
                                out = bos.toByteArray()
                            }
                        } catch (_: Throwable) {} finally { latch.countDown() }
                    }
                    override fun onFailure(errorCode: Int) { latch.countDown() }
                })
        } catch (_: Throwable) { return null }
        latch.await(6, TimeUnit.SECONDS)
        return out
    }

    /** A compact JSON dump of on-screen nodes (text/desc/bounds/flags) for Claude. */
    fun dumpUi(): String {
        val sb = StringBuilder("[")
        val root = rootInActiveWindow
        if (root != null) walk(root, sb, 0)
        sb.append("]")
        return sb.toString()
    }

    private fun walk(node: AccessibilityNodeInfo, sb: StringBuilder, depth: Int) {
        if (depth > 60) return
        val text = node.text?.toString()
        val desc = node.contentDescription?.toString()
        val id = node.viewIdResourceName
        val interesting = !text.isNullOrBlank() || !desc.isNullOrBlank() ||
            node.isClickable || node.isEditable || node.isCheckable
        if (interesting) {
            val r = Rect(); node.getBoundsInScreen(r)
            if (sb.length > 1) sb.append(",")
            sb.append("{")
            text?.takeIf { it.isNotBlank() }?.let { sb.append("\"text\":").append(jsonStr(it)).append(",") }
            desc?.takeIf { it.isNotBlank() }?.let { sb.append("\"desc\":").append(jsonStr(it)).append(",") }
            id?.let { sb.append("\"id\":").append(jsonStr(it.substringAfterLast("/"))).append(",") }
            sb.append("\"cls\":").append(jsonStr(node.className?.toString()?.substringAfterLast(".") ?: "")).append(",")
            sb.append("\"bounds\":[").append(r.left).append(",").append(r.top).append(",")
                .append(r.right).append(",").append(r.bottom).append("]")
            if (node.isClickable) sb.append(",\"tap\":1")
            if (node.isEditable) sb.append(",\"edit\":1")
            if (node.isCheckable) sb.append(",\"checked\":").append(node.isChecked)
            if (node.isScrollable) sb.append(",\"scroll\":1")
            sb.append("}")
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { walk(it, sb, depth + 1) }
        }
    }

    // --- doing --------------------------------------------------------------

    fun tap(x: Float, y: Float): Boolean = gesture(Path().apply { moveTo(x, y) }, 1L)

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long): Boolean =
        gesture(Path().apply { moveTo(x1, y1); lineTo(x2, y2) }, ms.coerceIn(20, 5000))

    private fun gesture(path: Path, durationMs: Long): Boolean {
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val g = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(g, null, null)
    }

    /** Set text on the currently focused editable field. */
    fun setText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: firstEditable(root) ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun firstEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { firstEditable(it) }?.let { return it }
        }
        return null
    }

    /** Global actions by name: BACK, HOME, RECENTS, NOTIFICATIONS, QUICK_SETTINGS, etc. */
    fun globalAction(name: String): Boolean {
        val a = when (name.uppercase()) {
            "BACK" -> GLOBAL_ACTION_BACK
            "HOME" -> GLOBAL_ACTION_HOME
            "RECENTS" -> GLOBAL_ACTION_RECENTS
            "NOTIFICATIONS" -> GLOBAL_ACTION_NOTIFICATIONS
            "QUICK_SETTINGS" -> GLOBAL_ACTION_QUICK_SETTINGS
            "LOCK" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_LOCK_SCREEN else return false
            "POWER" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) GLOBAL_ACTION_POWER_DIALOG else return false
            else -> return false
        }
        return performGlobalAction(a)
    }

    companion object {
        @Volatile
        var instance: PhoneControlService? = null

        private fun jsonStr(s: String): String {
            val b = StringBuilder("\"")
            for (c in s) when (c) {
                '"' -> b.append("\\\"")
                '\\' -> b.append("\\\\")
                '\n' -> b.append("\\n")
                '\r' -> b.append("\\r")
                '\t' -> b.append("\\t")
                else -> if (c < ' ') b.append(' ') else b.append(c)
            }
            return b.append("\"").toString()
        }
    }
}
