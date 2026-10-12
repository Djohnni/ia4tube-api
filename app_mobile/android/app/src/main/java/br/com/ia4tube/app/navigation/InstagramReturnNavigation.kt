package br.com.ia4tube.app.navigation

import androidx.navigation.NavController

/** Wait for normal startup; a return link must not bypass the existing session check. */
internal fun instagramReturnCanNavigate(currentRoute: String?): Boolean =
    currentRoute != null && currentRoute != Routes.Splash

internal enum class InstagramReturnAction { WAIT, REQUIRE_LOGIN, OPEN_INSTAGRAM }

internal fun instagramReturnAction(currentRoute: String?, hasSavedToken: Boolean): InstagramReturnAction = when {
    !instagramReturnCanNavigate(currentRoute) -> InstagramReturnAction.WAIT
    !hasSavedToken -> InstagramReturnAction.REQUIRE_LOGIN
    else -> InstagramReturnAction.OPEN_INSTAGRAM
}

/** Called only with an authenticated app session, never with identity supplied by the link. */
internal fun NavController.openInstagramFromReturn(): Boolean {
    if (!instagramReturnCanNavigate(currentDestination?.route)) return false
    if (runCatching { getBackStackEntry(Routes.Home) }.getOrNull() == null) {
        // Login can be reached after logout, when its old Home-owned ViewModels were destroyed.
        // Establish a fresh Home owner before Instagram; never resurrect the old account's draft.
        navigate(Routes.Home) {
            popUpTo(graph.id) { inclusive = false }
            launchSingleTop = true
        }
    }
    if (currentDestination?.route == Routes.Instagram) return true
    if (!popBackStack(Routes.Instagram, inclusive = false)) {
        navigate(Routes.Instagram) { launchSingleTop = true }
    }
    return true
}
