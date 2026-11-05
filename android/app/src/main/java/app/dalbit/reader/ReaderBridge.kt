package app.dalbit.reader

import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/**
 * Native side of the content script's WebExtension shim (shim.ts):
 * storage, image download (with the page's cookies + Referer) and routing to
 * the on-phone engine or to the user's own Dalbit service (e.g. a laptop over
 * Tailscale). The service token never leaves native code.
 */
class ReaderBridge(
    private val reader: WebView,
    private val engine: EngineClient,
    private val prefs: SharedPreferences,
) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(3)
    @Volatile var userAgent: String = ""

    // ------------------------------------------------------------------ storage
    // Everything the content script stores lives in one JSON object.
    @Synchronized fun store(): JSONObject = JSONObject(prefs.getString("store", "{}") ?: "{}")

    @Synchronized fun saveStore(o: JSONObject) { prefs.edit().putString("store", o.toString()).apply() }

    fun settings(): JSONObject = store().optJSONObject("settings") ?: JSONObject()

    var serviceToken: String
        get() = prefs.getString("serviceToken", "") ?: ""
        set(v) { prefs.edit().putString("serviceToken", v).apply() }

    /** Called by the settings dialog; tells the page so it can re-render. */
    fun updateSettings(patch: JSONObject) {
        val s = store()
        val old = s.optJSONObject("settings") ?: JSONObject()
        val next = JSONObject(old.toString())
        patch.keys().forEach { next.put(it, patch.get(it)) }
        s.put("settings", next)
        saveStore(s)
        val changes = JSONObject().put("settings", JSONObject().put("oldValue", old).put("newValue", next))
        js("window.__dalbitBridge && __dalbitBridge.storageChanged($changes)")
    }

    // ------------------------------------------------------------------ bridge entry
    @JavascriptInterface
    fun postMessage(json: String) {
        val m = try { JSONObject(json) } catch (e: Exception) { return }
        val id = m.optInt("id")
        when (m.optString("kind")) {
            "storage-get" -> {
                val all = store()
                val keys = m.optJSONArray("keys")
                val out = JSONObject()
                if (keys == null) all.keys().forEach { out.put(it, all.get(it)) }
                else for (i in 0 until keys.length()) { val k = keys.getString(i); if (all.has(k)) out.put(k, all.get(k)) }
                deliver(id, out.toString())
            }
            "storage-set" -> {
                val items = m.optJSONObject("items") ?: JSONObject()
                val s = store()
                val changes = JSONObject()
                items.keys().forEach { k ->
                    if (k == "settings") return@forEach // settings are edited in the app's own dialog
                    changes.put(k, JSONObject().put("oldValue", s.opt(k)).put("newValue", items.get(k)))
                    s.put(k, items.get(k))
                }
                saveStore(s)
                deliver(id, "true")
                if (changes.length() > 0) js("window.__dalbitBridge && __dalbitBridge.storageChanged($changes)")
            }
            "message" -> io.execute { deliver(id, handleMessage(m.optJSONObject("msg") ?: JSONObject())) }
            else -> deliver(id, "null")
        }
    }

    private fun deliver(id: Int, resultJson: String) =
        js("window.__dalbitBridge && __dalbitBridge.deliver($id, $resultJson)")

    private fun js(code: String) = main.post { reader.evaluateJavascript(code, null) }

    private fun useService(): Boolean = settings().optString("engine", "builtin") == "service"

    private fun serviceUrl(): String = settings().optString("serviceUrl", "http://127.0.0.1:47615").trimEnd('/')

    // ------------------------------------------------------------------ messages
    private fun handleMessage(msg: JSONObject): String = try {
        when (msg.optString("type")) {
            "health" -> if (useService()) serviceHealth() else engineCall(JSONObject().put("op", if (msg.optBoolean("load")) "load" else "status")).let(::engineHealth)
            "translate-image" -> translateImage(msg)
            "cancel" -> {
                val ids = msg.optJSONArray("ids") ?: JSONArray()
                if (useService()) post("/v1/cancel", JSONObject().put("requestIds", ids).toString().toByteArray(), "application/json")
                else engine.call(JSONObject().put("op", "cancel").put("ids", ids)) {}
                "{\"ok\":true}"
            }
            "translate-text" -> {
                val s = settings()
                val texts = msg.optJSONArray("texts") ?: JSONArray()
                if (useService()) {
                    val body = JSONObject().put("texts", texts).put("src", s.optString("sourceLang", "ko"))
                        .put("tgt", s.optString("targetLang", "en")).put("glossary", s.optJSONObject("glossary") ?: JSONObject())
                    val (code, text) = post("/v1/translate-text", body.toString().toByteArray(), "application/json")
                    if (code == 200) JSONObject().put("ok", true).put("translations", JSONObject(text).getJSONArray("translations")).toString()
                    else fail("service-error", "HTTP $code")
                } else engineCall(JSONObject().put("op", "translate-text").put("texts", texts).put("glossary", s.optJSONObject("glossary") ?: JSONObject()))
            }
            else -> "null"
        }
    } catch (e: Exception) {
        fail("service-error", e.message ?: e.toString())
    }

    private fun fail(code: String, message: String, status: Int? = null): String =
        JSONObject().put("ok", false).put("code", code).put("error", message).apply { if (status != null) put("status", status) }.toString()

    /** Blocking call into the engine WebView (we are on an io thread). */
    private fun engineCall(req: JSONObject, timeoutMs: Long = 180_000): String {
        val lock = Object()
        var out: String? = null
        engine.call(req) { r -> synchronized(lock) { out = r; lock.notifyAll() } }
        synchronized(lock) {
            val end = System.currentTimeMillis() + timeoutMs
            while (out == null && System.currentTimeMillis() < end) lock.wait(1000)
        }
        return out ?: fail("service-error", "on-phone engine did not answer in time")
    }

    private fun engineHealth(statusJson: String): String {
        val st = JSONObject(statusJson)
        val state = st.optString("state")
        return JSONObject()
            .put("state", if (state == "error") "error" else "ok")
            .put("engine", "builtin")
            .put("message", st.optString("message", "On-phone engine") + if (engine.isolated) "" else " (single-threaded)")
            .put("targets", JSONArray().put("en"))
            .toString()
    }

    private fun translateImage(msg: JSONObject): String {
        val s = settings()
        val bytes: ByteArray = when {
            msg.has("dataBase64") -> Base64.decode(msg.getString("dataBase64"), Base64.DEFAULT)
            msg.optString("url").startsWith("data:") -> Base64.decode(msg.getString("url").substringAfter(","), Base64.DEFAULT)
            msg.optString("url").startsWith("http") -> {
                val got = fetchImage(msg.getString("url"), msg.optString("pageUrl"), msg.optInt("attempt", 1) > 1)
                got.first ?: return fail("fetch-failed", got.second, got.third)
            }
            else -> return fail("fetch-failed", "unsupported image URL") // blob: etc. -> page fallback
        }
        if (useService()) return serviceTranslate(bytes, msg.optString("id"), s)
        val req = JSONObject()
            .put("id", msg.optString("id"))
            .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            .put("pageUrl", msg.optString("pageUrl"))
            .put("src", s.optString("sourceLang", "ko"))
            .put("tgt", s.optString("targetLang", "en"))
            .put("sfxMode", s.optString("sfxMode", "annotate"))
            .put("glossary", s.optJSONObject("glossary") ?: JSONObject())
        return engineCall(JSONObject().put("op", "process").put("req", req))
    }

    /** Download an image like the page would: its cookies, its Referer, the WebView's UA. */
    private fun fetchImage(url: String, pageUrl: String, retry: Boolean): Triple<ByteArray?, String, Int?> {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 60_000
                instanceFollowRedirects = true
                if (pageUrl.isNotEmpty()) setRequestProperty("Referer", pageUrl)
                if (userAgent.isNotEmpty()) setRequestProperty("User-Agent", userAgent)
                CookieManager.getInstance().getCookie(url)?.let { setRequestProperty("Cookie", it) }
                setRequestProperty("Accept", "image/avif,image/webp,image/*,*/*;q=0.8")
                if (retry) setRequestProperty("Cache-Control", "no-cache")
            }
            val code = conn.responseCode
            if (code !in 200..299) return Triple(null, "image request failed with HTTP $code", code)
            val type = conn.contentType ?: ""
            if (type.isNotEmpty() && !type.startsWith("image/") && !type.contains("octet-stream")) {
                return Triple(null, "server returned $type, not an image", code)
            }
            Triple(readLimited(conn.inputStream.buffered()), "", code)
        } catch (e: Exception) {
            Triple(null, "network error fetching image (${e.message})", null)
        } finally {
            conn?.disconnect()
        }
    }

    private fun readLimited(input: java.io.InputStream, max: Int = 40 * 1024 * 1024): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        input.use { s ->
            while (true) {
                val n = s.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > max) throw IllegalStateException("image larger than 40 MB")
            }
        }
        return out.toByteArray()
    }

    // ------------------------------------------------------------------ remote service
    private fun request(path: String, method: String, body: ByteArray?, type: String?, extra: Map<String, String> = emptyMap()): Pair<Int, String> {
        val conn = (URL(serviceUrl() + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8_000
            readTimeout = 300_000
            setRequestProperty("Authorization", "Bearer $serviceToken")
            extra.forEach { (k, v) -> setRequestProperty(k, v) }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", type ?: "application/octet-stream")
                outputStream.use { it.write(body) }
            }
        }
        return try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            code to (stream?.bufferedReader()?.use { it.readText() } ?: "")
        } finally {
            conn.disconnect()
        }
    }

    private fun post(path: String, body: ByteArray, type: String, extra: Map<String, String> = emptyMap()) = request(path, "POST", body, type, extra)

    private fun serviceHealth(): String {
        val url = serviceUrl()
        return try {
            val (code, text) = request("/v1/health", "GET", null, null)
            if (code != 200) return JSONObject().put("state", "error").put("engine", "service").put("message", "Service answered HTTP $code").toString()
            val body = JSONObject(text)
            if (!body.optBoolean("authenticated")) {
                JSONObject().put("state", "unauthorized").put("engine", "service")
                    .put("message", "Service at $url is running, but the pairing token is missing or wrong (Settings).").toString()
            } else {
                JSONObject().put("state", "ok").put("engine", "service").put("message", "Connected to $url")
                    .put("targets", body.optJSONObject("targets")?.optJSONArray(settings().optString("sourceLang", "ko")) ?: JSONArray()).toString()
            }
        } catch (e: Exception) {
            JSONObject().put("state", "unreachable").put("engine", "service")
                .put("message", "Service not reachable at $url. Is your laptop awake, the service running with --allow-remote, and Tailscale connected?").toString()
        }
    }

    private fun serviceTranslate(bytes: ByteArray, requestId: String, s: JSONObject): String {
        val q = listOf("src" to s.optString("sourceLang", "ko"), "tgt" to s.optString("targetLang", "en"),
            "sfx" to s.optString("sfxMode", "annotate"), "requestId" to requestId)
            .joinToString("&") { (k, v) -> "$k=" + URLEncoder.encode(v, "UTF-8") }
        val opts = Base64.encodeToString(JSONObject().put("glossary", s.optJSONObject("glossary") ?: JSONObject()).toString().toByteArray(), Base64.NO_WRAP)
        return try {
            val (code, text) = post("/v1/translate?$q", bytes, "application/octet-stream", mapOf("X-Dalbit-Options" to opts))
            when (code) {
                200 -> JSONObject().put("ok", true).put("result", JSONObject(text)).toString()
                401 -> fail("unauthorized", "pairing token missing or wrong", code)
                409 -> fail("cancelled", "cancelled", code)
                422 -> fail("image-rejected", JSONObject(text).optString("error", "image rejected"), code)
                503 -> fail("translation-unavailable", JSONObject(text).optString("error", "translation unavailable"), code)
                else -> fail("service-error", "HTTP $code", code)
            }
        } catch (e: Exception) {
            fail("service-unreachable", "Service not reachable at ${serviceUrl()} (${e.message})")
        }
    }
}
