package dev.webmux.host

import android.content.Context
import android.content.Intent
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayInputStream

/**
 * Loopback-only HTTP control API (127.0.0.1:[port]) that the on-device Claude calls
 * (via the `phone` CLI / MCP inside proot) to drive the phone through PhoneControlService.
 * Bound to 127.0.0.1 so it's reachable from inside proot but NOT over the tailnet.
 */
class ControlServer(private val ctx: Context, port: Int = 8084) :
    NanoHTTPD("127.0.0.1", port) {

    override fun serve(session: IHTTPSession): Response = try {
        route(session)
    } catch (t: Throwable) {
        json(Response.Status.INTERNAL_ERROR, "{\"error\":${q(t.message ?: "error")}}")
    }

    private fun route(s: IHTTPSession): Response {
        fun p(k: String): String? = s.parameters[k]?.firstOrNull()
        fun f(k: String, d: Float) = p(k)?.toFloatOrNull() ?: d

        if (s.uri == "/health")
            return json(Response.Status.OK,
                "{\"ok\":true,\"accessibility\":${PhoneControlService.instance != null}," +
                    "\"keyboard\":${WebMuxIme.instance != null}}")

        // Keyboard (IME) routes: full-keyboard sendkeys + clipboard. These need the
        // WebMux Keyboard to be the active input method, NOT accessibility.
        when (s.uri) {
            "/ime/text" -> return imeOp { it.typeText(bodyOrParam(s, "text")) }
            "/ime/key" -> return imeOp {
                it.sendKey(p("name") ?: "", p("ctrl") == "1", p("shift") == "1", p("alt") == "1")
            }
            "/clipboard" -> {
                val ime = WebMuxIme.instance ?: return imeUnavailable()
                return if (s.method == Method.POST) ok(ime.clipboardSet(bodyOrParam(s, "text")))
                else json(Response.Status.OK, "{\"text\":${q(ime.clipboardGet())}}")
            }
        }

        val svc = PhoneControlService.instance
            ?: return json(Response.Status.SERVICE_UNAVAILABLE,
                "{\"error\":\"accessibility not enabled — open WebMux Host and enable it in Android Settings\"}")

        return when (s.uri) {
            "/screenshot" -> {
                val b = svc.screenshot()
                if (b == null) json(Response.Status.INTERNAL_ERROR, "{\"error\":\"screenshot failed\"}")
                else newFixedLengthResponse(Response.Status.OK, "image/png",
                    ByteArrayInputStream(b), b.size.toLong())
            }
            "/ui" -> json(Response.Status.OK, svc.dumpUi())
            "/tap" -> ok(svc.tap(f("x", 0f), f("y", 0f)))
            "/swipe" -> ok(svc.swipe(f("x1", 0f), f("y1", 0f), f("x2", 0f), f("y2", 0f),
                p("ms")?.toLongOrNull() ?: 300L))
            "/text" -> ok(svc.setText(bodyOrParam(s, "text")))
            "/key" -> ok(svc.globalAction(p("name") ?: ""))
            "/launch" -> ok(launch(p("pkg") ?: ""))
            "/apps" -> json(Response.Status.OK, listApps())
            else -> json(Response.Status.NOT_FOUND, "{\"error\":\"unknown endpoint\"}")
        }
    }

    private fun launch(pkg: String): Boolean {
        val intent = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent)
        return true
    }

    private fun listApps(): String {
        val pm = ctx.packageManager
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val sb = StringBuilder("[")
        for (ri in pm.queryIntentActivities(main, 0)) {
            val pkg = ri.activityInfo.packageName
            val label = ri.loadLabel(pm).toString()
            if (sb.length > 1) sb.append(",")
            sb.append("{\"label\":").append(q(label)).append(",\"pkg\":").append(q(pkg)).append("}")
        }
        return sb.append("]").toString()
    }

    private fun bodyOrParam(s: IHTTPSession, key: String): String {
        s.parameters[key]?.firstOrNull()?.let { return it }
        return try {
            val m = HashMap<String, String>()
            s.parseBody(m)
            m["postData"] ?: ""
        } catch (_: Throwable) { "" }
    }

    private fun imeOp(op: (WebMuxIme) -> Boolean): Response {
        val ime = WebMuxIme.instance ?: return imeUnavailable()
        return ok(op(ime))
    }

    private fun imeUnavailable() =
        json(Response.Status.SERVICE_UNAVAILABLE,
            "{\"error\":\"WebMux Keyboard not active — enable it in WebMux Host and switch to it (and focus a text field for sendkeys)\"}")

    private fun ok(b: Boolean) =
        json(if (b) Response.Status.OK else Response.Status.INTERNAL_ERROR, "{\"ok\":$b}")

    private fun json(status: Response.Status, body: String) =
        newFixedLengthResponse(status, "application/json", body)

    private fun q(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) when (c) {
            '"' -> b.append("\\\""); '\\' -> b.append("\\\\")
            '\n' -> b.append("\\n"); '\r' -> b.append("\\r"); '\t' -> b.append("\\t")
            else -> if (c < ' ') b.append(' ') else b.append(c)
        }
        return b.append("\"").toString()
    }
}
