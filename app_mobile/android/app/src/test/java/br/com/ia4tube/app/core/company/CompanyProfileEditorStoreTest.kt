package br.com.ia4tube.app.core.company

import android.app.Application
import org.robolectric.RuntimeEnvironment
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.feature.company_profile.CompanyProfileEditorStorage
import kotlinx.coroutines.runBlocking
import java.util.Base64
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class CompanyProfileEditorStoreTest {
    private val context: Application get() = RuntimeEnvironment.getApplication()
    @Before fun reset() { context.getSharedPreferences("ia4tube_company_profile", 0).edit().clear().commit() }

    @Test fun legacyDefaultsAndFirstOwnerKeepExistingData() {
        val store = CompanyProfileStore(context)
        assertEquals(CompanyProfile(), store.getProfile())
        store.saveProfile(CompanyProfile(nomeEmpresa = "Legado", whatsapp = "Contato"))
        store.prepareForAuthenticatedAccount("conta-a")
        assertEquals("Legado", store.getProfile().nomeEmpresa); assertEquals("", store.getProfile().facebook)
        assertFalse(store.editorPending())
    }
    @Test fun legacySaveCannotEraseNewOptionalLinksOrPendingMetadata() {
        val store = CompanyProfileStore(context)
        store.prepareForAuthenticatedAccount("conta-a")
        store.saveEditorProfile(CompanyProfile(nomeEmpresa = "Antes", facebook = "FB", outrosLinks = "Um\nDois"), true, true, false)
        store.saveProfile(CompanyProfile(nomeEmpresa = "Legado"))
        assertEquals("Legado", store.getProfile().nomeEmpresa)
        assertEquals("FB", store.getProfile().facebook); assertEquals("Um\nDois", store.getProfile().outrosLinks)
        assertTrue(store.editorPending()); assertTrue(store.editorUploadLogo())
    }
    @Test fun editorCanExplicitlyClearAllFieldsAndLogoFlags() {
        val store = CompanyProfileStore(context)
        store.saveEditorProfile(CompanyProfile(facebook = "FB", outrosLinks = "Link", logoUri = "file:///logo.png"), true, true, false)
        store.saveEditorProfile(CompanyProfile(), false, false, false)
        assertEquals(CompanyProfile(), store.getProfile())
        assertFalse(store.editorPending()); assertFalse(store.editorUploadLogo()); assertFalse(store.editorRemoveLogo())
    }
    @Test fun accountChangeClearsBothLegacyAndEditorSpecificData() {
        val store = CompanyProfileStore(context)
        store.prepareForAuthenticatedAccount("conta-a")
        store.saveEditorProfile(CompanyProfile(whatsapp = "Contato diferente do login", facebook = "A"), true, false, true)
        store.prepareForAuthenticatedAccount("conta-b")
        assertEquals(CompanyProfile(), store.getProfile())
        assertFalse(store.editorPending()); assertFalse(store.editorRemoveLogo())
    }
    @Test fun privateLogoCacheDeduplicatesIdenticalBytesWithinTheSameAccountOnly() = runBlocking {
        fun jwt(owner: String) = "header." + Base64.getUrlEncoder().withoutPadding()
            .encodeToString(("{\"whatsapp\":\"" + owner + "\"}").toByteArray()) + ".signature"
        var token = jwt("synthetic-profile-a")
        val storage = CompanyProfileEditorStorage(context, CompanyProfileStore(context)) { token }
        val logo = UploadFile("logo.png", "image/png", byteArrayOf(1, 2, 3))
        val first = storage.persistLogo(token, logo)
        assertEquals(first, storage.persistLogo(token, logo))
        token = jwt("synthetic-profile-b")
        assertNotEquals(first, storage.persistLogo(token, logo))
        assertFalse(first.contains(token))
    }
}
