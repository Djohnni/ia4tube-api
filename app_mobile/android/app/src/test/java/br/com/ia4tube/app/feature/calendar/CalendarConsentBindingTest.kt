package br.com.ia4tube.app.feature.calendar

import br.com.ia4tube.app.feature.calendar.imports.ImportOwner
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Synthetic consent/account metadata only; never authorize, publish or access a service. */
internal object CalendarConsentFixtures {
    val current = CalendarBinding("11111111-1111-4111-8111-111111111111", "17841400000000001", 72)
    val previous = current.copy(connectionRevision = 64)
    val other = CalendarBinding("22222222-2222-4222-8222-222222222222", "17841400000000002", 72)
    val owner = ImportOwner("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")

    fun snapshot() = CalendarSnapshot(enabled = true, automatic = true, preferenceRevision = 8,
        connected = true, username = "synthetic_account", operationsAllowed = false,
        identity = owner, preferenceBinding = previous, connectionBinding = current)

    fun binding(value: CalendarBinding = current) = JSONObject()
        .put("connectionId", value.connectionId).put("externalId", value.externalId)
        .put("connectionRevision", value.connectionRevision)

    fun json(preference: Any = binding(previous), connection: Any = binding()) = JSONObject()
        .put("ok", true).put("enabled", true).put("operationsAllowed", false)
        .put("preferences", JSONObject().put("enabled", true).put("revision", 8).put("binding", preference))
        .put("connection", JSONObject().put("username", "synthetic_account")
            .put("accountType", "business").put("binding", connection))
        .put("items", JSONArray()).put("next", JSONObject.NULL)
}

class CalendarConsentBindingTest {
    @Test fun revision64To72PreservesThePreferenceButRequiresExplicitRenewal() {
        val snapshot = parseCalendar(CalendarConsentFixtures.json())
        assertTrue(snapshot.automatic)
        assertTrue(snapshot.connected)
        assertEquals(CalendarConsentFixtures.previous, snapshot.preferenceBinding)
        assertEquals(CalendarConsentFixtures.current, snapshot.connectionBinding)
        assertFalse(snapshot.automaticAuthorized)
        assertTrue(snapshot.requiresConsentRenewal)
        val target = snapshot.automaticConfirmationTarget()!!
        assertEquals(CalendarConsentFixtures.current, target.binding)
        assertEquals(8L, target.preferenceRevision)
        assertEquals("synthetic_account", target.username)
        assertTrue(target.renewal)
    }

    @Test fun onlyEqualValidBindingsAuthorizeAndPublicationAvailabilityDoesNotInventConsent() {
        val snapshot = parseCalendar(CalendarConsentFixtures.json(preference = CalendarConsentFixtures.binding()))
        assertTrue(snapshot.automaticAuthorized)
        assertFalse(snapshot.requiresConsentRenewal)
        assertFalse(snapshot.operationsAllowed)
        assertTrue(snapshot.copy(operationsAllowed = true).automaticAuthorized)
    }

    @Test fun connectionIdExternalIdAndRevisionAreAllPartOfConsent() {
        val current = CalendarConsentFixtures.current
        for (old in listOf(current.copy(connectionId = CalendarConsentFixtures.other.connectionId),
            current.copy(externalId = CalendarConsentFixtures.other.externalId), current.copy(connectionRevision = 64))) {
            val parsed = parseCalendar(CalendarConsentFixtures.json(preference = CalendarConsentFixtures.binding(old)))
            assertFalse("Different binding must not authorize: $old", parsed.automaticAuthorized)
            assertTrue(parsed.requiresConsentRenewal)
        }
    }

    @Test fun pausedPreferencesStayPausedEvenWhenBindingsMatch() {
        val root = CalendarConsentFixtures.json(preference = CalendarConsentFixtures.binding())
        root.getJSONObject("preferences").put("enabled", false)
        val paused = parseCalendar(root)
        assertFalse(paused.automatic)
        assertFalse(paused.automaticAuthorized)
        assertFalse(paused.requiresConsentRenewal)
        assertFalse(paused.automaticConfirmationTarget()!!.renewal)
    }

    @Test fun missingAndNullBindingsNeverBorrowFromTheOtherSide() {
        for (side in listOf("preferences", "connection")) for (missing in listOf(true, false)) {
            val root = CalendarConsentFixtures.json(preference = CalendarConsentFixtures.binding())
            if (missing) root.getJSONObject(side).remove("binding")
            else root.getJSONObject(side).put("binding", JSONObject.NULL)
            val parsed = parseCalendar(root)
            assertTrue(parsed.enabled)
            assertTrue(parsed.automatic)
            assertFalse(parsed.automaticAuthorized)
            assertTrue(parsed.requiresConsentRenewal)
            if (side == "preferences") {
                assertNull(parsed.preferenceBinding)
                assertNotNull(parsed.connectionBinding)
                assertNotNull(parsed.automaticConfirmationTarget())
            } else {
                assertNotNull(parsed.preferenceBinding)
                assertNull(parsed.connectionBinding)
                assertNull(parsed.automaticConfirmationTarget())
            }
        }
    }

    @Test fun malformedBindingsAreUnavailableWithoutDiscardingTheGallerySnapshot() {
        val invalid = listOf<Any>("not-an-object", JSONArray(), true,
            JSONObject(), CalendarConsentFixtures.binding().put("connectionId", "not-a-uuid"),
            CalendarConsentFixtures.binding().put("connectionId", 123),
            CalendarConsentFixtures.binding().put("externalId", ""),
            CalendarConsentFixtures.binding().put("externalId", "account_name"),
            CalendarConsentFixtures.binding().put("externalId", 17841400000000001L),
            CalendarConsentFixtures.binding().put("connectionRevision", 0),
            CalendarConsentFixtures.binding().put("connectionRevision", -1),
            CalendarConsentFixtures.binding().put("connectionRevision", "72"),
            CalendarConsentFixtures.binding().put("connectionRevision", 72.0),
            CalendarConsentFixtures.binding().put("connectionRevision", 72.5),
            CalendarConsentFixtures.binding().put("connectionRevision", true),
            CalendarConsentFixtures.binding().put("connectionRevision", 9_007_199_254_740_992L))
        for (side in listOf("preferences", "connection")) for (binding in invalid) {
            val root = CalendarConsentFixtures.json(preference = CalendarConsentFixtures.binding())
            root.getJSONObject(side).put("binding", binding)
            val parsed = parseCalendar(root)
            assertTrue("The gallery remains available for $side", parsed.enabled)
            assertFalse("Malformed $side must never authorize", parsed.automaticAuthorized)
            if (side == "preferences") assertNull(parsed.preferenceBinding) else assertNull(parsed.connectionBinding)
        }
    }

    @Test fun equalMalformedProgrammaticBindingsCannotAuthorizeEither() {
        for (binding in listOf(CalendarConsentFixtures.current.copy(connectionId = "bad"),
            CalendarConsentFixtures.current.copy(externalId = "bad"), CalendarConsentFixtures.current.copy(connectionRevision = 0))) {
            val snapshot = CalendarConsentFixtures.snapshot().copy(preferenceBinding = binding, connectionBinding = binding)
            assertFalse(snapshot.automaticAuthorized)
            assertTrue(snapshot.requiresConsentRenewal)
            assertNull(snapshot.automaticConfirmationTarget())
        }
    }

    @Test fun disconnectedOrDisabledSnapshotsNeverAuthorizeOrOfferAConfirmationTarget() {
        val equal = CalendarConsentFixtures.snapshot().copy(preferenceBinding = CalendarConsentFixtures.current)
        for (snapshot in listOf(equal.copy(connected = false), equal.copy(enabled = false))) {
            assertFalse(snapshot.automaticAuthorized)
            assertFalse(snapshot.requiresConsentRenewal)
            assertNull(snapshot.automaticConfirmationTarget())
        }
        val root = CalendarConsentFixtures.json().put("connection", JSONObject.NULL)
        assertFalse(parseCalendar(root).automaticAuthorized)
    }

    @Test fun aConfirmationRequiresTheDisplayedAccountAndPositivePreferenceRevision() {
        for (snapshot in listOf(CalendarConsentFixtures.snapshot().copy(username = null),
            CalendarConsentFixtures.snapshot().copy(username = " "),
            CalendarConsentFixtures.snapshot().copy(preferenceRevision = 0))) {
            assertNull(snapshot.automaticConfirmationTarget())
        }
        assertEquals(CalendarConsentFixtures.owner, CalendarConsentFixtures.snapshot().automaticConfirmationTarget()!!.identity)
    }
}
