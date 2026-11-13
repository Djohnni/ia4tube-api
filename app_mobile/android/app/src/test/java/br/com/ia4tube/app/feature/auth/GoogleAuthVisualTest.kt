package br.com.ia4tube.app.feature.auth

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.repository.AuthRepository
import br.com.ia4tube.app.domain.usecase.LoginUseCase
import br.com.ia4tube.app.domain.usecase.RegisterUseCase
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.*
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.shadows.ShadowChoreographer
import java.io.File
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w384dp-h832dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class GoogleAuthVisualTest {
    private var previousPause = false
    private var previousDelay = Duration.ZERO
    @Before fun pauseFrames() {
        previousPause = ShadowChoreographer.isPaused()
        previousDelay = ShadowChoreographer.getFrameDelay()
        ShadowChoreographer.setPaused(true)
        ShadowChoreographer.setFrameDelay(Duration.ofMillis(16))
    }
    @After fun restoreFrames() {
        Snapshot.sendApplyNotifications()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
        ShadowChoreographer.setPaused(previousPause)
        ShadowChoreographer.setFrameDelay(previousDelay)
    }
    @Test fun registrationAndLoginBothShowGoogleAndKeepTheExistingPasswordFields() {
        for (register in listOf(true, false)) {
            val controller = Robolectric.buildActivity(ComponentActivity::class.java)
            val activity = controller.get()
            activity.setTheme(android.R.style.Theme_Material_NoActionBar)
            controller.setup()
            val repository = AuthRepository(IA4TubeApiClient(), SessionStore(activity))
            var navigationCalls = 0
            try {
                activity.setContent { IA4TubeTheme {
                    if (register) RegisterScreen(RegisterViewModel(RegisterUseCase(repository)),
                        { navigationCalls++ }, { navigationCalls++ }, repository)
                    else LoginScreen(LoginViewModel(LoginUseCase(repository)), { navigationCalls++ }, repository)
                } }
                settle(activity)
                val nodes = nodes(activity.window.decorView)
                val google = nodes.single { it.config.getOrNull(SemanticsProperties.TestTag) == "auth_google" }
                assertTrue(google.size.width > 0 && google.size.height > 0)
                assertTrue(nodes.any { it.config.getOrNull(SemanticsProperties.Text)?.any { text -> text.text == "Continuar com Google" } == true })
                assertEquals(if (register) 3 else 2, nodes.count { it.config.contains(SemanticsActions.SetText) })
                assertEquals("", repository.getSavedToken())
                assertEquals(0, navigationCalls)
                capture(activity, if (register) "google109-cadastro.png" else "google109-login.png")
            } finally {
                controller.pause().stop().destroy()
                Snapshot.sendApplyNotifications()
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
            }
        }
    }

    @Test fun googleButtonRequiresAnExplicitTapBeforeItStartsAuthentication() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        val activity = controller.get()
        activity.setTheme(android.R.style.Theme_Material_NoActionBar)
        controller.setup()
        var clicks = 0
        try {
            activity.setContent { IA4TubeTheme { Box(Modifier.fillMaxSize()) {
                GoogleSignInButton(false, false, null) { clicks++ }
            } } }
            settle(activity)
            fun button() = nodes(activity.window.decorView).single { it.config.getOrNull(SemanticsProperties.TestTag) == "auth_google" }
            assertEquals(0, clicks)
            assertFalse(button().config.contains(SemanticsProperties.Disabled))
            assertTrue(button().config[SemanticsActions.OnClick].action!!.invoke())
            assertEquals(1, clicks)
        } finally {
            controller.pause().stop().destroy()
            Snapshot.sendApplyNotifications()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
        }
    }

    private fun settle(activity: ComponentActivity) {
        val root = activity.window.decorView
        Snapshot.sendApplyNotifications()
        val bitmap = Bitmap.createBitmap(768, 1664, Bitmap.Config.ARGB_8888)
        try { repeat(8) {
            ShadowSystemClock.advanceBy(Duration.ofMillis(64))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
            root.requestLayout()
            root.measure(View.MeasureSpec.makeMeasureSpec(768, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(1664, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, 768, 1664)
            fun measure(view: View) {
                if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                    view.javaClass.getMethod("measureAndLayoutForTest").invoke(view)
                if (view is ViewGroup) (0 until view.childCount).forEach { measure(view.getChildAt(it)) }
            }
            measure(root)
            root.draw(Canvas(bitmap))
            Snapshot.sendApplyNotifications()
        } } finally { bitmap.recycle() }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
    }
    private fun nodes(view: View): List<SemanticsNode> {
        val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView") {
            val owner = view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner
            val getter = owner.javaClass.methods.first { it.name.startsWith("getUnmergedRootSemanticsNode") && it.parameterCount == 0 }
            fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
            descendants(getter.invoke(owner) as SemanticsNode)
        } else emptyList()
        return own + if (view is ViewGroup) (0 until view.childCount).flatMap { nodes(view.getChildAt(it)) } else emptyList()
    }
    private fun capture(activity: ComponentActivity, name: String) {
        val image = Bitmap.createBitmap(768, 1664, Bitmap.Config.ARGB_8888)
        try {
            activity.window.decorView.draw(Canvas(image))
            File("build/reports/$name").apply { parentFile.mkdirs() }.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { image.recycle() }
    }
}
