package br.com.ia4tube.app.feature.edit

import android.app.Activity
import android.app.Application
import android.content.MutableContextWrapper
import android.net.Uri
import android.webkit.ValueCallback
import android.widget.FrameLayout
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/** Run with ia4tubeLocalIsolatedTests: no app manifest/providers, network or device. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class EditBrowserRetentionTest {
    @Test fun activityReplacementKeepsWebViewAndPendingPhotoWithoutKeepingOldContext() {
        assertNull(javaClass.classLoader!!.getResource("com/android/tools/test_config.properties"))
        val first = Robolectric.buildActivity(Activity::class.java).setup()
        val second = Robolectric.buildActivity(Activity::class.java).setup()
        val store = ViewModelStore()
        val browser = EditBrowserViewModel()
        store.put("edit", browser)
        try {
            val oldBinding = Any()
            val (view, created) = browser.attach(first.get(), oldBinding)
            assertTrue(created)
            val parent = FrameLayout(first.get()).also { it.addView(view) }
            browser.loading = false
            browser.loadFailed = true
            var replies = 0
            var selected: Array<Uri>? = null
            browser.fileCallback = ValueCallback { replies++; selected = it }
            browser.multiple = true

            browser.detach(oldBinding)
            assertEquals(0, replies)
            assertNotNull(browser.fileCallback)
            assertSame(first.get().applicationContext, (view.context as MutableContextWrapper).baseContext)

            val newBinding = Any()
            val (retained, createdAgain) = browser.attach(second.get(), newBinding)
            assertSame(view, retained)
            assertFalse(createdAgain)
            assertEquals(0, parent.childCount)
            assertSame(second.get(), (view.context as MutableContextWrapper).baseContext)
            assertFalse(browser.loading)
            assertTrue(browser.loadFailed)
            assertTrue(browser.multiple)
            // An old composition disposing late cannot detach the new Activity.
            browser.detach(oldBinding)
            assertTrue(browser.isAttached(newBinding))
            assertSame(second.get(), (view.context as MutableContextWrapper).baseContext)
            val image = Uri.parse("content://documents/picture.png")
            browser.finishFiles(arrayOf(image))
            assertEquals(1, replies)
            assertArrayEquals(arrayOf(image), selected)
            assertNull(browser.fileCallback)
        } finally {
            store.clear()
            first.pause().stop().destroy()
            second.pause().stop().destroy()
        }
    }

    @Test fun leavingRouteCancelsPickerAndReleasesBrowser() {
        assertNull(javaClass.classLoader!!.getResource("com/android/tools/test_config.properties"))
        val activity = Robolectric.buildActivity(Activity::class.java).setup()
        val store = ViewModelStore()
        val browser = EditBrowserViewModel()
        store.put("edit", browser)
        try {
            val (view, _) = browser.attach(activity.get(), Any())
            var replies = 0
            browser.fileCallback = ValueCallback { assertNull(it); replies++ }
            store.clear()
            assertEquals(1, replies)
            assertNull(browser.view)
            assertNull(browser.fileCallback)
            assertSame(activity.get().applicationContext, (view.context as MutableContextWrapper).baseContext)
        } finally {
            store.clear()
            activity.pause().stop().destroy()
        }
    }
}
