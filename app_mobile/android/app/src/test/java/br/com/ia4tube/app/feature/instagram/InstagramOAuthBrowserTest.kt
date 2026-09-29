package br.com.ia4tube.app.feature.instagram

import android.app.Application
import android.content.ActivityNotFoundException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class InstagramOAuthBrowserTest {
    private val context = RuntimeEnvironment.getApplication()
    private val officialUrl = InstagramPoliciesTest.authorizationUrl()

    @Test fun officialOAuthUsesTheSelectedBrowserPackage() {
        var launches = 0
        val opened = InstagramOAuthBrowser.open(context, officialUrl,
            findBrowser = { "com.android.chrome" },
            launch = { _, tab, uri ->
                launches++
                assertEquals("com.android.chrome", tab.intent.`package`)
                assertEquals(officialUrl, uri.toString())
            })
        assertTrue(opened)
        assertEquals(1, launches)
    }

    @Test fun noBrowserDoesNotFallBackToAnInstagramApp() {
        var launches = 0
        val opened = InstagramOAuthBrowser.open(context, officialUrl,
            findBrowser = { null },
            launch = { _, _, _ -> launches++ })
        assertFalse(opened)
        assertEquals(0, launches)
    }

    @Test fun nonOfficialOAuthUrlNeverStartsBrowserResolution() {
        var resolved = false
        val opened = InstagramOAuthBrowser.open(context,
            "https://www.instagram.com/oauth/authorize?state=invalid",
            findBrowser = { resolved = true; "com.android.chrome" },
            launch = { _, _, _ -> fail("Invalid URL must not launch") })
        assertFalse(opened)
        assertFalse(resolved)
    }

    @Test fun missingBrowserActivityFailsClosedWithoutRetry() {
        var launches = 0
        val opened = InstagramOAuthBrowser.open(context, officialUrl,
            findBrowser = { "com.android.chrome" },
            launch = { _, _, _ -> launches++; throw ActivityNotFoundException() })
        assertFalse(opened)
        assertEquals(1, launches)
    }
}
