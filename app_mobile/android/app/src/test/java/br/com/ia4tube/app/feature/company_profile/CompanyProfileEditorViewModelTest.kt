package br.com.ia4tube.app.feature.company_profile

import androidx.lifecycle.ViewModelStore
import br.com.ia4tube.app.core.company.CompanyProfile
import br.com.ia4tube.app.data.api.CompanyProfileBackend
import br.com.ia4tube.app.data.api.CompanyProfileSnapshot
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.UploadFile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CompanyProfileEditorViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val owners = ViewModelStore()
    private var token = "synthetic-a"
    private val cache = mutableMapOf<String, CompanyProfileEditorCache>()
    private val writes = mutableListOf<Pair<String, CompanyProfileEditorCache>>()
    private val persisted = mutableListOf<String>()
    private var models = 0
    private fun snapshot(profile: CompanyProfile = CompanyProfile(), logo: Boolean = false, updated: String? = "2026-10-30T00:00:00Z") =
        CompanyProfileSnapshot(profile, logo, updated)
    private class Fake : CompanyProfileBackend {
        var reads = 0; var saves = 0; var logos = 0
        var readAction: suspend () -> ApiResult<CompanyProfileSnapshot> =
            { ApiResult.Success(CompanyProfileSnapshot(CompanyProfile(), false, null)) }
        var saveAction: suspend (CompanyProfile, UploadFile?, Boolean) -> ApiResult<CompanyProfileSnapshot> =
            { profile, logo, _ -> ApiResult.Success(CompanyProfileSnapshot(profile, logo != null, "2026-10-30T00:00:00Z")) }
        var logoAction: suspend () -> ApiResult<UploadFile> = { ApiResult.Failure("synthetic-offline") }
        override suspend fun read(token: String): ApiResult<CompanyProfileSnapshot> { reads++; return readAction() }
        override suspend fun save(token: String, profile: CompanyProfile, logo: UploadFile?, removeLogo: Boolean): ApiResult<CompanyProfileSnapshot> {
            saves++; return saveAction(profile, logo, removeLogo)
        }
        override suspend fun logo(token: String): ApiResult<UploadFile> { logos++; return logoAction() }
    }
    @Before fun before() { Dispatchers.setMain(dispatcher) }
    @After fun after() { owners.clear(); dispatcher.scheduler.runCurrent(); Dispatchers.resetMain() }
    private fun model(fake: Fake) = CompanyProfileEditorViewModel(fake, { token },
        { cache[it] ?: CompanyProfileEditorCache() },
        { owner, value -> check(owner == token); writes += owner to value; cache[owner] = value },
        { owner, _ -> persisted += owner; "file:///private/" + owner + "/logo.png" },
        { ApiResult.Success(UploadFile("logo.png", "image/png", byteArrayOf(1))) }
    ).also { owners.put("profile-" + models++, it) }

    @Test fun constructionDoesNothingAndOpenDeduplicatesLifecycleReads() = runTest(dispatcher) {
        val fake = Fake(); val vm = model(fake)
        assertEquals(0, fake.reads)
        vm.open(); vm.open(); runCurrent(); vm.open(); runCurrent()
        assertEquals(1, fake.reads); assertEquals(0, fake.saves); assertEquals(0, fake.logos)
    }
    @Test fun emptyRemoteProfilePreservesLegacyLocalDataUntilSave() = runTest(dispatcher) {
        val legacy = CompanyProfile(nomeEmpresa = "Local", historia = "Dados locais", logoUri = "file:///local.png")
        cache[token] = CompanyProfileEditorCache(legacy)
        val vm = model(Fake()); vm.open(); runCurrent()
        assertEquals(legacy, vm.state.value.profile); assertTrue(writes.isEmpty())
    }
    @Test fun delayedGetCannotOverwriteTypingOrDownloadItsLogo() = runTest(dispatcher) {
        val gate = CompletableDeferred<ApiResult<CompanyProfileSnapshot>>()
        val fake = Fake().also { it.readAction = { gate.await() } }
        val vm = model(fake); vm.open(); runCurrent()
        vm.edit { it.copy(nomeEmpresa = "Rascunho") }
        gate.complete(ApiResult.Success(snapshot(CompanyProfile(nomeEmpresa = "Remoto"), logo = true))); runCurrent()
        assertEquals("Rascunho", vm.state.value.profile.nomeEmpresa); assertEquals(0, fake.logos); assertTrue(writes.isEmpty())
    }
    @Test fun failedSaveKeepsAnEditableDurableDraftAndSameDraftCanRetry() = runTest(dispatcher) {
        val fake = Fake(); val vm = model(fake); vm.open(); runCurrent()
        vm.edit { it.copy(historia = "Linha 1\nLinha 2", facebook = "FB") }
        fake.saveAction = { _, _, _ -> ApiResult.Failure("synthetic-offline", 503) }
        vm.save(); runCurrent()
        assertTrue(vm.state.value.dirty); assertFalse(vm.state.value.saving)
        assertEquals("FB", cache[token]?.profile?.facebook); assertTrue(cache[token]!!.pending)
        assertNotNull(vm.state.value.message)
        fake.saveAction = { profile, _, _ -> ApiResult.Success(snapshot(profile)) }
        vm.save(); runCurrent()
        assertFalse(vm.state.value.dirty); assertFalse(cache[token]!!.pending); assertEquals(2, fake.saves)
    }
    @Test fun allEmptyFieldsCanBeSavedWithoutNameIndustryOrPhoneValidation() = runTest(dispatcher) {
        val fake = Fake(); val vm = model(fake); vm.open(); runCurrent(); vm.save(); runCurrent()
        assertEquals(1, fake.saves); assertEquals(CompanyProfile(), cache[token]?.profile); assertFalse(vm.state.value.dirty)
    }
    @Test fun firstSaveAlsoCopiesAndUploadsTheLegacyLogoWhenNoRemoteProfileExists() = runTest(dispatcher) {
        cache[token] = CompanyProfileEditorCache(CompanyProfile(logoUri = "content://synthetic-legacy/logo"))
        val fake = Fake().also { it.saveAction = { profile, logo, remove ->
            assertNotNull(logo); assertFalse(remove)
            assertTrue(profile.logoUri.startsWith("file:///private/"))
            ApiResult.Success(snapshot(profile, logo = true))
        } }
        val vm = model(fake); vm.open(); runCurrent(); vm.save(); runCurrent()
        assertEquals(listOf(token), persisted)
        assertTrue(cache[token]!!.profile.logoUri.startsWith("file:///private/")); assertFalse(cache[token]!!.pending)
    }
    @Test fun forcedRefreshInvalidatesAnOlderReadEvenIfCancellationIsIgnored() = runTest(dispatcher) {
        val gate = CompletableDeferred<ApiResult<CompanyProfileSnapshot>>()
        val fake = Fake().also { it.readAction = { withContext(NonCancellable) { gate.await() } } }
        val vm = model(fake); vm.open(); runCurrent()
        fake.readAction = { ApiResult.Success(snapshot(CompanyProfile(nomeEmpresa = "Novo"))) }
        vm.open(force = true); runCurrent()
        gate.complete(ApiResult.Success(snapshot(CompanyProfile(nomeEmpresa = "Antigo")))); runCurrent()
        assertEquals("Novo", vm.state.value.profile.nomeEmpresa); assertFalse(vm.state.value.loading)
    }
    @Test fun saveBeforeGetFinishesUploadsLocalLogoAndLateNullCannotRearmTheUpload() = runTest(dispatcher) {
        cache[token] = CompanyProfileEditorCache(CompanyProfile(logoUri = "content://synthetic-legacy/logo"))
        val gate = CompletableDeferred<ApiResult<CompanyProfileSnapshot>>()
        val uploads = mutableListOf<UploadFile?>()
        val fake = Fake().also {
            it.readAction = { withContext(NonCancellable) { gate.await() } }
            it.saveAction = { profile, logo, _ -> uploads += logo; ApiResult.Success(snapshot(profile, true)) }
        }
        val vm = model(fake); vm.open(); runCurrent()
        vm.save(); runCurrent()
        assertEquals(1, fake.saves); assertNotNull(uploads[0])
        assertTrue(cache[token]!!.profile.logoUri.startsWith("file:///private/"))
        gate.complete(ApiResult.Success(snapshot(updated = null))); runCurrent()
        vm.save(); runCurrent()
        assertEquals(2, fake.saves); assertNull(uploads[1])
    }
    @Test fun failedInitialGetStillPreservesAndUploadsTheLocalLogoOnSave() = runTest(dispatcher) {
        cache[token] = CompanyProfileEditorCache(CompanyProfile(logoUri = "content://synthetic-legacy/logo"))
        val fake = Fake().also {
            it.readAction = { ApiResult.Failure("synthetic-offline", 503) }
            it.saveAction = { profile, logo, _ -> assertNotNull(logo); ApiResult.Success(snapshot(profile, true)) }
        }
        val vm = model(fake); vm.open(); runCurrent(); vm.save(); runCurrent()
        assertEquals(1, fake.saves); assertTrue(cache[token]!!.profile.logoUri.startsWith("file:///private/"))
    }
    @Test fun repeatedSaveWhilePendingSendsOnlyOneMutation() = runTest(dispatcher) {
        val gate = CompletableDeferred<ApiResult<CompanyProfileSnapshot>>()
        val fake = Fake().also { it.saveAction = { _, _, _ -> gate.await() } }
        val vm = model(fake); vm.open(); runCurrent(); vm.save(); vm.save(); runCurrent()
        assertEquals(1, fake.saves)
        gate.complete(ApiResult.Success(snapshot())); runCurrent()
    }
    @Test fun oldAccountGetEvenIgnoringCancellationCannotWriteNewAccountCache() = runTest(dispatcher) {
        val gate = CompletableDeferred<ApiResult<CompanyProfileSnapshot>>()
        val fake = Fake().also { it.readAction = { withContext(NonCancellable) { gate.await() } } }
        val vm = model(fake); vm.open(); runCurrent()
        token = "synthetic-b"; fake.readAction = { ApiResult.Success(snapshot(CompanyProfile(nomeEmpresa = "B"))) }
        vm.open(); runCurrent()
        gate.complete(ApiResult.Success(snapshot(CompanyProfile(nomeEmpresa = "A")))); runCurrent()
        assertEquals("B", vm.state.value.profile.nomeEmpresa); assertTrue(writes.all { it.first == "synthetic-b" })
    }
    @Test fun tokenChangedDuringSavePreventsLateSuccessOrLogoFromBeingCached() = runTest(dispatcher) {
        val gate = CompletableDeferred<ApiResult<CompanyProfileSnapshot>>()
        val fake = Fake().also { it.saveAction = { _, _, _ -> withContext(NonCancellable) { gate.await() } } }
        val vm = model(fake); vm.open(); runCurrent(); vm.save(); runCurrent()
        writes.clear(); token = "synthetic-b"; vm.open(); runCurrent()
        gate.complete(ApiResult.Success(snapshot(CompanyProfile(nomeEmpresa = "A"), logo = true))); runCurrent()
        assertTrue(writes.isEmpty()); assertTrue(persisted.isEmpty()); assertEquals(0, fake.logos)
    }
    @Test fun logoDownloadedOnOpeningIsCopiedLocallyAndReusedWithoutPublicUrl() = runTest(dispatcher) {
        val fake = Fake().also {
            it.readAction = { ApiResult.Success(snapshot(CompanyProfile(nomeEmpresa = "Remoto"), true)) }
            it.logoAction = { ApiResult.Success(UploadFile("logo.png", "image/png", byteArrayOf(1))) }
        }
        val vm = model(fake); vm.open(); runCurrent()
        assertEquals(1, fake.logos); assertEquals(listOf(token), persisted)
        assertEquals("file:///private/synthetic-a/logo.png", cache[token]?.profile?.logoUri)
    }
    @Test fun localLogoAndRemovalHaveExplicitIndependentFlags() = runTest(dispatcher) {
        val fake = Fake(); val vm = model(fake); vm.open(); runCurrent()
        vm.selectLogo { ApiResult.Success(UploadFile("chosen.png", "image/png", byteArrayOf(1))) }; runCurrent()
        assertTrue(vm.state.value.hasLogo)
        assertTrue(vm.keepDraft()); assertTrue(cache[token]!!.uploadLogo); assertFalse(cache[token]!!.removeLogo)
        vm.removeLogo(); assertTrue(vm.keepDraft())
        assertEquals("", cache[token]!!.profile.logoUri); assertFalse(cache[token]!!.uploadLogo); assertTrue(cache[token]!!.removeLogo)
        fake.saveAction = { profile, logo, remove -> assertNull(logo); assertTrue(remove); ApiResult.Success(snapshot(profile)) }
        vm.save(); runCurrent(); assertFalse(cache[token]!!.pending)
    }
    @Test fun pendingDraftSurvivesReopeningWithoutRemoteOverwrite() = runTest(dispatcher) {
        cache[token] = CompanyProfileEditorCache(CompanyProfile(outrosLinks = "Rascunho"), pending = true)
        val fake = Fake().also { it.readAction = { ApiResult.Success(snapshot(CompanyProfile(outrosLinks = "Remoto"))) } }
        val vm = model(fake); vm.open(); runCurrent()
        assertEquals("Rascunho", vm.state.value.profile.outrosLinks); assertTrue(vm.state.value.dirty)
    }
    @Test fun loggedOutOpeningNeverReadsBackendAnd401KeepsDraft() = runTest(dispatcher) {
        token = ""; val fake = Fake(); val vm = model(fake); vm.open(); runCurrent()
        assertEquals(0, fake.reads); assertTrue(vm.state.value.authRequired)
        token = "synthetic-a"; vm.open(); runCurrent(); vm.edit { it.copy(nomeEmpresa = "Local") }
        fake.saveAction = { _, _, _ -> ApiResult.Failure("Entre novamente", 401) }
        vm.save(); runCurrent(); assertTrue(vm.state.value.authRequired)
        assertEquals("Local", vm.state.value.profile.nomeEmpresa); assertTrue(cache[token]!!.pending)
    }
}
