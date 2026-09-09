package br.com.ia4tube.app.core.art_cache

import android.content.Context
import android.graphics.BitmapFactory
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import br.com.ia4tube.app.core.session.SessionStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** This key is independent of the login key; no plaintext persistence fallback. */
internal class AndroidArtCacheCipher : ArtCacheCipher {
    @Synchronized private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        return generator.generateKey()
    }

    override fun encrypt(key: String, plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD("private-art-v1:$key".toByteArray())
        require(cipher.iv.size == 12)
        return cipher.iv + cipher.doFinal(plain)
    }

    override fun decrypt(key: String, sealed: ByteArray): ByteArray {
        require(sealed.size >= 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
        cipher.updateAAD("private-art-v1:$key".toByteArray())
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }

    private companion object { const val KEY_ALIAS = "ia4tube_private_art_cache_v1" }
}

internal object AndroidPrivateArts {
    private val changes = MutableStateFlow(0L)
    val sessionChanges = changes.asStateFlow()
    private var instance: Runtime? = null

    @Synchronized fun runtime(context: Context): Runtime = instance ?: Runtime(context.applicationContext).also { instance = it }

    @Synchronized fun invalidateSession(context: Context) {
        changes.value += 1L
        // Only the dedicated private cache is cleared. Never Downloads, shared pictures,
        // generated originals, session credentials or any other application directory.
        runCatching { runtime(context).disk.clear() }
    }

    class Runtime(context: Context) {
        private val session = SessionStore(context)
        val disk = PrivateArtDiskStore(File(context.cacheDir.canonicalFile, "private_art_v1"), AndroidArtCacheCipher())
        fun currentToken(): String = runCatching {
            session.getToken().takeIf(::unexpiredSessionToken).orEmpty()
        }.getOrDefault("")

        val repository = PrivateArtRepository(disk, ::currentToken, { changes.value }, validateImage = { bytes, type ->
            if (!hasCompleteImageEnvelope(bytes, type)) false
            else {
                val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                options.outWidth in 1..8192 && options.outHeight in 1..8192 &&
                    options.outWidth.toLong() * options.outHeight <= 32_000_000
            }
        })
    }
}

// Expiry is an extra local cache guard, not a replacement for server authentication.
internal fun unexpiredSessionToken(token: String, nowSeconds: Long = System.currentTimeMillis() / 1000): Boolean = runCatching {
    if (token.length > 16_384) return@runCatching false
    val parts = token.split('.')
    if (parts.size != 3 || parts.any { it.isBlank() }) return@runCatching false
    val claims = JSONObject(String(Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8))
    claims.getLong("exp") > nowSeconds
}.getOrDefault(false)
