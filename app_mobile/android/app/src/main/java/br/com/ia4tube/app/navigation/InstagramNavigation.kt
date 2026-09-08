package br.com.ia4tube.app.navigation

import androidx.lifecycle.ViewModelStoreOwner
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import br.com.ia4tube.app.feature.instagram.InstagramViewModel

/** Memory-only lifetime: Home survives ordinary back navigation and is removed on logout. */
internal fun NavController.instagramViewModelOwner(): ViewModelStoreOwner =
    getBackStackEntry(Routes.Home)

/** A duplicate/stale Back event cannot pop Home or revoke the newly opened Instagram entry. */
internal fun NavController.leaveInstagram(entry: NavBackStackEntry, model: InstagramViewModel): Boolean {
    if (entry.destination.route != Routes.Instagram || currentBackStackEntry !== entry) return false
    model.onRouteExit()
    return popBackStack()
}
