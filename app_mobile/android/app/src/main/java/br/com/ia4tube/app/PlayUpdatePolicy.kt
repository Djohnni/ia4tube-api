package br.com.ia4tube.app

import br.com.ia4tube.app.data.models.AppVersionInfo

internal fun shouldOfferPlayUpdate(
    updateAvailable: Boolean,
    flexibleAllowed: Boolean,
    playVersionCode: Int,
    installedVersionCode: Int,
    dismissedVersionCode: Int
): Boolean = updateAvailable && flexibleAllowed &&
    playVersionCode > installedVersionCode && playVersionCode != dismissedVersionCode

internal fun backendRequiresPlayUpdate(
    info: AppVersionInfo,
    installedVersionCode: Int,
    playAvailableVersionCode: Int,
    failedInAppFlowVersionCode: Int = 0
): Boolean {
    if (playAvailableVersionCode == failedInAppFlowVersionCode) return false
    return (info.minimumVersionCode > installedVersionCode &&
        playAvailableVersionCode >= info.minimumVersionCode) ||
        (info.updateRequired && info.latestVersionCode > installedVersionCode &&
            playAvailableVersionCode >= info.latestVersionCode)
}
