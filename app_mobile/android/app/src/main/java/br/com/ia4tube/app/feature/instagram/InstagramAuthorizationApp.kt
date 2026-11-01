package br.com.ia4tube.app.feature.instagram

import android.annotation.TargetApi
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build

private const val INSTAGRAM_PACKAGE = "com.instagram.android"
private const val INSTAGRAM_AUTHORIZATION_HOST = "www.instagram.com"
private const val INSTAGRAM_PUBLIC_AUTHORIZATION_PROBE = "https://www.instagram.com/oauth/authorize"

// Package discovery only. No authorization query, state, code or network request is used here.
private fun instagramAppProbe() =
    Intent(Intent.ACTION_VIEW, Uri.parse(INSTAGRAM_PUBLIC_AUTHORIZATION_PROBE))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setPackage(INSTAGRAM_PACKAGE)

private fun ResolveInfo.isEnabledInstagramHandler(): Boolean = activityInfo?.let { activity ->
    activity.packageName == INSTAGRAM_PACKAGE && !activity.name.isNullOrBlank() &&
        activity.enabled && activity.exported && activity.applicationInfo?.let { application ->
            application.packageName == INSTAGRAM_PACKAGE && application.enabled
        } == true
} == true

/** Only the platform verifier's proof for this package and exact host establishes identity. */
internal fun instagramAuthorizationAppDomainVerified(
    packageName: String,
    hostStates: Map<String, Int>
): Boolean = packageName == INSTAGRAM_PACKAGE &&
    hostStates[INSTAGRAM_AUTHORIZATION_HOST] == DomainVerificationUserState.DOMAIN_STATE_VERIFIED

/** Read-only preflight for the separate app experiment; the browser implementation is not used. */
internal fun instagramAuthorizationAppAvailable(context: Context): Boolean {
    // Keep classes added in API 31 behind the guarded adapter. Older devices retain browser login.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    return instagramAuthorizationAppAvailable(context.packageManager) {
        InstagramAppDomainVerificationApi31.isOfficialDomainVerified(context)
    }
}

/** A small policy seam lets synthetic package/domain results be tested without OAuth or HTTP. */
internal fun instagramAuthorizationAppAvailable(
    pm: PackageManager,
    officialDomainVerified: () -> Boolean
): Boolean = try {
    pm.queryIntentActivities(instagramAppProbe(), PackageManager.MATCH_DEFAULT_ONLY)
        .any(ResolveInfo::isEnabledInstagramHandler) && officialDomainVerified()
} catch (_: Exception) {
    false
}

internal fun instagramAuthorizationAppIntent(context: Context, authorizationUrl: String): Intent? {
    if (!InstagramPolicies.isOfficialAuthorizationUrl(authorizationUrl)) return null
    if (!instagramAuthorizationAppAvailable(context)) return null
    return instagramAppIntent(authorizationUrl)
}

internal fun instagramAuthorizationAppIntent(
    pm: PackageManager,
    authorizationUrl: String,
    officialDomainVerified: () -> Boolean
): Intent? {
    if (!InstagramPolicies.isOfficialAuthorizationUrl(authorizationUrl)) return null
    if (!instagramAuthorizationAppAvailable(pm, officialDomainVerified)) return null
    return instagramAppIntent(authorizationUrl)
}

private fun instagramAppIntent(authorizationUrl: String) =
    Intent(Intent.ACTION_VIEW, Uri.parse(authorizationUrl))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setPackage(INSTAGRAM_PACKAGE)

/** Consume once and dispatch only the selected Instagram package. No browser or POST fallback. */
internal fun openInstagramAuthorizationApp(
    context: Context,
    takeUrl: () -> String?,
    launch: (Intent) -> Unit,
    unavailable: () -> Unit
) = dispatchInstagramAuthorizationApp(takeUrl, launch, unavailable) {
    instagramAuthorizationAppIntent(context, it)
}

internal fun openInstagramAuthorizationApp(
    pm: PackageManager,
    officialDomainVerified: () -> Boolean,
    takeUrl: () -> String?,
    launch: (Intent) -> Unit,
    unavailable: () -> Unit
) = dispatchInstagramAuthorizationApp(takeUrl, launch, unavailable) {
    instagramAuthorizationAppIntent(pm, it, officialDomainVerified)
}

private fun dispatchInstagramAuthorizationApp(
    takeUrl: () -> String?,
    launch: (Intent) -> Unit,
    unavailable: () -> Unit,
    intentFor: (String) -> Intent?
) {
    val authorizationUrl = takeUrl() ?: return
    val intent = try { intentFor(authorizationUrl) } catch (_: Exception) { null }
    if (intent == null) {
        unavailable()
        return
    }
    try {
        launch(intent)
    } catch (_: Exception) {
        // Never log the exception/Intent: it may contain OAuth authorization material.
        unavailable()
    }
}

/** Android verifies the domain association with the installed package, including its certificate. */
@TargetApi(Build.VERSION_CODES.S)
private object InstagramAppDomainVerificationApi31 {
    fun isOfficialDomainVerified(context: Context): Boolean {
        val manager = context.getSystemService(DomainVerificationManager::class.java) ?: return false
        val state = manager.getDomainVerificationUserState(INSTAGRAM_PACKAGE) ?: return false
        // User-selected/unverified handlers do not establish ownership of the official domain.
        // The user's link-opening preference is not changed and is not an identity proof.
        return instagramAuthorizationAppDomainVerified(state.packageName, state.hostToStateMap)
    }
}
