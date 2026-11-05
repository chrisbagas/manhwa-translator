package app.dalbit.reader

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * Dalbit for Android: a small browser for reader sites. "Translate" injects the
 * same content script the desktop extension uses; OCR + translation run in the
 * on-phone engine (hidden WebView) or on the user's own Dalbit service.
 */
class MainActivity : Activity() {
    private lateinit var reader: WebView
    private lateinit var engineView: WebView
    private lateinit var urlBar: EditText
    private lateinit var progress: ProgressBar
    private lateinit var engine: EngineClient
    private lateinit var bridge: ReaderBridge
    private val prefs by lazy { getSharedPreferences("dalbit", MODE_PRIVATE) }
    private var injected = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG) // chrome://inspect from a desktop

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.parseColor("#16161D")) }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(6), dp(4), dp(6), dp(4)) }
        urlBar = EditText(this).apply {
            setSingleLine()
            hint = "Reader page URL"
            textSize = 14f
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setOnEditorActionListener { _, action, event ->
                if (action == EditorInfo.IME_ACTION_GO || event?.keyCode == KeyEvent.KEYCODE_ENTER) { go(text.toString()); true } else false
            }
        }
        val translate = Button(this).apply { text = "Translate"; setOnClickListener { translatePage() } }
        val menu = Button(this).apply { text = "⋮"; setOnClickListener { showMenu(this) } }
        bar.addView(urlBar, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(translate)
        bar.addView(menu)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = View.GONE }

        val stack = FrameLayout(this)
        // The engine view must be attached to a window to run; keep it 1x1 behind the reader.
        engineView = WebView(this)
        stack.addView(engineView, FrameLayout.LayoutParams(1, 1))
        reader = WebView(this)
        stack.addView(reader, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)))
        root.addView(stack, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        engine = EngineClient(engineView)
        bridge = ReaderBridge(reader, engine, prefs)
        setupReader()
        CookieManager.getInstance().setAcceptThirdPartyCookies(reader, true)

        val start = intentUrl(intent) ?: prefs.getString("lastUrl", null)
        if (start != null) go(start) else showWelcome()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupReader() {
        val assets = AssetServer.loader(this, isolated = false, cors = true)
        reader.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            mediaPlaybackRequiresUserGesture = true
        }
        bridge.userAgent = reader.settings.userAgentString
        reader.addJavascriptInterface(bridge, "DalbitNative")
        reader.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.host == "appassets.androidplatform.net") assets.shouldInterceptRequest(request.url) else null

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                injected = false
                if (!url.startsWith("data:")) { urlBar.setText(url); prefs.edit().putString("lastUrl", url).apply() }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (prefs.getBoolean("autoTranslate", false) && url.startsWith("http")) translatePage()
            }
        }
        reader.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, p: Int) {
                progress.progress = p
                progress.visibility = if (p in 1..99) View.VISIBLE else View.GONE
            }
        }
    }

    private fun showWelcome() {
        val html = """
            <html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:20px;background:#16161d;color:#eee">
            <h2 style="color:#f5c542">Dalbit</h2>
            <p>Open a manhwa chapter: type or paste its address above, or share a page to Dalbit from another browser.</p>
            <p>Then tap <b>Translate</b>. The first time, the on-phone engine loads its models (a few seconds).</p>
            <p>Menu ⋮ → <b>Settings</b> to switch to your laptop's Dalbit service, set text size or a glossary.</p>
            </body></html>""".trimIndent()
        reader.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    private fun go(input: String) {
        val t = input.trim()
        if (t.isEmpty()) return
        val url = if (t.startsWith("http://") || t.startsWith("https://")) t else "https://$t"
        reader.loadUrl(url)
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(urlBar.windowToken, 0)
        reader.requestFocus()
    }

    private fun asset(path: String) = assets.open(path).bufferedReader().use { it.readText() }

    /** Inject the shim + content script (once per page) and start translating. */
    private fun translatePage() {
        if (!injected) {
            val code = "window.__dalbitAssetBase=${JSONObject.quote(AssetServer.BASE)};\n" + asset("www/shim.js") + "\n" + asset("www/content.js")
            reader.evaluateJavascript(code, null)
            injected = true
        }
        command("start")
    }

    private fun command(type: String) =
        reader.evaluateJavascript("window.__dalbitBridge && __dalbitBridge.command({type:${JSONObject.quote(type)}})", null)

    private fun showMenu(anchor: View) {
        val pm = PopupMenu(this, anchor)
        pm.menu.add(0, 1, 0, "Show original / translation")
        pm.menu.add(0, 2, 1, "Scan page (load lazy images)")
        pm.menu.add(0, 3, 2, "Retry failed images")
        pm.menu.add(0, 4, 3, if (prefs.getBoolean("autoTranslate", false)) "Auto-translate pages: ON" else "Auto-translate pages: OFF")
        pm.menu.add(0, 5, 4, "Settings")
        pm.menu.add(0, 6, 5, "Reload page")
        pm.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> if (injected) command("toggle")
                2 -> if (injected) command("scan") else { translatePage(); command("scan") }
                3 -> if (injected) command("retry-failed")
                4 -> prefs.edit().putBoolean("autoTranslate", !prefs.getBoolean("autoTranslate", false)).apply()
                5 -> showSettings()
                6 -> reader.reload()
            }
            true
        }
        pm.show()
    }

    // ---------------------------------------------------------------- settings
    private fun showSettings() {
        val s = bridge.settings()
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(8)) }
        fun label(t: String) = TextView(this).apply { text = t; setPadding(0, dp(12), 0, dp(2)) }

        box.addView(label("Engine"))
        val engines = RadioGroup(this)
        val onPhone = RadioButton(this).apply { text = "On this phone (no computer needed)"; id = View.generateViewId() }
        val service = RadioButton(this).apply { text = "My Dalbit service (laptop / server)"; id = View.generateViewId() }
        engines.addView(onPhone); engines.addView(service)
        engines.check(if (s.optString("engine") == "service") service.id else onPhone.id)
        box.addView(engines)

        box.addView(label("Service address (e.g. http://100.101.102.103:47615)"))
        val url = EditText(this).apply { setSingleLine(); setText(s.optString("serviceUrl", "http://127.0.0.1:47615")); inputType = InputType.TYPE_TEXT_VARIATION_URI }
        box.addView(url)
        box.addView(label("Pairing token (python -m dalbit token)"))
        val token = EditText(this).apply { setSingleLine(); setText(bridge.serviceToken); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        box.addView(token)

        val scale0 = s.optDouble("textScale", 1.0)
        val scaleLabel = label("Text size: ${(scale0 * 100).toInt()}%")
        box.addView(scaleLabel)
        val scale = SeekBar(this).apply {
            max = 80; progress = ((scale0 - 0.7) * 100).toInt().coerceIn(0, 80)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar, p: Int, fromUser: Boolean) { scaleLabel.text = "Text size: ${70 + p}%" }
                override fun onStartTrackingTouch(sb: SeekBar) {}
                override fun onStopTrackingTouch(sb: SeekBar) {}
            })
        }
        box.addView(scale)

        box.addView(label("Sound effects"))
        val sfxValues = listOf("annotate", "original", "replace")
        val sfx = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item,
                listOf("Preserve + annotate", "Original only", "Replace (experimental, annotates for now)"))
            setSelection(sfxValues.indexOf(s.optString("sfxMode", "annotate")).coerceAtLeast(0))
        }
        box.addView(sfx)

        box.addView(label("Glossary (one per line: 민준 = Minjun)"))
        val g = s.optJSONObject("glossary") ?: JSONObject()
        val glossary = EditText(this).apply {
            minLines = 3
            gravity = Gravity.TOP
            setText(g.keys().asSequence().joinToString("\n") { "$it = ${g.getString(it)}" })
        }
        box.addView(glossary)

        AlertDialog.Builder(this)
            .setTitle("Dalbit settings")
            .setView(ScrollView(this).apply { addView(box) })
            .setPositiveButton("Save") { _, _ ->
                val gl = JSONObject()
                glossary.text.toString().lines().forEach { line ->
                    val m = Regex("^(.+?)\\s*(?:=|→|->|\\t)\\s*(.+)$").find(line.trim())
                    if (m != null && !line.trim().startsWith("#")) gl.put(m.groupValues[1].trim(), m.groupValues[2].trim())
                }
                bridge.serviceToken = token.text.toString().trim()
                bridge.updateSettings(JSONObject()
                    .put("engine", if (engines.checkedRadioButtonId == service.id) "service" else "builtin")
                    .put("serviceUrl", url.text.toString().trim().trimEnd('/'))
                    .put("textScale", (70 + scale.progress) / 100.0)
                    .put("sfxMode", sfxValues[sfx.selectedItemPosition])
                    .put("glossary", gl))
                Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ---------------------------------------------------------------- intents / navigation
    private fun intentUrl(i: Intent?): String? = when (i?.action) {
        Intent.ACTION_VIEW -> i.dataString
        Intent.ACTION_SEND -> i.getStringExtra(Intent.EXTRA_TEXT)?.let { Regex("https?://\\S+").find(it)?.value }
        else -> null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intentUrl(intent)?.let(::go)
    }

    @Deprecated("Back navigation for the in-app browser")
    override fun onBackPressed() {
        if (reader.canGoBack()) reader.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
