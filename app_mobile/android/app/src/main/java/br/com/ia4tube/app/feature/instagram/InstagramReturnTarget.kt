package br.com.ia4tube.app.feature.instagram

import android.content.Intent
import java.util.UUID

/** Navigation hint only. The current app session and normal authenticated GETs remain authoritative. */
data class InstagramReturnTarget(val nonce: String)

internal const val INSTAGRAM_RETURN_URI = "ia4tube://instagram/oauth-return"

internal fun parseInstagramReturnTarget(action: String?, uri: String?): InstagramReturnTarget? {
    // Exact wire value: no OAuth code, state, token, account, success flag, query or fragment is accepted.
    if (action != Intent.ACTION_VIEW || uri != INSTAGRAM_RETURN_URI) return null
    return InstagramReturnTarget(UUID.randomUUID().toString())
}

fun Intent?.toInstagramReturnTarget(): InstagramReturnTarget? =
    this?.let { parseInstagramReturnTarget(it.action, it.dataString) }
