package dev.webmux.host

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.inputmethodservice.InputMethodService
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.widget.TextView

/**
 * A minimal input method (soft keyboard) for WebMux. It draws no keys — it exists so
 * the on-device Claude can inject *arbitrary* keystrokes and read/write the clipboard,
 * which a background app cannot do: only the active IME may call sendKeyEvent / commitText
 * and (on Android 10+) read the clipboard. The user enables it once and switches to it;
 * ControlServer then drives it through the loopback API.
 *
 * Works only while WebMux Keyboard is the *active* input method and a text field is
 * focused (currentInputConnection != null) in whatever app is foreground.
 */
class WebMuxIme : InputMethodService() {

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onCreateInputView(): View =
        TextView(this).apply {
            text = "WebMux Keyboard — driven by Claude (sendkeys + clipboard). " +
                "Switch to your normal keyboard to type by hand."
            setPadding(40, 40, 40, 40)
            textSize = 13f
        }

    /** True when a text field is focused and ready to receive keys/text. */
    fun ready(): Boolean = currentInputConnection != null

    /** Insert literal text at the cursor (like typing on a keyboard). */
    fun typeText(s: String): Boolean = currentInputConnection?.commitText(s, 1) == true

    /** Press a named key (ENTER, TAB, UP, a single char, …) with optional Ctrl/Shift/Alt. */
    fun sendKey(name: String, ctrl: Boolean, shift: Boolean, alt: Boolean): Boolean {
        val ic = currentInputConnection ?: return false
        val code = keyCodeFor(name)
        if (code == KeyEvent.KEYCODE_UNKNOWN) return false
        var meta = 0
        if (ctrl) meta = meta or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        if (shift) meta = meta or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        if (alt) meta = meta or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
        val t = SystemClock.uptimeMillis()
        val down = ic.sendKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0, meta))
        val up = ic.sendKeyEvent(KeyEvent(SystemClock.uptimeMillis(), t, KeyEvent.ACTION_UP, code, 0, meta))
        return down && up
    }

    fun clipboardGet(): String {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return ""
        val clip = cm.primaryClip ?: return ""
        return if (clip.itemCount > 0) clip.getItemAt(0).coerceToText(this).toString() else ""
    }

    fun clipboardSet(text: String): Boolean {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
        cm.setPrimaryClip(ClipData.newPlainText("webmux", text))
        return true
    }

    private fun keyCodeFor(name: String): Int {
        val n = name.trim()
        if (n.length == 1) {
            val c = n[0]
            when (c) {
                in 'a'..'z' -> return KeyEvent.KEYCODE_A + (c - 'a')
                in 'A'..'Z' -> return KeyEvent.KEYCODE_A + (c - 'A')
                in '0'..'9' -> return KeyEvent.KEYCODE_0 + (c - '0')
            }
        }
        return when (n.uppercase()) {
            "ENTER", "RETURN", "CR" -> KeyEvent.KEYCODE_ENTER
            "TAB" -> KeyEvent.KEYCODE_TAB
            "SPACE" -> KeyEvent.KEYCODE_SPACE
            "BACKSPACE", "BKSP", "DEL" -> KeyEvent.KEYCODE_DEL
            "DELETE", "FORWARD_DEL" -> KeyEvent.KEYCODE_FORWARD_DEL
            "ESC", "ESCAPE" -> KeyEvent.KEYCODE_ESCAPE
            "UP" -> KeyEvent.KEYCODE_DPAD_UP
            "DOWN" -> KeyEvent.KEYCODE_DPAD_DOWN
            "LEFT" -> KeyEvent.KEYCODE_DPAD_LEFT
            "RIGHT" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "HOME" -> KeyEvent.KEYCODE_MOVE_HOME
            "END" -> KeyEvent.KEYCODE_MOVE_END
            "PAGEUP", "PAGE_UP" -> KeyEvent.KEYCODE_PAGE_UP
            "PAGEDOWN", "PAGE_DOWN" -> KeyEvent.KEYCODE_PAGE_DOWN
            else -> KeyEvent.keyCodeFromString("KEYCODE_" + n.uppercase())
        }
    }

    companion object {
        @Volatile
        var instance: WebMuxIme? = null
    }
}
