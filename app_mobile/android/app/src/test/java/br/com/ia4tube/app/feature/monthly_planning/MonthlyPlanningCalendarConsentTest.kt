package br.com.ia4tube.app.feature.monthly_planning

import android.app.Application
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.core.company.CompanyProfileStore
import br.com.ia4tube.app.core.monthly_planning.MonthlyPlanningCalendarCacheStore
import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.repository.AuthRepository
import br.com.ia4tube.app.feature.calendar.CalendarConsentFixtures
import br.com.ia4tube.app.feature.calendar.CalendarUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** All HTTP responses are intercepted in-process; the real application and token vault never start. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28],
    shadows = [MonthlyPlanningCalendarConsentTest.SyntheticSessionStore::class],
    instrumentedPackages = ["br.com.ia4tube.app.core.session"])
class MonthlyPlanningCalendarConsentTest {
    @Before fun before() {
        Dispatchers.setMain(Dispatchers.Unconfined)
        assertEquals(Application::class.java, RuntimeEnvironment.getApplication().javaClass)
    }
    @After fun after() { Dispatchers.resetMain() }

    @Implements(value = SessionStore::class, isInAndroidSdk = false)
    class SyntheticSessionStore {
        @Implementation fun getToken(): String = "synthetic-calendar-consent-test"
    }

    private class Host : AutoCloseable {
        val posts = AtomicInteger()
        val reads = AtomicInteger()
        val bodies = ConcurrentLinkedQueue<Map<String, String>>()
        @Volatile var responseStatus = 409
        @Volatile var responseCode = "calendar_consent_changed"
        @Volatile var timeout = false
        @Volatile var responseGate: CountDownLatch? = null
        private val client = OkHttpClient.Builder()
            .dns(object : okhttp3.Dns {
                override fun lookup(hostname: String): List<java.net.InetAddress> =
                    throw AssertionError("A synthetic consent test must never reach DNS or a server")
            })
            .addInterceptor { chain ->
                val request = chain.request()
                // Never call chain.proceed: even unexpected requests cannot leave this process.
                val response = when {
                    request.method == "GET" && request.url.encodedPath == "/me" -> {
                        reads.incrementAndGet()
                        200 to "{\"ok\":true,\"artes_mensais_total\":4,\"artes_mensais_restantes\":4}"
                    }
                    request.method == "GET" && request.url.encodedPath == "/empresa/planejamento-mensal" -> {
                        reads.incrementAndGet()
                        200 to "{\"ok\":true,\"planejamentos\":[]}"
                    }
                    request.method == "POST" && request.url.encodedPath == "/empresa/planejamento-mensal/solicitar" -> {
                        posts.incrementAndGet()
                        bodies += (request.body as MultipartBody).parts.associate { part ->
                            val name = part.headers!!["Content-Disposition"]!!.substringAfter("name=\"").substringBefore('"')
                            val buffer = Buffer(); part.body.writeTo(buffer)
                            name to buffer.readUtf8()
                        }
                        responseGate?.let { check(it.await(5, TimeUnit.SECONDS)) { "Synthetic response not released" } }
                        if (timeout) throw SocketTimeoutException("Synthetic timeout")
                        responseStatus to JSONObject().put("ok", false).put("code", responseCode)
                            .put("error", "Synthetic request rejected").toString()
                    }
                    else -> throw AssertionError("Unexpected synthetic request: ${request.method} ${request.url.encodedPath}")
                }
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(response.first)
                    .message("Synthetic").header("Content-Type", "application/json")
                    .body(response.second.toResponseBody("application/json".toMediaType())).build()
            }.build()
        private val application = RuntimeEnvironment.getApplication()
        private val profileStore = CompanyProfileStore(application).also {
            it.saveProfile(CompanyProfile(nomeEmpresa = "Empresa sintética", ramo = "Hortaliças",
                instagram = "synthetic_account"))
        }
        val model = MonthlyPlanningViewModel(
            AuthRepository(IA4TubeApiClient(client), SessionStore(application)),
            profileStore, MonthlyPlanningCalendarCacheStore(application))

        suspend fun ready() {
            withTimeout(5_000) { model.uiState.first { !it.loading } }
            assertEquals(2, reads.get())
            val slot = model.uiState.value.photos.first().id
            model.updatePhotoManualObjective(slot, "Divulgar produto sintético")
            model.updatePhotoText(slot, "Texto preservado")
        }

        suspend fun settled() { withTimeout(5_000) { model.uiState.first { !it.loading } } }
        override fun close() {
            responseGate?.countDown()
            model.viewModelScope.cancel()
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
        }
    }

    private fun authorized() = CalendarUiState(CalendarConsentFixtures.snapshot()
        .copy(preferenceBinding = CalendarConsentFixtures.current, preferenceRevision = 9), fresh = true)

    @Test fun staleBindingAndUnavailableCalendarCannotSubmitOrDiscardTheDraft() = runBlocking {
        Host().use { host ->
            host.ready()
            val before = host.model.uiState.value
            val states = listOf(CalendarUiState(CalendarConsentFixtures.snapshot(), fresh = true),
                authorized().copy(fresh = false), authorized().copy(busy = true))
            for (calendar in states) {
                host.model.confirmPlanning(calendar)
                host.settled()
                assertEquals(0, host.posts.get())
                assertEquals(before.photos, host.model.uiState.value.photos)
                assertEquals(before.companyProfile, host.model.uiState.value.companyProfile)
                assertNotNull(host.model.uiState.value.uploadError)
            }
        }
    }

    @Test fun equalCurrentBindingSubmitsTheCurrentRevisionOnlyOnceForRapidClicks() = runBlocking {
        Host().use { host ->
            host.ready()
            host.responseGate = CountDownLatch(1)
            host.model.confirmPlanning(authorized())
            host.model.confirmPlanning(authorized())
            host.responseGate!!.countDown()
            host.settled()
            assertEquals(1, host.posts.get())
            assertEquals("true", host.bodies.single()["calendar_automatic"])
            assertEquals("9", host.bodies.single()["calendar_preference_revision"])
            assertEquals(2, host.reads.get())
        }
    }

    @Test fun remoteConsentConflictKeepsDraftAndNotifiesOnceWithoutResubmission() = runBlocking {
        Host().use { host ->
            host.ready()
            val before = host.model.uiState.value
            val notifications = AtomicInteger()
            host.model.confirmPlanning(authorized(), onCalendarConsentChanged = { notifications.incrementAndGet() })
            host.settled()
            // The callback follows the published state in the same coroutine.
            withTimeout(5_000) { while (notifications.get() == 0) kotlinx.coroutines.yield() }
            assertEquals(1, notifications.get())
            assertEquals(1, host.posts.get())
            assertEquals(2, host.reads.get())
            assertEquals(before.photos, host.model.uiState.value.photos)
            assertEquals(before.companyProfile, host.model.uiState.value.companyProfile)
            assertEquals(MonthlyPlanningStep.Confirmation, host.model.uiState.value.step)
            assertEquals(MONTHLY_PLANNING_CALENDAR_CONSENT_MESSAGE, host.model.uiState.value.uploadError)
            assertFalse(host.model.uiState.value.billingRequired)
        }
    }

    @Test fun timeoutIsNotRetriedAndDoesNotEraseTheFilledRequest() = runBlocking {
        Host().use { host ->
            host.ready(); host.timeout = true
            val before = host.model.uiState.value
            var notifications = 0
            host.model.confirmPlanning(authorized(), onCalendarConsentChanged = { notifications++ })
            host.settled()
            assertEquals(1, host.posts.get())
            assertEquals(0, notifications)
            assertEquals(before.photos, host.model.uiState.value.photos)
            assertEquals(before.companyProfile, host.model.uiState.value.companyProfile)
            assertEquals(MonthlyPlanningStep.Confirmation, host.model.uiState.value.step)
            assertNotNull(host.model.uiState.value.uploadError)
        }
    }

    @Test fun pausedPreferenceNeverBecomesAutomaticWhenSubmittingAManualRequest() = runBlocking {
        Host().use { host ->
            host.ready()
            val paused = authorized().copy(data = authorized().data.copy(automatic = false))
            host.model.confirmPlanning(paused); host.settled()
            assertEquals(1, host.posts.get())
            assertEquals("false", host.bodies.single()["calendar_automatic"])
            assertEquals("9", host.bodies.single()["calendar_preference_revision"])
        }
    }

    @Test fun consentChangedRefreshIsNotFollowedByPostUntilAnotherExplicitClick() = runBlocking {
        Host().use { host ->
            host.ready()
            val notifications = AtomicInteger()
            host.model.confirmPlanning(authorized(), onCalendarConsentChanged = { notifications.incrementAndGet() })
            host.settled()
            withTimeout(5_000) { while (notifications.get() == 0) kotlinx.coroutines.yield() }
            assertEquals(1, host.posts.get())
            host.model.confirmPlanning(CalendarUiState(CalendarConsentFixtures.snapshot(), fresh = true))
            assertEquals(1, host.posts.get())
            host.responseCode = "synthetic_other_failure"
            host.responseStatus = 400
            val renewed = authorized().copy(data = authorized().data.copy(preferenceRevision = 10))
            host.model.confirmPlanning(renewed); host.settled()
            assertEquals(2, host.posts.get())
            assertEquals(listOf("9", "10"), host.bodies.map { it["calendar_preference_revision"] })
            assertEquals(1, notifications.get())
        }
    }
}
