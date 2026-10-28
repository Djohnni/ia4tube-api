package br.com.ia4tube.app.feature.edit

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.net.Uri
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel

private val imageTypes = arrayOf("image/png", "image/jpeg", "image/webp")

internal class EditBrowserViewModel : ViewModel() {
    var view: WebView? = null
        private set
    private var contextWrapper: MutableContextWrapper? = null
    private var activeBinding: Any? = null
    var fileCallback: ValueCallback<Array<Uri>>? = null
    var multiple = false
    var loading by mutableStateOf(true)
    var loadFailed by mutableStateOf(false)

    fun attach(context: Context, binding: Any): Pair<WebView, Boolean> {
        activeBinding = binding
        val existing = view
        if (existing != null) {
            contextWrapper?.baseContext = context
            (existing.parent as? ViewGroup)?.removeView(existing)
            return existing to false
        }
        val wrapper = MutableContextWrapper(context)
        contextWrapper = wrapper
        return WebView(wrapper).also { view = it } to true
    }

    fun isAttached(binding: Any): Boolean = activeBinding === binding

    fun detach(binding: Any) {
        if (!isAttached(binding)) return
        pause()
        activeBinding = null
        // Release clients that captured the old Activity/Compose launcher while
        // retaining the actual document, file callback and form during rotation.
        view?.webChromeClient = null
        view?.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !request.isForMainFrame || !EditNavigationPolicy.isWebsite(request.url.toString())
            override fun onPageFinished(view: WebView, url: String?) { loading = false }
        }
        contextWrapper?.let { it.baseContext = it.baseContext.applicationContext }
    }

    fun finishFiles(uris: Array<Uri>?) {
        val callback = fileCallback
        fileCallback = null
        callback?.onReceiveValue(uris)
    }

    fun pause() {
        view?.apply {
            // onPause alone does not guarantee HTML media stops on every WebView.
            if (EditNavigationPolicy.isEditPage(url)) {
                evaluateJavascript("document.querySelectorAll('video').forEach(function(v){v.pause();});", null)
            }
            onPause()
        }
    }

    fun resume() {
        view?.apply {
            onResume()
            // The existing feed restores its active item and the visitor's sound
            // preference. No reload, history change, form reset or injected bridge.
            if (EditNavigationPolicy.isEditPage(url)) {
                evaluateJavascript("document.dispatchEvent(new Event('visibilitychange'));", null)
            }
        }
    }

    override fun onCleared() {
        finishFiles(null)
        contextWrapper?.let { it.baseContext = it.baseContext.applicationContext }
        view?.apply {
            (parent as? ViewGroup)?.removeView(this)
            stopLoading()
            onPause()
            webChromeClient = null
            webViewClient = WebViewClient()
            removeAllViews()
            destroy()
        }
        view = null
        contextWrapper = null
        activeBinding = null
    }
}

@Composable
fun EditScreen(onBackClick: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val onBack by rememberUpdatedState(onBackClick)
    // The destination's ViewModelStore survives Activity recreation. It is
    // cleared when this route is removed, not when the image picker rotates.
    val browser: EditBrowserViewModel = viewModel()
    val binding = remember { Any() }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val selected = if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val uris = buildList {
                data?.clipData?.let { clip -> for (index in 0 until clip.itemCount) add(clip.getItemAt(index).uri) }
                data?.data?.let(::add)
            }.distinct().filter { uri ->
                uri.scheme == "content" && runCatching { context.contentResolver.getType(uri) in imageTypes }.getOrDefault(false)
            }
            (if (browser.multiple) uris else uris.take(1)).takeIf { it.isNotEmpty() }?.toTypedArray()
        } else null
        browser.finishFiles(selected)
    }

    DisposableEffect(browser, lifecycle, binding) {
        val observer = LifecycleEventObserver { _, event ->
            if (browser.isAttached(binding)) when (event) {
                Lifecycle.Event.ON_RESUME -> browser.resume()
                Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP -> browser.pause()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            browser.detach(binding)
        }
    }

    BackHandler {
        val view = browser.view
        if (view != null && view.canGoBack()) view.goBack() else onBack()
    }

    // The app's outer Scaffold already applies system insets.
    Column(Modifier.fillMaxSize().background(Color.Black)) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { browser.pause(); onBack() }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Voltar", tint = Color.White)
            }
            Text("Vídeos", color = Color.White)
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { viewContext ->
                    val (retainedView, created) = browser.attach(viewContext, binding)
                    retainedView.apply {
                        setBackgroundColor(android.graphics.Color.BLACK)
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.mediaPlaybackRequiresUserGesture = false
                        settings.allowFileAccess = false
                        settings.allowContentAccess = true
                        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                        settings.javaScriptCanOpenWindowsAutomatically = false
                        settings.setSupportMultipleWindows(false)
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                return when (EditNavigationPolicy.decide(request.url.toString(), view.url, request.isForMainFrame, request.hasGesture())) {
                                    EditNavigation.IN_WEBVIEW -> false
                                    EditNavigation.BLOCK -> true
                                    EditNavigation.EXTERNAL -> {
                                        try {
                                            // Retain the complete URL, including the saved order's message.
                                            context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE))
                                        } catch (_: Exception) {
                                            Toast.makeText(context, "Não foi possível abrir. Use o botão Continuar no WhatsApp ou copie a mensagem.", Toast.LENGTH_LONG).show()
                                        }
                                        true
                                    }
                                }
                            }

                            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                                browser.loading = true
                                browser.loadFailed = false
                            }

                            override fun onPageFinished(view: WebView, url: String?) { browser.loading = false }

                            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                                if (request.isForMainFrame) { browser.loading = false; browser.loadFailed = true }
                            }

                            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                                if (request.isForMainFrame && response.statusCode >= 400) { browser.loading = false; browser.loadFailed = true }
                            }
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                                if (!EditNavigationPolicy.isEditPage(view.url) || browser.fileCallback != null ||
                                    params.mode !in listOf(FileChooserParams.MODE_OPEN, FileChooserParams.MODE_OPEN_MULTIPLE)) {
                                    callback.onReceiveValue(null)
                                    return true
                                }
                                browser.fileCallback = callback
                                browser.multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                                    addCategory(Intent.CATEGORY_OPENABLE)
                                    type = "image/*"
                                    putExtra(Intent.EXTRA_MIME_TYPES, imageTypes)
                                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, browser.multiple)
                                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                }
                                try { picker.launch(intent) } catch (_: Exception) {
                                    browser.finishFiles(null)
                                    Toast.makeText(context, "Não foi possível abrir as fotos. Tente novamente.", Toast.LENGTH_LONG).show()
                                }
                                return true
                            }
                        }
                        // Rebind clients above to the current Activity and picker,
                        // but load only when the route's WebView is first created.
                        if (created) loadUrl(EDIT_URL)
                        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) browser.resume()
                    }
                }
            )
            if (browser.loading) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
            if (browser.loadFailed) {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Não foi possível abrir os vídeos.", color = Color.White)
                    Button(onClick = { browser.loadFailed = false; browser.loading = true; browser.view?.reload() }) { Text("Tentar novamente") }
                }
            }
        }
    }
}
