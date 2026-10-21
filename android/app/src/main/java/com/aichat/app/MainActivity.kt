package com.aichat.app

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var androidHttpBridge: AndroidHttpBridge
    /** 页面里 <input type="file"> 的回调，交给系统选择器后要把结果回填给它 */
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    private class ActiveHttpRequest(
        val cancelled: AtomicBoolean = AtomicBoolean(false),
        @Volatile var connection: HttpURLConnection? = null
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Resize the WebView when the IME opens. Some older Android/HarmonyOS
        // builds ignore the manifest flag unless it is also applied at runtime.
        window.setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        )
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        setContentView(R.layout.activity_main)
        enterFullscreen()

        webView = findViewById(R.id.webview)
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val keyboardBottom = maxOf(0, imeBottom - systemBars.bottom)
            val density = resources.displayMetrics.density
            val keyboardCss = (keyboardBottom / density).toInt()
            val topCss = (systemBars.top / density).toInt()
            val rightCss = (systemBars.right / density).toInt()
            val bottomCss = (systemBars.bottom / density).toInt()
            val leftCss = (systemBars.left / density).toInt()
            view.post {
                (view as? WebView)?.evaluateJavascript(
                    "window.__aiChatAndroidInsets && window.__aiChatAndroidInsets($keyboardCss,$topCss,$rightCss,$bottomCss,$leftCss)",
                    null
                )
            }
            insets
        }
        ViewCompat.requestApplyInsets(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            // 系统文件选择器返回的是 content:// URI，WebView 必须能读它才能把图片
            // 交给页面（「选择背景图片」依赖这条）。页面本身仍是本地 assets。
            allowContentAccess = true
            // The bundled page uses an HTTPS asset origin while LAN sync runs on HTTP.
            // Permit only WebView mixed content so local devices can reach the computer service.
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            // Keep inspection available only in debug builds.
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.KITKAT) {
                val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
                WebView.setWebContentsDebuggingEnabled(debuggable)
            }
        }

        // Use AssetLoader to serve bundled files from assets/www
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): android.webkit.WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return openExternalUrlIfNeeded(request.url)
            }

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                return openExternalUrlIfNeeded(Uri.parse(url))
            }
        }

        // 页面里的 <input type="file">（例如「背景图片 → 选择图片」）在默认
        // WebChromeClient 下点了完全没反应：没人接这个回调，系统选择器也不会弹。
        // 这里把请求转交给系统文件选择器，用户选完再把结果回填给 WebView。
        val fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val callback = pendingFileCallback
            pendingFileCallback = null
            callback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                // 上一次没收尾的回调要先作废，否则 WebView 会一直等它而不再响应
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback
                return try {
                    fileChooserLauncher.launch(fileChooserParams.createIntent())
                    true
                } catch (error: Exception) {
                    pendingFileCallback = null
                    filePathCallback.onReceiveValue(null)
                    false
                }
            }
        }

        webView.addJavascriptInterface(AndroidExportBridge(), "AndroidExport")
        androidHttpBridge = AndroidHttpBridge()
        webView.addJavascriptInterface(androidHttpBridge, "AndroidHttp")

        // Load from bundled assets
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    private inner class AndroidHttpBridge {
        private val executor = Executors.newCachedThreadPool()
        private val activeRequests = ConcurrentHashMap<String, ActiveHttpRequest>()

        @JavascriptInterface
        fun start(requestId: String, requestJson: String) {
            if (requestId.isBlank()) return
            cancel(requestId)
            val active = ActiveHttpRequest()
            activeRequests[requestId] = active
            executor.execute { executeRequest(requestId, requestJson, active) }
        }

        @JavascriptInterface
        fun cancel(requestId: String) {
            cancelRequest(requestId, true)
        }

        fun cancelAll() {
            activeRequests.keys.toList().forEach { cancelRequest(it, true) }
        }

        fun shutdown() {
            activeRequests.keys.toList().forEach { cancelRequest(it, false) }
            executor.shutdownNow()
        }

        private fun cancelRequest(requestId: String, notifyPage: Boolean) {
            activeRequests.remove(requestId)?.let { active ->
                active.cancelled.set(true)
                active.connection?.disconnect()
                if (notifyPage) dispatch("__aiChatNativeHttpCancelled", requestId)
            }
        }

        private fun executeRequest(requestId: String, requestJson: String, active: ActiveHttpRequest) {
            var connection: HttpURLConnection? = null
            try {
                val request = JSONObject(requestJson)
                val url = request.optString("url").trim()
                val method = request.optString("method", "POST").uppercase()
                if (!url.startsWith("https://") && !url.startsWith("http://")) {
                    throw IllegalArgumentException("仅支持绝对 HTTP/HTTPS API 地址")
                }
                if (method != "POST") throw IllegalArgumentException("原生模型请求仅支持 POST")

                connection = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = request.optInt("connectTimeoutMs", 30000).coerceIn(1000, 120000)
                    readTimeout = request.optInt("readTimeoutMs", 120000).coerceIn(1000, 600000)
                    doInput = true
                    doOutput = true
                    useCaches = false
                    instanceFollowRedirects = true
                    setRequestProperty("Accept", "text/event-stream, application/json")
                    setRequestProperty("Accept-Encoding", "identity")
                    val headers = request.optJSONObject("headers")
                    if (headers != null) {
                        val keys = headers.keys()
                        while (keys.hasNext()) {
                            val name = keys.next()
                            val value = headers.optString(name)
                            if (name.isNotBlank() && value.isNotBlank()) setRequestProperty(name, value)
                        }
                    }
                }
                active.connection = connection
                if (active.cancelled.get()) return

                val body = request.optString("body").toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { output ->
                    output.write(body)
                    output.flush()
                }
                if (active.cancelled.get()) return

                val status = connection.responseCode
                val responseHeaders = JSONObject()
                connection.headerFields.forEach { (name, values) ->
                    if (name != null && values != null) responseHeaders.put(name, values.joinToString(", "))
                }
                dispatchStart(requestId, status, responseHeaders.toString())

                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                if (stream == null) {
                    if (status in 200..299) throw IllegalStateException("API 没有返回可读取的流式内容")
                    dispatchError(requestId, "API HTTP $status", status, "")
                    return
                }

                if (status !in 200..299) {
                    val output = ByteArrayOutputStream()
                    stream.use { input ->
                        val buffer = ByteArray(2048)
                        var total = 0
                        while (total < 131072) {
                            val count = input.read(buffer, 0, minOf(buffer.size, 131072 - total))
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            total += count
                        }
                    }
                    if (!active.cancelled.get()) {
                        dispatchError(requestId, "API HTTP $status", status, output.toString(Charsets.UTF_8.name()))
                    }
                    return
                }

                stream.use { input ->
                    val buffer = ByteArray(2048)
                    while (!active.cancelled.get()) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        val chunk = Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)
                        dispatchChunk(requestId, chunk)
                    }
                }
                if (!active.cancelled.get()) dispatchComplete(requestId)
            } catch (error: Exception) {
                if (!active.cancelled.get()) {
                    dispatchError(requestId, error.message ?: "Android 原生网络请求失败", 0, "")
                }
            } finally {
                connection?.disconnect()
                active.connection = null
                activeRequests.remove(requestId, active)
            }
        }

        private fun dispatchStart(requestId: String, status: Int, headersJson: String) {
            dispatch("__aiChatNativeHttpStart", requestId, status.toString(), headersJson)
        }

        private fun dispatchChunk(requestId: String, base64Chunk: String) {
            dispatch("__aiChatNativeHttpChunk", requestId, base64Chunk)
        }

        private fun dispatchComplete(requestId: String) {
            dispatch("__aiChatNativeHttpComplete", requestId)
        }

        private fun dispatchError(requestId: String, message: String, status: Int, responseBody: String) {
            dispatch("__aiChatNativeHttpError", requestId, message, status.toString(), responseBody)
        }

        private fun dispatch(callbackName: String, vararg arguments: String) {
            if (!::webView.isInitialized) return
            val encodedArguments = arguments.joinToString(",") { JSONObject.quote(it) }
            webView.post {
                webView.evaluateJavascript(
                    "window.$callbackName && window.$callbackName($encodedArguments)",
                    null
                )
            }
        }
    }

    private inner class AndroidExportBridge {
        private var fileName = ""
        private var mimeType = "application/octet-stream"
        private var output: OutputStream? = null
        private var uri: android.net.Uri? = null

        @JavascriptInterface
        fun begin(requestedFileName: String, requestedMimeType: String) {
            cancel()
            fileName = requestedFileName.replace(Regex("[\\\\/:*?\"<>|]"), "_")
            mimeType = requestedMimeType.ifBlank { "application/octet-stream" }
            try {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.MIME_TYPE, mimeType)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                }
                uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("无法创建下载文件")
                output = contentResolver.openOutputStream(uri!!)
                    ?: throw IllegalStateException("无法写入下载文件")
            } catch (error: Exception) {
                cancel()
                runOnUiThread { Toast.makeText(this@MainActivity, "导出失败: ${error.message}", Toast.LENGTH_LONG).show() }
            }
        }

        @JavascriptInterface
        fun append(base64Chunk: String) {
            try {
                val stream = output ?: throw IllegalStateException("导出未初始化")
                stream.write(Base64.decode(base64Chunk, Base64.DEFAULT))
            } catch (error: Exception) {
                cancel()
                runOnUiThread { Toast.makeText(this@MainActivity, "导出失败: ${error.message}", Toast.LENGTH_LONG).show() }
            }
        }

        @JavascriptInterface
        fun complete() {
            try {
                output?.close()
                output = null
                uri?.let {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                        contentResolver.update(it, values, null, null)
                    }
                }
                runOnUiThread { Toast.makeText(this@MainActivity, "已保存到下载目录: $fileName", Toast.LENGTH_LONG).show() }
                uri = null
            } catch (error: Exception) {
                cancel()
                runOnUiThread { Toast.makeText(this@MainActivity, "导出失败: ${error.message}", Toast.LENGTH_LONG).show() }
            }
        }

        @JavascriptInterface
        fun cancel() {
            try { output?.close() } catch (_: Exception) { }
            output = null
            uri?.let { contentResolver.delete(it, null, null) }
            uri = null
        }
    }

    private fun openExternalUrlIfNeeded(url: Uri): Boolean {
        if (url.host == "appassets.androidplatform.net") return false
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
            true
        } catch (_: Exception) {
            true
        }
    }

    private fun enterFullscreen() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        )
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.statusBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onPause() {
        if (::webView.isInitialized) {
            webView.evaluateJavascript("window.__aiChatAppPause && window.__aiChatAppPause()", null)
            webView.onPause()
        }
        if (::androidHttpBridge.isInitialized) androidHttpBridge.cancelAll()
        super.onPause()
    }

    override fun onDestroy() {
        if (::androidHttpBridge.isInitialized) androidHttpBridge.shutdown()
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("AndroidHttp")
            webView.destroy()
        }
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.onResume()
            webView.post {
                webView.evaluateJavascript("window.__aiChatAppResume && window.__aiChatAppResume()", null)
                ViewCompat.requestApplyInsets(webView)
            }
        }
        enterFullscreen()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterFullscreen()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // Back button navigates WebView history first
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
