package br.com.ia4tube.app.core.session

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("ia4tube_session", Context.MODE_PRIVATE)

    fun getToken(): String {
        val encryptedToken = preferences.getString(KEY_ENCRYPTED_TOKEN, "").orEmpty()
        val iv = preferences.getString(KEY_TOKEN_IV, "").orEmpty()
        if (encryptedToken.isNotBlank() && iv.isNotBlank()) {
            return decrypt(encryptedToken, iv)
        }

        val legacyToken = preferences.getString(KEY_TOKEN, "").orEmpty()
        if (legacyToken.isNotBlank()) {
            saveToken(legacyToken)
            preferences.edit().remove(KEY_TOKEN).apply()
        }
        return legacyToken
    }

    fun saveToken(token: String) {
        val encrypted = encrypt(token)
        preferences.edit()
            .putString(KEY_ENCRYPTED_TOKEN, encrypted.cipherText)
            .putString(KEY_TOKEN_IV, encrypted.iv)
            .remove(KEY_TOKEN)
            .apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun encrypt(value: String): EncryptedValue {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        val cipherBytes = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return EncryptedValue(
            cipherText = Base64.encodeToString(cipherBytes, Base64.NO_WRAP),
            iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        )
    }

    private fun decrypt(cipherText: String, iv: String): String {
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val gcmSpec = GCMParameterSpec(GCM_TAG_LENGTH_BITS, Base64.decode(iv, Base64.NO_WRAP))
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), gcmSpec)
            val plainBytes = cipher.doFinal(Base64.decode(cipherText, Base64.NO_WRAP))
            plainBytes.toString(Charsets.UTF_8)
        } catch (_: Exception) {
            ""
        }
    }

    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
        val parameterSpec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_SIZE_BITS)
            .build()

        keyGenerator.init(parameterSpec)
        return keyGenerator.generateKey()
    }

    private data class EncryptedValue(
        val cipherText: String,
        val iv: String
    )

    private companion object {
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val KEY_ALIAS = "ia4tube_session_token_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_SIZE_BITS = 256
        const val GCM_TAG_LENGTH_BITS = 128
        const val KEY_TOKEN = "token"
        const val KEY_ENCRYPTED_TOKEN = "encrypted_token"
        const val KEY_TOKEN_IV = "token_iv"
    }
}
