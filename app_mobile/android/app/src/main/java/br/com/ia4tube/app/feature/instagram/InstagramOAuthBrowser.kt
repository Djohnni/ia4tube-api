package br.com.ia4tube.app.feature.instagram

import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent

/** Open OAuth in a browser, never through an Instagram app's generic HTTPS handler. */
internal object InstagramOAuthBrowser {
    fun open(context: Context, url: String): Boolean = open(
        context, url,
        findBrowser = { CustomTabsClient.getPackageName(it, null) },
        launch = { appContext, tab, uri -> tab.launchUrl(appContext, uri) }
    )

    internal fun open(
        context: Context,
        url: String,
        findBrowser: (Context) -> String?,
        launch: (Context, CustomTabsIntent, Uri) -> Unit
    ): Boolean {
        if (!InstagramPolicies.isOfficialAuthorizationUrl(url)) return false
        return try {
            val tab = preparedTab(findBrowser(context)) ?: return false
            launch(context, tab, Uri.parse(url))
            true
        } catch (_: ActivityNotFoundException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }

    internal fun preparedTab(packageName: String?): CustomTabsIntent? =
        packageName?.takeIf { it.isNotBlank() }?.let { browser ->
            CustomTabsIntent.Builder().build().apply {
                intent.setPackage(browser)
            }
        }
}
