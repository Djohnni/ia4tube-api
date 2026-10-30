package br.com.ia4tube.app.feature.company_profile

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import br.com.ia4tube.app.core.company.CompanyProfileStore
import br.com.ia4tube.app.core.upload.AndroidFileReader
import br.com.ia4tube.app.data.api.CompanyProfileApiClient
import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.data.repository.authenticatedAccountFromJwt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.UUID

internal class CompanyProfileEditorStorage(
    private val context: Context,
    private val store: CompanyProfileStore,
    private val currentToken: () -> String
) {
    private fun owner(token: String): String {
        check(token.isNotBlank() && currentToken() == token)
        return authenticatedAccountFromJwt(token).also { check(it.isNotBlank()) }
    }

    fun read(token: String): CompanyProfileEditorCache {
        store.prepareForAuthenticatedAccount(owner(token))
        return CompanyProfileEditorCache(store.getProfile(), store.editorPending(), store.editorUploadLogo(), store.editorRemoveLogo())
    }

    fun write(token: String, value: CompanyProfileEditorCache) {
        val account = owner(token)
        store.prepareForAuthenticatedAccount(account)
        check(currentToken() == token)
        store.saveEditorProfile(value.profile, value.pending, value.uploadLogo, value.removeLogo)
    }

    suspend fun persistLogo(token: String, file: UploadFile): String = withContext(Dispatchers.IO) {
        val account = owner(token)
        require(file.bytes.isNotEmpty() && file.bytes.size <= CompanyProfileApiClient.MAX_LOGO_BYTES)
        val extension = when (file.contentType) {
            "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/webp" -> "webp"
            else -> error("unsupported_logo")
        }
        val accountHash = MessageDigest.getInstance("SHA-256").digest(account.toByteArray()).joinToString("") { "%02x".format(it) }
        val directory = File(context.filesDir, "company_profile/" + accountHash)
        check(directory.mkdirs() || directory.isDirectory)
        val contentHash = MessageDigest.getInstance("SHA-256").digest(file.bytes).joinToString("") { "%02x".format(it) }
        val target = File(directory, contentHash + "." + extension)
        if (target.isFile && target.length() == file.bytes.size.toLong() &&
            target.readBytes().contentEquals(file.bytes)) {
            check(currentToken() == token)
            return@withContext Uri.fromFile(target).toString()
        }
        val temporary = File(directory, UUID.randomUUID().toString() + ".tmp")
        var published = false
        try {
            check(currentToken() == token)
            temporary.outputStream().use { it.write(file.bytes) }
            check(currentToken() == token)
            check(temporary.renameTo(target))
            published = true
            check(currentToken() == token)
            Uri.fromFile(target).toString()
        } catch (error: Exception) {
            if (published) target.delete()
            throw error
        } finally { temporary.delete() }
    }

    suspend fun readLocalLogo(uri: String) = AndroidFileReader(context).readUploadFile(Uri.parse(uri))
}

internal class CompanyProfileEditorViewModelFactory(
    private val context: Context,
    private val store: CompanyProfileStore,
    private val currentToken: () -> String
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        val storage = CompanyProfileEditorStorage(context.applicationContext, store, currentToken)
        @Suppress("UNCHECKED_CAST")
        return CompanyProfileEditorViewModel(CompanyProfileApiClient(), currentToken,
            storage::read, storage::write, storage::persistLogo, storage::readLocalLogo) as T
    }
}
