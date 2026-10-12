package br.com.ia4tube.app.feature.instagram

import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri

internal data class InstagramAuthorizationBrowser(val packageName: String, val label: String)

internal data class InstagramAuthorizationBrowsers(
    val choices: List<InstagramAuthorizationBrowser>,
    val preferred: InstagramAuthorizationBrowser?
)

// Used only for package resolution, never opened or sent over the network.
private fun browserProbe() = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/"))
    .addCategory(Intent.CATEGORY_BROWSABLE)

private fun browserSelector() =
    Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_BROWSER)

private fun ResolveInfo.launchablePackage(): String? = activityInfo?.takeIf {
    it.enabled && it.exported && it.applicationInfo?.enabled == true
}?.packageName?.takeIf(String::isNotBlank)

private fun PackageManager.canOpenHttps(packageName: String): Boolean =
    queryIntentActivities(browserProbe().setPackage(packageName), PackageManager.MATCH_DEFAULT_ONLY)
        .any { it.launchablePackage() == packageName }

/** Discover browser apps, not handlers of the Instagram link (which can be native Instagram). */
internal fun instagramAuthorizationBrowsers(pm: PackageManager): InstagramAuthorizationBrowsers {
    val browsers = pm.queryIntentActivities(browserSelector(), 0)
        .mapNotNull { resolved ->
            val packageName = resolved.launchablePackage() ?: return@mapNotNull null
            if (!pm.canOpenHttps(packageName)) return@mapNotNull null
            InstagramAuthorizationBrowser(packageName,
                resolved.loadLabel(pm)?.toString()?.takeIf(String::isNotBlank) ?: packageName)
        }
        .distinctBy { it.packageName }
        .sortedWith(compareBy({ it.label.lowercase() }, { it.packageName }))
    // A resolver/chooser result is never itself a browser unless it was a real candidate.
    val webDefault = pm.resolveActivity(browserProbe(), PackageManager.MATCH_DEFAULT_ONLY)
        ?.launchablePackage()
    val browserDefault = pm.resolveActivity(browserSelector(), 0)?.launchablePackage()
    val preferred = browsers.firstOrNull { it.packageName == webDefault }
        ?: browsers.firstOrNull { it.packageName == browserDefault }
        ?: browsers.singleOrNull()
    return InstagramAuthorizationBrowsers(browsers, preferred)
}

/** Revalidate immediately before dispatch and keep the original URL byte-for-byte. */
internal fun instagramAuthorizationBrowserIntent(
    pm: PackageManager, authorizationUrl: String, packageName: String
): Intent? {
    if (!InstagramPolicies.isOfficialAuthorizationUrl(authorizationUrl)) return null
    if (instagramAuthorizationBrowsers(pm).choices.none { it.packageName == packageName }) return null
    // Do not launch the MAIN/APP_BROWSER selector: it can open only the browser home page.
    return Intent(Intent.ACTION_VIEW, Uri.parse(authorizationUrl))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setPackage(packageName)
}

/** Consume once even on failure. Never retry a POST or fall back to an unqualified web intent. */
internal fun openInstagramAuthorizationBrowser(
    pm: PackageManager,
    packageName: String,
    takeUrl: () -> String?,
    launch: (Intent) -> Unit,
    unavailable: () -> Unit
) {
    val url = takeUrl() ?: return
    try {
        val intent = instagramAuthorizationBrowserIntent(pm, url, packageName)
        if (intent == null) unavailable() else launch(intent)
    } catch (_: Exception) {
        // Do not log an exception/intent: it may contain OAuth authorization material.
        unavailable()
    }
}
