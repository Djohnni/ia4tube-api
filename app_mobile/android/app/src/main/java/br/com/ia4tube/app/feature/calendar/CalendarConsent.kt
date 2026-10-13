package br.com.ia4tube.app.feature.calendar

import br.com.ia4tube.app.feature.calendar.imports.ImportOwner
import org.json.JSONObject

/** The server binds consent to this exact account AND connection revision. */
data class CalendarBinding(val connectionId: String, val externalId: String, val connectionRevision: Long) {
    val valid: Boolean get() = connectionId.matches(Regex(
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
    )) && externalId.matches(Regex("[0-9]{5,64}")) && connectionRevision in 1..9_007_199_254_740_991L
}

internal fun parseCalendarBinding(value: JSONObject?): CalendarBinding? {
    value ?: return null
    val connectionId = value.opt("connectionId") as? String ?: return null
    val externalId = value.opt("externalId") as? String ?: return null
    // Do not coerce strings, fractions, missing values or booleans into an approval.
    val revision = when (val raw = value.opt("connectionRevision")) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> return null
    }
    return CalendarBinding(connectionId, externalId, revision).takeIf { it.valid }
}

/** Capture what the person actually saw; a later account/revision cannot reuse this confirmation. */
data class CalendarAutomaticConfirmation(
    val binding: CalendarBinding,
    val preferenceRevision: Long,
    val username: String,
    val identity: ImportOwner?,
    val renewal: Boolean
)

fun CalendarSnapshot.automaticConfirmationTarget(): CalendarAutomaticConfirmation? {
    if (!enabled || !connected || preferenceRevision <= 0) return null
    val binding = connectionBinding?.takeIf { it.valid } ?: return null
    val account = username?.takeIf { it.isNotBlank() } ?: return null
    return CalendarAutomaticConfirmation(binding, preferenceRevision, account, identity, requiresConsentRenewal)
}
