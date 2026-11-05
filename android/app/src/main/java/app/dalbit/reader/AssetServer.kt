package app.dalbit.reader

import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.IOException

/**
 * Serves the bundled web assets (content script, engine, models, fonts) at
 * https://appassets.androidplatform.net/assets/www/... with correct MIME types.
 *
 * - [isolated] adds COOP/COEP so the engine page is cross-origin isolated and
 *   ONNX Runtime can use SharedArrayBuffer threads.
 * - [cors] lets reader pages (any origin) fetch the bundled fonts.
 */
class AssetServer(private val context: Context, private val isolated: Boolean, private val cors: Boolean) :
    WebViewAssetLoader.PathHandler {

    override fun handle(path: String): WebResourceResponse? {
        if (path.contains("..")) return null
        val stream = try {
            context.assets.open(path, android.content.res.AssetManager.ACCESS_STREAMING)
        } catch (e: IOException) {
            return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }
        val headers = mutableMapOf("Cache-Control" to "no-cache")
        if (isolated) {
            headers["Cross-Origin-Opener-Policy"] = "same-origin"
            headers["Cross-Origin-Embedder-Policy"] = "require-corp"
            headers["Cross-Origin-Resource-Policy"] = "same-origin"
        }
        if (cors) {
            headers["Access-Control-Allow-Origin"] = "*"
            headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        }
        val mime = mimeFor(path)
        val enc = if (mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json")) "utf-8" else null
        return WebResourceResponse(mime, enc, 200, "OK", headers, stream)
    }

    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val BASE = "$ORIGIN/assets/www/"

        fun mimeFor(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "json" -> "application/json"
            "wasm" -> "application/wasm"
            "css" -> "text/css"
            "png" -> "image/png"
            "ttf" -> "font/ttf"
            else -> "application/octet-stream"
        }

        fun loader(context: Context, isolated: Boolean, cors: Boolean): WebViewAssetLoader =
            WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", AssetServer(context, isolated, cors))
                .build()
    }
}
