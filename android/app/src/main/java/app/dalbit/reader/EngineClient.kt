package app.dalbit.reader

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The on-phone engine: a hidden WebView running engine.html (ONNX Runtime Web
 * OCR + Tesseract + Bergamot translation, the same code as the browser
 * extension). Requests go in via evaluateJavascript, replies come back through
 * the DalbitEngineNative bridge.
 */
@SuppressLint("SetJavaScriptEnabled")
class EngineClient(private val view: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private val seq = AtomicInteger(0)
    private val pending = ConcurrentHashMap<Int, (String) -> Unit>()
    private val queue = ArrayList<String>()
    @Volatile private var ready = false
    @Volatile var isolated = false
        private set

    init {
        val loader = AssetServer.loader(view.context, isolated = true, cors = false)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true // IndexedDB cache
        view.settings.allowFileAccess = false
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)
        }
        view.addJavascriptInterface(Bridge(), "DalbitEngineNative")
        view.loadUrl(AssetServer.BASE + "engine.html")
    }

    private inner class Bridge {
        @JavascriptInterface
        fun postMessage(json: String) {
            val msg = JSONObject(json)
            val id = msg.optInt("id")
            val result = msg.opt("result")?.toString() ?: "null"
            if (id == 0) {
                isolated = msg.optJSONObject("result")?.optBoolean("crossOriginIsolated") ?: false
                main.post {
                    ready = true
                    queue.forEach { view.evaluateJavascript(it, null) }
                    queue.clear()
                }
                return
            }
            pending.remove(id)?.invoke(result)
        }
    }

    /** Send a request ({op: ...}) to the engine; [reply] gets the JSON result string. */
    fun call(request: JSONObject, reply: (String) -> Unit) {
        val id = seq.incrementAndGet()
        request.put("id", id)
        pending[id] = reply
        val js = "window.__engine && __engine.handle(${request})"
        main.post { if (ready) view.evaluateJavascript(js, null) else queue.add(js) }
    }
}
